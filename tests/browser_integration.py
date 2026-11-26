"""Offline Playwright tests that mount the shipped userscript on arXiv listing fixtures.

Run `npm run build && python tests/browser_integration.py` with Playwright and
Chromium installed. CHROMIUM_BIN selects a particular local Chrome/Chromium.
"""

import gzip
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://arxiv.org/list/math/new"
FIXTURE = ROOT / "fixtures/arxiv-math-new.html"
BUNDLE = ROOT / "dist/arxiv-discovery.user.js"
DATE = "2026-11-26"
TEST_TOKEN = "offline-fixture-token-for-pairing-only-0001"

# The GM test double is restricted to this test origin. It persists the data
# through reloads in our disposable browser profile. Real GM storage is private
# to the userscript. No external connections or provider credentials are used.
GM_MOCK = r"""
(() => {
  const prefix = 'fixture-gm:';
  const menu = new Map();
  const listeners = new Map();
  const controls = {menu, requests: [], network: 'offline', responseHTML: ''};
  window.fixtureGM = controls;
  window.GM_getValue = (key, other) => {
    const raw = localStorage.getItem(prefix + key);
    return raw === null ? other : JSON.parse(raw);
  };
  window.GM_setValue = (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value));
  window.GM_deleteValue = key => localStorage.removeItem(prefix + key);
  window.GM_listValues = () => Object.keys(localStorage)
    .filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  window.GM_registerMenuCommand = (name, fn) => {menu.set(name, fn); return name;};
  window.GM_addValueChangeListener = (key, fn) => {
    const id = listeners.size + 1;
    const handler = event => {
      if (event.key === prefix + key) {
        fn(key, JSON.parse(event.oldValue), JSON.parse(event.newValue), true);
      }
    };
    listeners.set(id, handler);
    window.addEventListener('storage', handler);
    return id;
  };
  window.GM_removeValueChangeListener = id => {
    window.removeEventListener('storage', listeners.get(id)); listeners.delete(id);
  };
  window.GM_xmlhttpRequest = options => {
    const {url, method, data} = options;
    const body = data ? JSON.parse(data) : null;
    controls.requests.push({url, method, body});
    const reply = (status, responseText) => options.onload({
      status, responseText, finalUrl: url, responseHeaders: ''
    });
    const timer = setTimeout(() => {
      if (controls.network === 'page' && url.startsWith('https://arxiv.org/list/math/new?')) {
        reply(200, controls.responseHTML);
      } else if (controls.network === 'limited' && method === 'GET') {
        reply(429, 'Fixture rate limit');
      } else if (controls.network === 'ai-error' && method === 'POST') {
        reply(503, JSON.stringify({error: 'Fixture provider unavailable'}));
      } else if (controls.network === 'ai-answer' && method === 'POST') {
        const paper = body.paper;
        const version = paper.version ? 'v' + paper.version : '';
        reply(200, JSON.stringify({
          text: "Prerequisite definitions are fixture text. Literal <em>notation</em> stays text. A square is $x^2$.",
          source: {kind: 'abstract', url: 'https://arxiv.org/abs/' + paper.id + version,
                   note: 'Offline fixture response using only its abstract.'},
          usage: {inputTokens: 10, outputTokens: 12, estimatedCostUsd: 0}
        }));
      } else {
        options.onerror();
      }
    }, 0);
    return {abort() {clearTimeout(timer); options.onabort();}};
  };
})();
"""

# Playwright locators normally respect closed shadow boundaries. Only our own
# test hosts are opened. A separate startup test runs without this instrumentation.
OPEN_TEST_HOSTS = """
(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(options) {
    return attach.call(this, this.hasAttribute('data-arxiv-discovery')
      ? {...options, mode: 'open'} : options);
  };
})();
"""

CAPTURE_NATIVE = """
() => {
  const original = document.documentElement.outerHTML;
  const nodes = [...document.querySelectorAll('*')].map(node => [node, node.parentNode]);
  const rows = 'dl[id="articles"] > dt, dl[id="articles"] > dd';
  const attrs = [...document.querySelectorAll(rows)].map(node => node.getAttribute('hidden'));
  const typography = () => [...document.querySelectorAll('#dlpage h1, #dlpage dt a[title="Abstract"], #dlpage .list-title')]
    .slice(0, 12).map(node => {
      const style = getComputedStyle(node);
      return [style.fontFamily, style.fontSize, style.color, style.backgroundColor].join('|');
    }).join(';');
  const originalStyle = typography();
  window.fixtureNativeUnchanged = (ignoreFilter = false) => {
    const clone = document.documentElement.cloneNode(true);
    for (const addition of clone.querySelectorAll('[data-arxiv-discovery]')) addition.remove();
    if (ignoreFilter) {
      // Only mask a temporary change to the hidden attribute on existing paper
      // pairs. Everything else must still match the original markup.
      [...clone.querySelectorAll(rows)].forEach((node, i) => {
        if (attrs[i] === null) node.removeAttribute('hidden');
        else node.setAttribute('hidden', attrs[i]);
      });
    }
    return clone.outerHTML === original && typography() === originalStyle &&
      nodes.every(([node,parent]) => node.isConnected && node.parentNode === parent);
  };
}
"""

COMMANDS = {
    "Show": "Show arXiv Discovery", "Daily": "Daily selection", "All": "Show all papers",
    "Previous": "Previous daily selections", "Category": "Explore a category",
    "Bookmarks": "Bookmarks and reading", "Authors": "Followed researchers",
    "Interests": "Interests and training history", "Knowledge": "Knowledge and glossary",
    "Settings": "Discovery settings", "Original": "Original arXiv",
}


def row(number, category, *, first=False):
    paper_id = f"2611.{number:05}"
    title = (
        '<span class="fixture-word">Compactness</span> and literal '
        + html.escape("<em>notation</em>") if first else f"Fixture paper {number}"
    )
    return f"""
    <dt><a href="/abs/{paper_id}v1" title="Abstract">arXiv:{paper_id}v1</a>
      <a title="Download PDF" href="/pdf/{paper_id}v1">pdf</a></dt>
    <dd><div class="list-title"><span class="descriptor">Title:</span> {title}</div>
      <div class="list-authors"><a href="/search/math?searchtype=author&amp;query=Doe">Alex Doe</a></div>
      <div class="list-subjects"><span class="primary-subject">Category ({category})</span></div>
      <p class="mathjax">A finite sequence $x^2$ and a literal {html.escape('<section>example</section>')}.</p></dd>
    """


ROWS = [row(n, code, first=n == 1) for n, code in enumerate(
    ["math.LO", "math.LO", "math.GN", "math.GN", "math.FA", "math.FA"], start=1)]


def listing(rows, total=None, page_link=""):
    size = len(rows) if total is None else total
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body><main id="dlpage"><h1>Mathematics</h1>
    <h3>Showing new listings for Thursday, 26 November 2026</h3>
    <div class="paging">Total of {size} entries {page_link}</div>
    <dl id="articles"><h3>New submissions (showing {len(rows)} of {size} entries)</h3>
    {''.join(rows)}</dl></main></body></html>"""


def reference_fixture():
    if FIXTURE.is_file():
        return FIXTURE.read_text(encoding="utf-8")
    with gzip.open(FIXTURE.with_suffix(".html.gz"), "rt", encoding="utf-8") as source:
        return source.read()


def fixtures_only(document, url=BASE):
    """All requests are intercepted. arXiv's own fixture scripts never run."""
    def handler(route):
        if route.request.is_navigation_request() and route.request.url == url:
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=document,
                          headers={"Content-Security-Policy":
                                   "default-src 'none'; style-src 'unsafe-inline'; img-src data:; "
                                   "script-src 'none'; frame-src 'none'; object-src 'none'"})
        else:
            route.abort()
    return handler


def optional_browser_path(playwright):
    explicit = os.environ.get("CHROMIUM_BIN")
    if explicit:
        return explicit
    bundled = Path(playwright.chromium.executable_path)
    if bundled.is_file():
        return str(bundled)
    return shutil.which("chromium") or shutil.which("google-chrome")


class UserscriptBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bundle_bytes = BUNDLE.read_bytes()
        cls.bundle = bundle_bytes.decode("utf-8")
        print(f"Testing userscript SHA-256 {hashlib.sha256(bundle_bytes).hexdigest()}", file=sys.stderr)
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.launch = {"headless": True, "executable_path": optional_browser_path(cls.playwright)}
        cls.browser = cls.playwright.chromium.launch(**cls.launch)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block")
        self.addCleanup(self.context.close)
        self.errors = []
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.assertEqual(self.errors, [], "Uncaught browser exceptions")

    def prepare(self, document=None, *, open_shadows=True):
        self.context.route("**/*", fixtures_only(document or listing(ROWS)))
        self.context.add_init_script(script=GM_MOCK)
        if open_shadows:
            self.context.add_init_script(script=OPEN_TEST_HOSTS)
        self.page.goto(BASE, wait_until="networkidle")
        self.mount()

    def mount(self, *, additions=True):
        self.page.evaluate(CAPTURE_NATIVE)
        self.page.evaluate(self.bundle)
        self.page.wait_for_function("() => fixtureGM.menu.has('Show arXiv Discovery')")
        if additions:
            self.page.locator("#arxiv-discovery-dialogs").wait_for(state="attached")

    def reload_and_mount(self, *, additions=True):
        self.page.reload(wait_until="networkidle")
        self.mount(additions=additions)

    def close_dialog(self):
        dialog = self.page.locator("dialog[open]")
        if dialog.count():
            dialog.get_by_role("button", name=re.compile("^Close")).click()
            expect(dialog).to_have_count(0)

    def menu(self, action):
        # This callback is the boundary provided by a real Tampermonkey menu.
        self.page.evaluate("(name) => fixtureGM.menu.get(name)()", COMMANDS[action])

    def nav(self, section):
        self.close_dialog()
        self.menu(section)
        panel = self.page.get_by_role("dialog")
        expect(panel).to_be_visible()
        return panel

    @property
    def controls(self):
        return self.page.locator("#ad-listing-controls")

    @property
    def settings_button(self):
        return self.page.get_by_role("button", name="Discovery settings", exact=True)

    def open_page_settings(self):
        self.settings_button.click()
        panel = self.page.get_by_role("dialog", name="Discovery settings", exact=True)
        expect(panel).to_be_visible()
        return panel

    @property
    def native_rows(self):
        return self.page.locator('dl[id="articles"] > dd')

    @property
    def visible_rows(self):
        return self.page.locator('dl[id="articles"] > dd:visible')

    def paper_ids(self):
        return self.visible_rows.evaluate_all("""rows => rows.map(dd => {
          const a = dd.previousElementSibling.querySelector('a[title="Abstract"]');
          return new URL(a.href).pathname.slice(5).replace(/v[0-9]+$/, '');
        })""")

    def options(self):
        control = self.controls.get_by_text("Selection options", exact=True)
        if control.is_visible() and not control.evaluate("s => s.parentElement.open"):
            control.click()
        return self.controls

    def daily(self):
        self.close_dialog()
        self.menu("Daily")
        expect(self.controls).to_contain_text("papers reviewed")
        expect(self.page.locator("dialog[open]")).to_have_count(0)
        return self.controls

    def await_mode(self, mode):
        self.page.wait_for_function("""mode => {
          const records = GM_listValues().filter(k=>k.includes(':selections:')).map(k=>GM_getValue(k));
          const visible = [...document.querySelectorAll('dl[id="articles"] > dt')]
            .filter(dt => [dt,dt.nextElementSibling].every(node =>
              !node.closest('[hidden]') && node.checkVisibility({visibilityProperty:true})))
            .map(dt => new URL(dt.querySelector('a[title="Abstract"]').href).pathname.slice(5).replace(/v[0-9]+$/, ''));
          return records.some(r => r?.current?.mode === mode &&
              r.current.entries.length === visible.length && r.current.entries.every(e=>visible.includes(e.paperId)));
        }""", arg=mode)

    def pick_mode(self, panel, mode):
        # The userscript accepts trusted changes. Commit a native keyboard
        # choice, since Playwright's select_option() dispatches a synthetic event.
        picker = panel.get_by_label("Recommendation mode")
        index = picker.locator(f'option[value="{mode}"]').evaluate("option => option.index")
        picker.press("Alt+ArrowDown")
        self.page.keyboard.press("Home")
        for _ in range(index):
            self.page.keyboard.press("ArrowDown")
        self.page.keyboard.press("Enter")
        expect(picker).to_have_value(mode)
        expect(picker).not_to_have_attribute("aria-busy", "true")
        expect(picker).to_be_focused()

    def change_mode(self, mode):
        panel = self.open_page_settings()
        self.pick_mode(panel, mode)
        self.await_mode(mode)
        expect(panel).to_be_visible()
        self.close_dialog()

    def backup(self):
        panel = self.nav("Settings")
        with self.page.expect_download() as saved:
            panel.get_by_role("button", name="Export all data (JSON)", exact=True).click()
        data = Path(saved.value.path()).read_bytes()
        return data, json.loads(data)["state"]

    def configure_ai(self):
        panel = self.nav("Settings")
        self.page.once("dialog", lambda prompt: prompt.accept(TEST_TOKEN))
        panel.get_by_role("button", name="Pair / replace bridge token").click()
        panel.get_by_label("Model", exact=True).fill("fixture-model")
        panel.get_by_label("Enable on-demand AI").check()
        panel.get_by_label(re.compile("I authorize this selected provider")).check()
        panel.get_by_role("button", name="Save AI settings").click()
        expect(panel.locator(".notice[role=status]")).to_contain_text("saved")
        self.close_dialog()

    def select_word(self, locator, word):
        """Double-click the rendered word through native browser pointer input."""
        locator.scroll_into_view_if_needed()
        point = locator.evaluate("""(element, word) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const i = text.data.indexOf(word);
            if (i < 0) continue;
            const range = document.createRange();
            range.setStart(text, i); range.setEnd(text, i + word.length);
            const r = range.getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
          }
          throw new Error("Word missing from the rendered text: " + word);
        }""", word)
        self.page.mouse.dblclick(**point)

    def test_closed_shadow_boot(self):
        self.prepare(open_shadows=False)
        for host in (self.page.locator("#arxiv-discovery-dialogs"), self.native_rows.first.locator("[data-arxiv-discovery]")):
            self.assertTrue(host.evaluate("(host) => host.shadowRoot === null"))
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

    def test_closed_shadow_text_input_does_not_submit_keyboard_feedback(self):
        # Keep the native boundary closed so document keydown sees the host.
        self.context.add_init_script("""(() => {
          const original = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function(options) {
            const root = original.call(this, options);
            if (this.id === 'arxiv-discovery-dialogs') window.fixtureClosedDialog = root;
            return root;
          };
        })();""")
        self.prepare(open_shadows=False)
        self.menu("Knowledge")
        point = self.page.evaluate("""() => {
          const field=fixtureClosedDialog.querySelector('dialog input[placeholder]');
          field.scrollIntoView({block:'center'});
          const r=field.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};
        }""")
        self.page.mouse.click(**point)
        self.assertEqual(self.page.evaluate("fixtureClosedDialog.activeElement.tagName"), "INPUT")
        self.page.keyboard.press("Alt+l")
        self.page.keyboard.type("finite sequences")
        self.page.keyboard.press("Tab")
        self.page.keyboard.press("Escape")
        self.assertEqual(self.page.evaluate("GM_listValues().filter(k => k.includes(':events:'))"), [])

    def test_full_reference_inline_actions_native_filter_and_menu_restoration(self):
        self.prepare(reference_fixture())
        expect(self.native_rows).to_have_count(701)
        expect(self.visible_rows).to_have_count(701)
        expect(self.native_rows.get_by_role("group", name="Paper tools", exact=True)).to_have_count(701)
        expect(self.page.locator("#ad-listing-controls, article.card, dialog[open]")).to_have_count(0)
        expect(self.settings_button).to_be_visible()
        for row in (self.native_rows.first, self.native_rows.last):
            row.scroll_into_view_if_needed()
            for name in ("Like", "Dislike", "Bookmark", "Mark as read", "AI overview"):
                expect(row.get_by_role("button", name=name, exact=True)).to_be_visible()
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.assertTrue(self.page.evaluate("""() => [...document.querySelectorAll('dl[id="articles"] > dd')]
          .every(dd => dd.lastElementChild?.hasAttribute('data-arxiv-discovery'))"""))
        counts = self.page.evaluate("""() => {
          const papers = GM_listValues().filter(k => k.includes(':papers:')).map(k => GM_getValue(k));
          return {sections:Object.fromEntries(['new','cross','replacement'].map(
            s => [s,papers.filter(p => p.section === s).length])), dates:[...new Set(papers.map(p=>p.announcementDate))]};
        }""")
        self.assertEqual(counts, {"sections": {"new": 379, "cross": 61, "replacement": 261}, "dates": [DATE]})
        original = self.paper_ids()
        first = self.native_rows.first
        first.get_by_text("More tools", exact=True).click()
        first.get_by_role("button", name="Daily selection", exact=True).click()
        self.await_mode("random")
        selected = self.paper_ids()
        snapshot = self.page.evaluate("""() => GM_listValues().filter(k=>k.includes(':selections:'))
          .map(k=>GM_getValue(k)).find(r=>r.current.mode==='random').current""")
        eligible = self.page.evaluate("""() => GM_listValues().filter(k=>k.includes(':papers:'))
          .map(k=>GM_getValue(k)).filter(p=>p.section==='new')""")
        counts = {r["category"]: sum(r["category"] in p["categories"] for p in eligible)
                  for r in snapshot["categoryDistribution"]}
        expected_target = sum(math.isqrt(n - 1) + 1 for n in counts.values() if n)
        self.assertEqual(snapshot["targetSize"], expected_target)
        self.assertEqual(snapshot["shortfall"], 0)
        self.assertEqual(len(selected), expected_target)
        self.assertGreater(len(selected), 32)
        self.assertEqual(len(selected), len(set(selected)))
        self.assertEqual(selected, [pid for pid in original if pid in selected])
        self.assertEqual(self.visible_rows.count(), self.page.locator('dl[id="articles"] > dt:visible').count())
        expect(self.controls).to_contain_text(f"0 / {expected_target}")
        expect(self.page.locator("dialog[open], article.card")).to_have_count(0)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged(true)"))
        self.controls.get_by_role("button", name="Show all papers", exact=True).click()
        expect(self.visible_rows).to_have_count(701)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.menu("Original")
        expect(self.page.locator("[data-arxiv-discovery]")).to_have_count(0)
        expect(self.settings_button).to_have_count(0)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.reload_and_mount(additions=False)
        expect(self.page.locator("[data-arxiv-discovery]")).to_have_count(0)
        self.menu("All")
        expect(self.settings_button).to_have_count(0)
        self.nav("Bookmarks")
        self.close_dialog()
        expect(self.settings_button).to_have_count(0)
        expect(self.native_rows.locator("[data-arxiv-discovery]")).to_have_count(0)
        self.menu("Show")
        expect(self.settings_button).to_be_visible()
        self.daily()
        self.await_mode("random")
        self.assertEqual(self.paper_ids(), selected)
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

    def test_original_row_attributes_survive_empty_selection_and_hide(self):
        hidden_row = ROWS[0].replace("<dt>", '<dt hidden="until-found" data-original="before">').replace(
            "<dd>", '<dd hidden="" style="margin-left: 3em">')
        self.prepare(listing([hidden_row, *ROWS[1:]]))
        self.daily()
        self.change_mode("subscriptions")
        expect(self.visible_rows).to_have_count(0)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged(true)"))
        self.menu("All")
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.daily()
        self.menu("Original")
        expect(self.page.locator("[data-arxiv-discovery]")).to_have_count(0)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.assertEqual(self.page.locator('dl[id="articles"] > dt').first.get_attribute("hidden"), "until-found")
        self.assertEqual(self.native_rows.first.get_attribute("hidden"), "")

    def test_settings_disables_native_filter_actions_and_shortcuts_until_reenabled(self):
        self.prepare()
        original = self.paper_ids()
        self.daily()
        expect(self.visible_rows).to_have_count(6)
        panel = self.open_page_settings()
        toggle = panel.get_by_label("Enable paper tools")
        toggle.focus()
        self.page.keyboard.press("Space")
        expect(toggle).not_to_be_checked()
        expect(toggle).not_to_have_attribute("aria-busy", "true")
        expect(toggle).to_be_focused()
        expect(panel.get_by_role("button", name="Show daily selection")).to_be_disabled()
        self.close_dialog()

        expect(self.settings_button).to_be_visible()
        expect(self.controls).to_have_count(0)
        expect(self.native_rows.locator("[data-arxiv-discovery]")).to_have_count(0)
        self.assertEqual(self.paper_ids(), original)
        self.page.locator('dl[id="articles"] > dt a[title="Abstract"]').first.focus()
        self.page.keyboard.press("Alt+l")
        self.select_word(self.native_rows.first.locator(".fixture-word"), "Compactness")
        expect(self.page.get_by_role("button", name="Explain selection")).to_have_count(0)
        self.assertEqual(self.page.evaluate("GM_listValues().filter(k => k.includes(':events:'))"), [])
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))

        self.nav("Bookmarks")
        self.close_dialog()
        panel = self.open_page_settings()
        expect(panel.get_by_label("Enable paper tools")).not_to_be_checked()
        self.pick_mode(panel, "subscriptions")
        self.close_dialog()
        expect(self.native_rows.locator("[data-arxiv-discovery]")).to_have_count(0)
        self.reload_and_mount()
        expect(self.native_rows.locator("[data-arxiv-discovery]")).to_have_count(0)
        panel = self.open_page_settings()
        toggle = panel.get_by_label("Enable paper tools")
        expect(toggle).not_to_be_checked()
        expect(panel.get_by_label("Recommendation mode")).to_have_value("subscriptions")
        toggle.check()
        self.close_dialog()

        expect(self.native_rows.get_by_role("button", name="Bookmark", exact=True)).to_have_count(len(ROWS))
        self.assertEqual(self.paper_ids(), original)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.open_page_settings().get_by_role("button", name="Show daily selection", exact=True).click()
        self.await_mode("subscriptions")
        expect(self.visible_rows).to_have_count(0)

    def test_modes_replacement_restore_and_history_survive_refresh(self):
        # Three eligible papers per category leave one unused replacement after
        # the adaptive quota of two is filled.
        expanded = [*ROWS, row(7, "math.LO"), row(8, "math.GN"), row(9, "math.FA")]
        self.prepare(listing(expanded))
        self.daily()
        initial = self.paper_ids()
        self.assertEqual(len(set(initial)), 6)
        self.assertEqual(self.visible_rows.count(), 6)
        self.visible_rows.first.locator(".selection-note").get_by_role(
            "button", name="Replace this paper", exact=True).click()
        self.page.wait_for_function("""id => ![...document.querySelectorAll('dl[id="articles"] > dt')]
          .some(dt => dt.getClientRects().length &&
            dt.querySelector('a[title="Abstract"]').href.split('/').pop().replace(/v[0-9]+$/,'') === id)""", arg=initial[0])
        replacement = self.paper_ids()
        self.assertEqual(len(set(replacement)), 6)
        self.assertEqual(len(set(initial) ^ set(replacement)), 2)
        self.options().get_by_role("button", name="Restore original selection").click()
        self.page.wait_for_function("""expected => {
          const visible = [...document.querySelectorAll('dl[id="articles"] > dt:not([hidden])')]
            .map(dt=>dt.querySelector('a[title="Abstract"]').href.split('/').pop().replace(/v[0-9]+$/,''));
          return JSON.stringify(visible)===JSON.stringify(expected);
        }""", arg=initial)
        self.assertEqual(self.paper_ids(), initial)
        # Consecutive arrows operate on the replacement selector after a daily
        # redraw. Closing the options or dropping focus would lose the next key.
        picker = self.options().get_by_label("Recommendation mode")
        picker.focus()
        for mode in ("balanced", "personalized"):
            self.page.keyboard.press("ArrowDown")
            self.await_mode(mode)
            expect(picker).to_have_value(mode)
            expect(picker).to_be_visible()
            expect(picker).to_be_focused()
        for mode in ("discovery", "subscriptions"):
            self.change_mode(mode)
            ids = self.paper_ids()
            self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(self.paper_ids(), [])
        self.change_mode("random")
        self.assertEqual(self.paper_ids(), initial)
        self.reload_and_mount()
        self.daily()
        self.assertEqual(self.paper_ids(), initial)
        self.options().get_by_role("button", name="Regenerate daily selection").click()
        panel = self.nav("Previous")
        expect(panel).to_contain_text("saved revisions")
        key = next(o.get_attribute("value") for o in panel.get_by_label("Publication and mode").locator("option").all()
                   if "random" in o.inner_text())
        panel.get_by_label("Publication and mode").select_option(key)
        panel.get_by_label("Saved version").select_option("original")
        history_ids = panel.locator('a[href*="/abs/"]').evaluate_all("""links =>
          links.map(a => new URL(a.href).pathname.slice(5).replace(/v[0-9]+$/, ''))""")
        self.assertEqual(set(history_ids), set(initial))
        expect(panel.locator("article.card")).to_have_count(0)
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

    def test_adaptive_distribution_matches_uneven_categories_and_count_changes_keep_the_same_draw(self):
        codes = ["math.LO"] * 9 + ["math.GN"] * 4 + ["math.FA"]
        self.prepare(listing([row(i, code) for i, code in enumerate(codes, 1)]))
        panel = self.open_page_settings()
        expect(panel.get_by_label("Personalized selection size", exact=True)).to_have_value("50")
        expect(panel.get_by_label("Balanced-mode random exploration (%)", exact=True)).to_have_value("25")
        self.daily()
        self.assertEqual(len(self.paper_ids()), 6)
        pinned = self.paper_ids()
        expect(self.controls).to_contain_text("Automatically calculated daily target: 6 papers · Selected: 6 · Shortfall: 0")
        expect(self.controls).to_contain_text("3 of 3 eligible categories represented")
        self.controls.get_by_text("Category distribution", exact=True).click()
        rows = self.controls.locator(".category-distribution tbody tr")
        expect(rows).to_have_count(32)
        for code, expected in {"math.LO": ["9", "3", "3"], "math.GN": ["4", "2", "2"], "math.FA": ["1", "1", "1"]}.items():
            data = self.controls.locator(f'.category-distribution tr[data-category="{code}"] td').all_text_contents()
            self.assertEqual(data[:3], expected)
            self.assertEqual(data[3], "Quota fulfilled.")
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged(true)"))
        before = self.page.evaluate("""() => GM_listValues().filter(k=>k.includes(':selections:'))
          .map(k=>[k,GM_getValue(k)])""")
        panel = self.open_page_settings()
        panel.get_by_label("Personalized selection size", exact=True).fill("200")
        panel.get_by_role("button", name="Save sampling settings", exact=True).click()
        expect(panel).to_contain_text("Sampling settings saved")
        self.daily()
        self.assertEqual(self.paper_ids(), pinned)
        after = self.page.evaluate("""() => GM_listValues().filter(k=>k.includes(':selections:'))
          .map(k=>[k,GM_getValue(k)])""")
        self.assertEqual(after, before)

    def test_cross_list_shortfall_is_visible_and_distribution_table_stays_within_mobile_viewport(self):
        overlap = [row(i, "math.LO").replace("Category (math.LO)</span>",
                   "Category (math.LO)</span>; General Topology (math.GN); Functional Analysis (math.FA)")
                   for i in (1, 2)]
        self.prepare(listing(overlap))
        self.daily()
        self.assertEqual(len(self.paper_ids()), 2)
        self.assertEqual(len(set(self.paper_ids())), 2)
        expect(self.controls).to_contain_text("Automatically calculated daily target: 6 papers · Selected: 2 · Shortfall: 4")
        expect(self.controls).to_contain_text("2 of 3 eligible categories represented")
        expect(self.controls).to_contain_text("cross-listed papers cannot be selected twice")
        self.controls.get_by_text("Category distribution", exact=True).click()
        total = 0
        for code in ("math.LO", "math.GN", "math.FA"):
            values = self.controls.locator(f'.category-distribution tr[data-category="{code}"] td').all_text_contents()
            self.assertEqual(values[:2], ["2", "2"])
            total += int(values[2])
            self.assertTrue(values[3])
            self.assertNotEqual(values[3], "Quota fulfilled.")
        self.assertEqual(total, 2)
        self.page.set_viewport_size({"width": 390, "height": 844})
        table = self.controls.locator(".category-distribution .table-wrap")
        self.assertTrue(table.evaluate("node => node.scrollWidth > node.clientWidth"))
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged(true)"))

    def test_legacy_selection_stays_pinned_until_explicit_regeneration_and_original_remains_restorable(self):
        self.prepare()
        key = "2026-11-26|random|new|originals|32|math"
        entries = [{"paperId": f"2611.{n:05}", "category": code, "reason": "Saved original draw.", "probability": 0.5}
                   for n, code in ((1, "math.LO"), (3, "math.GN"), (5, "math.FA"))]
        legacy = {"mode": "random", "date": DATE, "seed": "legacy-seed", "entries": entries, "missing": []}
        saved = {"original": legacy, "current": legacy, "revisions": [], "createdAt": DATE + "T00:00:00Z"}
        self.page.evaluate("([key,value]) => GM_setValue('arxiv-discovery:v1:selections:'+key,value)", [key, saved])
        self.reload_and_mount()
        self.daily()
        self.assertEqual(self.paper_ids(), [e["paperId"] for e in entries])
        expect(self.controls).to_contain_text("predates category-distribution snapshots")
        expect(self.controls.locator(".category-distribution")).to_have_count(0)
        panel = self.open_page_settings()
        expect(panel.get_by_label("Personalized selection size", exact=True)).to_have_value("50")
        panel.get_by_label("Personalized selection size", exact=True).fill("200")
        panel.get_by_role("button", name="Save sampling settings", exact=True).click()
        expect(panel).to_contain_text("Sampling settings saved")
        self.daily()
        self.assertEqual(self.paper_ids(), [e["paperId"] for e in entries])
        record = self.page.evaluate("key => GM_getValue('arxiv-discovery:v1:selections:'+key)", key)
        self.assertEqual(record, saved)
        self.options().get_by_role("button", name="Regenerate daily selection", exact=True).click()
        expect(self.visible_rows).to_have_count(6)
        expect(self.controls).to_contain_text("Automatically calculated daily target: 6 papers")
        updated = self.page.evaluate("key => GM_getValue('arxiv-discovery:v1:selections:'+key)", key)
        self.assertEqual(updated["original"], legacy)
        self.assertEqual(updated["revisions"], [legacy])
        self.assertEqual(updated["current"]["samplingVersion"], 2)
        self.options().get_by_role("button", name="Restore original selection", exact=True).click()
        expect(self.visible_rows).to_have_count(3)
        expect(self.controls).to_contain_text("predates category-distribution snapshots")
        self.assertEqual(self.paper_ids(), [e["paperId"] for e in entries])

    def test_personalized_settings_accept_1_to_200_and_default_to_50(self):
        self.prepare(listing([row(i, "math.CA") for i in range(1, 206)]))
        panel = self.open_page_settings()
        expect(panel.get_by_label("Personalized selection size", exact=True)).to_have_value("50")
        expect(panel.get_by_label("Personalized selection size", exact=True)).to_have_attribute("max", "200")
        self.pick_mode(panel, "personalized")
        panel.get_by_role("button", name="Show daily selection", exact=True).click()
        self.await_mode("personalized")
        expect(self.visible_rows).to_have_count(50)
        expect(self.controls.locator(".category-distribution")).to_have_count(0)
        for count in (200, 1):
            panel = self.open_page_settings()
            panel.get_by_label("Personalized selection size", exact=True).fill(str(count))
            panel.get_by_role("button", name="Save sampling settings", exact=True).click()
            expect(panel).to_contain_text("Sampling settings saved")
            self.daily()
            expect(self.visible_rows).to_have_count(count)
            self.assertEqual(len(set(self.paper_ids())), count)
        panel = self.open_page_settings()
        panel.get_by_label("Personalized selection size", exact=True).fill("201")
        panel.get_by_role("button", name="Save sampling settings", exact=True).click()
        expect(panel).to_contain_text("Use 0–100% exploration and 1–200 papers")
        self.assertEqual(self.page.evaluate("GM_getValue('arxiv-discovery:v1:settings').personalizedCount"), 1)

    def test_daily_keyboard_navigation_background_and_category_browsing(self):
        self.prepare()
        self.daily()
        ids = self.paper_ids()
        second = self.visible_rows.nth(1)
        self.page.locator('dl[id="articles"] > dt:visible a[title="Abstract"]').first.focus()
        self.page.keyboard.press("Alt+j")
        focused_id = """() => {
          const row = document.activeElement?.closest('dt,dd');
          const head = row?.tagName === 'DD' ? row.previousElementSibling : row;
          return head?.querySelector('a[title="Abstract"]')?.href.split('/').pop().replace(/v[0-9]+$/, '');
        }"""
        self.assertEqual(self.page.evaluate(focused_id), ids[1])
        self.page.keyboard.press("Alt+l")
        expect(second.get_by_role("button", name="Like", exact=True)).to_have_attribute("aria-pressed", "true")
        self.page.keyboard.press("Alt+r")
        expect(second.get_by_role("button", name="Read", exact=True)).to_be_visible()
        self.page.keyboard.press("Alt+r")
        expect(second.get_by_role("button", name="Mark as read", exact=True)).to_be_visible()
        self.page.keyboard.press("Alt+k")
        self.assertEqual(self.page.evaluate(focused_id), ids[0])
        second.get_by_role("button", name="Need background").click()
        expect(second.get_by_role("button", name="Need background")).to_have_attribute("aria-pressed", "true")
        expect(self.nav("Interests")).to_contain_text("0 active interest examples")
        self.close_dialog()
        self.menu("Category")
        self.controls.get_by_label("Category", exact=True).select_option("math.LO")
        expect(self.visible_rows).to_have_count(2)
        self.controls.get_by_label("Category", exact=True).select_option("math.GM")
        expect(self.visible_rows).to_have_count(0)
        expect(self.page.locator("article.card")).to_have_count(0)
        self.menu("All")
        expect(self.visible_rows).to_have_count(len(ROWS))

    def test_feedback_revision_exclusions_reset_restore_and_permanent_deletion(self):
        self.prepare()
        self.daily()
        card = self.visible_rows.first
        paper = self.paper_ids()[0]
        card.get_by_role("button", name="Like", exact=True).click()
        expect(card.get_by_role("button", name="Like", exact=True)).to_have_attribute("aria-pressed", "true")
        card.get_by_role("button", name="Dislike", exact=True).click()
        expect(card.get_by_role("button", name="Dislike", exact=True)).to_have_attribute("aria-pressed", "true")
        card.get_by_role("button", name="Bookmark", exact=True).click()
        card.get_by_role("button", name="Mark as read", exact=True).click()
        expect(self.controls).to_contain_text("1 / 6")
        panel = self.nav("Knowledge")
        panel.get_by_label("Topic", exact=True).fill("sequences")
        panel.get_by_label("Knowledge level").select_option("Advanced")
        panel.get_by_role("button", name="Add or update topic").click()
        expect(panel.get_by_role("cell", name="sequences", exact=True)).to_be_visible()
        panel = self.nav("Interests")
        expect(panel).to_contain_text("1 active interest examples")
        expect(panel.get_by_role("cell", name="dislike", exact=True)).to_be_visible()
        panel.get_by_role("button", name="Exclude event").click()
        expect(panel).to_contain_text("0 active interest examples")
        panel.get_by_role("button", name="Include event").click()
        expect(panel).to_contain_text("1 active interest examples")
        panel.get_by_label("Training history window").select_option("none")
        panel.get_by_role("button", name="Apply training window").click()
        expect(panel).to_contain_text("0 active interest examples")
        panel.get_by_role("button", name="Restore all historical interests").click()
        expect(panel).to_contain_text("1 active interest examples")
        self.page.once("dialog", lambda prompt: prompt.accept())
        panel.get_by_role("button", name="Reset interests", exact=True).click()
        expect(panel).to_contain_text("0 active interest examples")
        _, state = self.backup()
        events = [e for e in state["events"] if e["paperId"] == paper]
        self.assertEqual([e["value"] for e in events], ["like", "dislike"])
        self.assertEqual(events[1]["revisionOf"], events[0]["eventId"])
        self.assertIn(paper, state["bookmarks"])
        self.assertIn(paper, state["reading"])
        self.assertEqual(state["knowledge"]["sequences"]["level"], "Advanced")
        saved = self.nav("Bookmarks")
        expect(saved.locator("article.card")).to_have_count(0)
        saved.get_by_role("button", name="Show in listing").click()
        expect(self.visible_rows).to_have_count(len(ROWS))
        focused = self.page.evaluate("document.activeElement.href")
        self.assertRegex(focused, rf"/abs/{re.escape(paper)}(v1)?$")
        panel = self.nav("Interests")
        panel.get_by_role("button", name="Restore all historical interests").click()
        expect(panel).to_contain_text("1 active interest examples")
        self.page.once("dialog", lambda prompt: prompt.accept())
        panel.get_by_role("button", name="Delete permanently").click()
        expect(panel).to_contain_text("No feedback yet")
        _, state = self.backup()
        self.assertFalse(state["events"])
        self.assertIn(paper, state["bookmarks"])

    def test_complete_deletion_keeps_current_page_usable_and_new_bookmark_durable(self):
        self.prepare()

        first = self.native_rows.first
        first.get_by_role("button", name="Like", exact=True).click()
        first.get_by_role("button", name="Bookmark", exact=True).click()
        expect(first.get_by_role("button", name="Bookmarked")).to_be_visible()
        panel = self.nav("Settings")
        self.page.once("dialog", lambda prompt: prompt.accept())
        panel.get_by_role("button", name="Delete all local data").click()
        expect(panel).to_contain_text("All saved Discovery data has been deleted")
        self.close_dialog()

        first = self.native_rows.first
        expect(first.get_by_role("button", name="Bookmark", exact=True)).to_be_visible()
        expect(first.get_by_role("button", name="Like", exact=True)).not_to_have_attribute(
            "aria-pressed", "true")
        second = self.native_rows.nth(1)
        expect(second.get_by_role("button", name="Bookmark", exact=True)).to_be_visible()
        _, cleared = self.backup()
        for collection in ("bookmarks", "events", "papers", "selections"):
            self.assertFalse(cleared[collection], collection)

        self.daily()
        self.assertEqual(len(self.paper_ids()), 6)
        self.menu("All")
        second.get_by_role("button", name="Bookmark", exact=True).click()
        expect(second.get_by_role("button", name="Bookmarked")).to_be_visible()
        _, saved = self.backup()
        self.assertEqual(list(saved["bookmarks"]), ["2611.00002"])
        self.assertEqual(saved["papers"]["2611.00002"]["title"], "Fixture paper 2")
        self.assertEqual(saved["events"], [])

        # A new announcement on reload cannot supply the bookmarked metadata.
        self.context.unroute("**/*")
        tomorrow = listing([ROWS[4]]).replace("Thursday, 26 November", "Friday, 27 November")
        self.context.route("**/*", fixtures_only(tomorrow))
        self.reload_and_mount()
        bookmarks = self.nav("Bookmarks")
        expect(bookmarks).to_contain_text("1 bookmarked papers")
        expect(bookmarks.get_by_role("link", name="Fixture paper 2", exact=True)).to_have_attribute(
            "href", re.compile(r"/abs/2611[.]00002(v1)?$"))
        expect(bookmarks.locator("article.card")).to_have_count(0)

    def test_name_only_subscription_requires_confirmation(self):
        self.prepare()
        first = self.native_rows.first
        follow = first.get_by_role("button", name="Follow Alex Doe")
        prompts = []
        def reject(prompt):
            prompts.append(prompt.message)
            prompt.dismiss()
        self.page.once("dialog", reject)
        follow.click()
        expect(self.nav("Authors")).to_contain_text("Use Follow")
        self.assertRegex(prompts[0], r"(?i)name.only")
        self.close_dialog()
        self.page.once("dialog", lambda prompt: prompt.accept())
        follow.click()
        expect(first).to_contain_text("Following Alex Doe")
        panel = self.nav("Authors")
        expect(panel).to_contain_text("verify identity")
        panel.get_by_label("Private notes").fill("Compare the linked research areas.")
        panel.get_by_role("button", name="Save notes").click()
        self.daily()
        self.change_mode("subscriptions")
        self.assertEqual(len(self.paper_ids()), len(ROWS))

    def test_dictionary_literal_markup_recursion_math_and_cache_in_native_row(self):
        self.prepare(listing([ROWS[0]]))
        row = self.native_rows.first
        expect(row.locator(".list-title")).to_contain_text("<em>notation</em>")
        expect(row.locator(".list-title em, .mathjax section")).to_have_count(0)
        expect(row.locator("p.mathjax")).to_contain_text("$x^2$")
        self.select_word(row.locator(".fixture-word"), "Compactness")
        self.page.get_by_role("button", name="Explain selection").click()
        ai = row.locator(".inline-ai")
        expect(ai).to_contain_text("Compactness")
        expect(ai.get_by_role("button", name="Open AI settings")).to_be_visible()
        expect(self.page.locator("dialog[open]")).to_have_count(0)
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)
        self.configure_ai()
        self.page.evaluate("fixtureGM.network = 'ai-answer'")
        self.select_word(row.locator(".fixture-word"), "Compactness")
        self.page.get_by_role("button", name="Explain selection").click()
        expect(ai.locator(".source")).to_contain_text("ABSTRACT")
        expect(ai.locator(".answer")).to_contain_text("Literal <em>notation</em>")
        expect(ai.locator(".answer em")).to_have_count(0)
        formula = ai.locator(".answer math")
        expect(formula.locator("msup")).to_have_count(1)
        expect(formula.locator("annotation")).to_have_text("x^2")
        ai.get_by_label("My understanding").select_option("partial")
        self.select_word(ai.locator(".answer"), "Prerequisite")
        self.page.get_by_role("button", name="Explain selection").click()
        expect(ai).to_contain_text("Prerequisite")
        # The uncached recursive request shares the real arXiv pacing queue.
        expect(ai.locator(".answer")).to_be_visible(timeout=22000)
        expect(self.page.locator("dialog[open]")).to_have_count(0)
        self.page.evaluate("fixtureGM.network = 'offline'")
        self.select_word(row.locator(".fixture-word"), "Compactness")
        self.page.get_by_role("button", name="Explain selection").click()
        expect(ai.locator(".source")).to_contain_text("Cached")
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 2)
        panel = self.nav("Knowledge")
        expect(panel).to_contain_text("Compactness")
        expect(panel).to_contain_text("Prerequisite")
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))

    def test_provider_failure_stays_at_correct_paper(self):
        self.prepare()
        self.configure_ai()
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)
        self.page.evaluate("fixtureGM.network = 'ai-error'")
        row = self.native_rows.nth(2)
        row.get_by_role("button", name="AI overview").click()
        ai = row.locator(".inline-ai")
        expect(ai.locator(".error")).to_contain_text("Fixture provider unavailable")
        expect(ai.get_by_role("button", name="Check AI settings")).to_be_visible()
        expect(ai.locator(".answer")).to_have_count(0)
        expect(self.page.locator("dialog[open]")).to_have_count(0)
        expect(self.page.locator(".inline-ai")).to_have_count(1)
        requests = self.page.evaluate("fixtureGM.requests")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["url"], "http://127.0.0.1:4317/v1/explain")
        self.assertEqual(requests[0]["body"]["paper"]["id"], "2611.00003")
        self.assertTrue(requests[0]["body"]["noSpoilers"])
        self.assertTrue(set(requests[0]["body"]).isdisjoint({"events", "bookmarks", "subscriptions", "reading"}))
        expect(row.locator(".list-title")).to_contain_text("Fixture paper 3")
        row.get_by_role("button", name="Bookmark", exact=True).click()
        expect(row.get_by_role("button", name="Bookmarked")).to_be_visible()

    def partial(self):
        links = '<a href="?skip=1&amp;show=1">Next page</a> <a href="?skip=0&amp;show=2">All</a>'
        self.prepare(listing([ROWS[0]], total=2, page_link=links))
        self.menu("Daily")
        expect(self.controls).to_contain_text("1 of 2")
        expect(self.visible_rows).to_have_count(1)
        expect(self.page.locator("article.card, dialog[open]")).to_have_count(0)
        self.assertEqual(self.page.evaluate("GM_listValues().filter(k=>k.includes(':selections:'))"), [])
        link = self.controls.get_by_role("link", name="Open complete arXiv listing")
        expect(link).to_be_visible()
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)
        return link

    def test_incomplete_listing_leaves_native_rows_and_never_samples_missing_papers(self):
        link = self.partial()
        self.page.evaluate("fixtureGM.network = 'offline'")
        href = link.evaluate("a => [a.origin, a.pathname, Number(new URL(a.href).searchParams.get('show'))]")
        self.assertEqual(href[:2], ["https://arxiv.org", "/list/math/new"])
        self.assertGreaterEqual(href[2], 2)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.menu("All")
        expect(self.visible_rows).to_have_count(1)
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

        # The page-level launcher is available even when there is no first paper.
        self.context.unroute("**/*")
        self.context.route("**/*", fixtures_only(listing([])))
        self.reload_and_mount()
        self.open_page_settings().get_by_role("button", name="Show daily selection", exact=True).click()
        expect(self.controls).to_contain_text("0 / 0")
        expect(self.native_rows).to_have_count(0)
        self.menu("All")
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))

    def test_complete_listing_opens_a_native_arxiv_page_and_recovers(self):
        link = self.partial()
        destination = link.evaluate("a=>a.href")
        self.context.route(destination, fixtures_only(listing([ROWS[0], ROWS[2]]), destination))
        if link.get_attribute("target") == "_blank":
            with self.context.expect_page() as tab:
                link.click()
            self.page = tab.value
            self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        else:
            link.click()
        self.page.wait_for_url(destination, wait_until="networkidle")
        self.mount()
        self.daily()
        self.assertEqual(self.paper_ids(), ["2611.00001", "2611.00003"])
        expect(self.native_rows).to_have_count(2)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged(true)"))

    def test_mobile_native_tools_and_backup_import(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.prepare()
        button = self.settings_button
        expect(button).to_be_in_viewport()
        box = button.bounding_box()
        first_paper = self.page.locator('dl[id="articles"] > dt').first.bounding_box()
        self.assertGreater(box["x"], 195)
        self.assertLessEqual(box["x"] + box["width"], 390)
        self.assertLess(box["y"], first_paper["y"])
        button.focus()
        self.page.keyboard.press("Enter")
        expect(self.page.get_by_role("dialog", name="Discovery settings")).to_be_visible()
        self.page.keyboard.press("Escape")
        expect(button).to_be_focused()
        first = self.native_rows.first
        first.get_by_role("button", name="Bookmark", exact=True).click()
        expect(first.get_by_role("button", name="Bookmarked")).to_be_visible()
        data, state = self.backup()
        self.assertIn("2611.00001", state["bookmarks"])
        self.assertFalse(state["settings"]["ai"]["token"])
        panel = self.page.get_by_role("dialog")
        box = panel.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box["x"], 0)
        self.assertLessEqual(box["x"] + box["width"], 391)
        self.assertLessEqual(box["height"], 844)
        self.assertTrue(panel.evaluate("d => d.scrollWidth <= d.clientWidth + 1"))
        panel.get_by_label("Selective deletion").select_option("bookmarks")
        self.page.once("dialog", lambda prompt: prompt.accept())
        panel.get_by_role("button", name="Delete selected data").click()
        expect(self.nav("Bookmarks")).to_contain_text("0 bookmarked papers")
        panel = self.nav("Settings")
        panel.get_by_label("Import a JSON backup").set_input_files({
            "name": "fixture-backup.json", "mimeType": "application/json", "buffer": data})
        panel.get_by_role("button", name="Import selected JSON").click()
        expect(panel).to_contain_text("Backup imported")
        expect(self.nav("Bookmarks")).to_contain_text("1 bookmarked papers")

    def test_persistent_profile_restart_keeps_tool_preference_mode_selection_and_bookmark(self):
        with tempfile.TemporaryDirectory(prefix="arxiv-discovery-browser-") as directory:
            def start_profile():
                context = self.playwright.chromium.launch_persistent_context(
                    directory, service_workers="block", **self.launch)
                context.route("**/*", fixtures_only(listing(ROWS)))
                context.add_init_script(script=GM_MOCK)
                context.add_init_script(script=OPEN_TEST_HOSTS)
                self.page = context.pages[0]
                self.page.on("pageerror", lambda error: self.errors.append(str(error)))
                self.page.goto(BASE, wait_until="networkidle")
                self.mount()
                return context
            first = start_profile()
            try:
                panel = self.open_page_settings()
                self.pick_mode(panel, "balanced")
                self.close_dialog()
                expect(self.visible_rows).to_have_count(len(ROWS))
                expect(self.controls).to_have_count(0)
                self.open_page_settings().get_by_role("button", name="Show daily selection", exact=True).click()
                self.await_mode("balanced")
                pinned = self.paper_ids()
                row = self.visible_rows.first
                row.get_by_role("button", name="Bookmark", exact=True).click()
                expect(row.get_by_role("button", name="Bookmarked")).to_be_visible()
                self.open_page_settings().get_by_label("Enable paper tools").uncheck()
                self.close_dialog()
                expect(self.visible_rows).to_have_count(len(ROWS))
            finally:
                first.close()
            second = start_profile()
            try:
                expect(self.native_rows.locator("[data-arxiv-discovery]")).to_have_count(0)
                panel = self.open_page_settings()
                toggle = panel.get_by_label("Enable paper tools")
                expect(toggle).not_to_be_checked()
                expect(panel.get_by_label("Recommendation mode")).to_have_value("balanced")
                toggle.check()
                panel.get_by_role("button", name="Show daily selection", exact=True).click()
                self.await_mode("balanced")
                self.assertEqual(self.paper_ids(), pinned)
                expect(self.visible_rows.first.get_by_role(
                    "button", name="Bookmarked")).to_be_visible()
            finally:
                second.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Offline Playwright tests that mount the shipped userscript on arXiv listing fixtures.

Run `npm run build && python tests/browser_integration.py` with Playwright and
Chromium installed. CHROMIUM_BIN selects a particular local Chrome/Chromium.
"""

import gzip
import hashlib
import html
import json
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
          text: "Prerequisite definitions are fixture text. Literal <em>notation</em> stays text.",
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
  window.fixtureNativeUnchanged = () => {
    const clone = document.documentElement.cloneNode(true);
    for (const addition of clone.querySelectorAll('[data-arxiv-discovery]')) addition.remove();
    return clone.outerHTML === original && nodes.every(([node,parent]) =>
      node.isConnected && node.parentNode === parent);
  };
}
"""


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


def fixtures_only(document):
    """All requests are intercepted. arXiv's own fixture scripts never run."""
    def handler(route):
        if route.request.is_navigation_request() and route.request.url == BASE:
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

    def mount(self, *, toolbar=True):
        self.page.evaluate(CAPTURE_NATIVE)
        self.page.evaluate(self.bundle)
        if toolbar:
            self.page.locator("#arxiv-discovery-toolbar").wait_for(state="attached")
        self.page.wait_for_function("() => fixtureGM.menu.has('Show arXiv Discovery')")

    def reload_and_mount(self, *, toolbar=True):
        self.page.reload(wait_until="networkidle")
        self.mount(toolbar=toolbar)

    def close_dialog(self):
        dialog = self.page.locator("dialog[open]")
        if dialog.count():
            dialog.get_by_role("button", name=re.compile("^Close")).click()
            expect(dialog).to_have_count(0)

    def nav(self, button):
        self.close_dialog()
        self.page.get_by_role("navigation", name="arXiv Discovery").get_by_role(
            "button", name=button, exact=True).click()
        return self.page.get_by_role("dialog")

    def daily(self):
        panel = self.nav("Daily selection")
        expect(panel.get_by_text("End of this daily selection.", exact=True)).to_be_visible()
        return panel

    @staticmethod
    def paper_ids(panel):
        return panel.locator("article.card").evaluate_all("(cards) => cards.map(c => c.dataset.paperId)")

    def change_mode(self, mode):
        panel = self.page.get_by_role("dialog")
        old = panel.element_handle()
        panel.get_by_label("Recommendation mode").select_option(mode)
        self.page.wait_for_function("(dialog) => !dialog.isConnected", arg=old)
        expect(panel.get_by_label("Recommendation mode")).to_have_value(mode)
        expect(panel.get_by_text("End of this daily selection.", exact=True)).to_be_visible()
        return panel

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
        self.assertTrue(self.page.locator("#arxiv-discovery-toolbar").evaluate(
            "(host) => host.shadowRoot === null"))
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

    def test_closed_shadow_text_input_does_not_submit_keyboard_feedback(self):
        # Retain a test-only reference for measuring coordinates. The boundary
        # stays closed and Chromium retargets keydown to the host in production.
        self.context.add_init_script("""(() => {
          const original = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function(options) {
            const root = original.call(this, options);
            if (this.id === 'arxiv-discovery-toolbar') window.fixtureClosedToolbar = root;
            return root;
          };
        })();""")
        self.prepare(open_shadows=False)

        def click_closed(selector, caption=None):
            point = self.page.evaluate("""([selector, caption]) => {
              const item = [...fixtureClosedToolbar.querySelectorAll(selector)].find(
                node => !caption || node.textContent === caption);
              item.scrollIntoView({block:'center'});
              const bounds = item.getBoundingClientRect();
              return {x:bounds.left + bounds.width/2, y:bounds.top + bounds.height/2};
            }""", [selector, caption])
            self.page.mouse.click(**point)

        click_closed("nav button", "Knowledge")
        click_closed("dialog input[placeholder]")
        self.assertEqual(self.page.evaluate("fixtureClosedToolbar.activeElement.tagName"), "INPUT")
        self.page.keyboard.press("Alt+l")
        self.page.keyboard.type("finite sequences")
        self.page.keyboard.press("Tab")
        self.page.keyboard.press("Escape")
        self.assertEqual(self.page.evaluate("GM_listValues().filter(k => k.includes(':events:'))"), [])

    def test_full_reference_preserved_daily_feed_original_and_menu_restore(self):
        self.prepare(reference_fixture())
        expect(self.page.get_by_role("navigation", name="arXiv Discovery")).to_contain_text("701 papers")
        counts = self.page.evaluate("""() => {
          const papers = GM_listValues().filter(k => k.includes(':papers:')).map(k => GM_getValue(k));
          return {sections: Object.fromEntries(['new','cross','replacement'].map(
                    section => [section,papers.filter(p => p.section === section).length])),
                  dates: [...new Set(papers.map(p => p.announcementDate))]};
        }""")
        self.assertEqual(counts, {"sections": {"new": 379, "cross": 61, "replacement": 261}, "dates": [DATE]})
        panel = self.daily()
        first = self.paper_ids(panel)
        self.assertGreater(len(first), 0)
        self.assertLessEqual(len(first), 32)
        self.assertEqual(len(set(first)), len(first))
        expect(panel.get_by_label("Recommendation mode")).to_have_value("random")
        expect(panel).to_contain_text(f"0 / {len(first)} papers reviewed")
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.close_dialog()
        self.page.get_by_role("button", name="Original arXiv", exact=True).click()
        expect(self.page.locator("[data-arxiv-discovery]")).to_have_count(0)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))
        self.reload_and_mount(toolbar=False)
        expect(self.page.locator("[data-arxiv-discovery]")).to_have_count(0)
        # Simulate choosing Tampermonkey's registered menu command.
        self.page.evaluate("() => fixtureGM.menu.get('Show arXiv Discovery')()")
        self.assertEqual(self.paper_ids(self.daily()), first)
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

    def test_modes_replacement_restore_and_history_survive_refresh(self):
        self.prepare()
        panel = self.daily()
        first = self.paper_ids(panel)
        self.assertEqual(len(set(first)), 3)
        self.assertTrue(panel.get_by_text("29 categories not represented", exact=True).count())
        panel.locator("article.card").first.get_by_role("button", name="Replace this paper").click()
        expect(panel.locator("article.card").first).not_to_have_attribute("data-paper-id", first[0])
        replaced = self.paper_ids(panel)
        self.assertEqual(len(set(replaced)), 3)
        self.assertEqual(replaced[1:], first[1:])
        panel.get_by_role("button", name="Restore original selection").click()
        expect(panel.locator("article.card").first).to_have_attribute("data-paper-id", first[0])
        self.assertEqual(self.paper_ids(panel), first)
        for mode in ("balanced", "personalized", "discovery", "subscriptions"):
            panel = self.change_mode(mode)
            self.assertEqual(len(self.paper_ids(panel)), len(set(self.paper_ids(panel))))
        expect(panel).to_contain_text("No eligible papers match")
        self.assertEqual(self.paper_ids(self.change_mode("random")), first)
        self.reload_and_mount()
        self.assertEqual(self.paper_ids(self.daily()), first)
        panel.get_by_role("button", name="Regenerate daily selection").click()
        panel.get_by_role("button", name="Previous selections").click()
        expect(self.page.get_by_role("dialog")).to_contain_text("saved revisions")
        options = self.page.get_by_label("Publication and mode").locator("option")
        random_key = next(o.get_attribute("value") for o in options.all() if "random" in o.inner_text())
        self.page.get_by_label("Publication and mode").select_option(random_key)
        self.page.get_by_label("Saved version").select_option("original")
        self.assertEqual(self.paper_ids(self.page.get_by_role("dialog")), first)
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)

    def test_daily_keyboard_navigation_background_and_category_browsing(self):
        self.prepare()
        panel = self.daily()
        cards = panel.locator("article.card")
        cards.first.focus()
        self.page.keyboard.press("Alt+j")
        expect(cards.nth(1)).to_be_focused()
        self.page.keyboard.press("Alt+l")
        expect(cards.nth(1).get_by_role("button", name="Like", exact=True)).to_have_attribute(
            "aria-pressed", "true")
        self.page.keyboard.press("Alt+r")
        expect(cards.nth(1).get_by_role("button", name="Read", exact=True)).to_be_visible()
        self.page.keyboard.press("Alt+r")
        expect(cards.nth(1).get_by_role("button", name="Mark as read", exact=True)).to_be_visible()
        self.page.keyboard.press("Alt+k")
        expect(cards.first).to_be_focused()
        cards.nth(1).get_by_role("button", name="Need background").click()
        expect(self.nav("Interests")).to_contain_text("0 active interest examples")
        panel = self.daily()
        panel.get_by_role("button", name="All papers in a category").click()
        panel.get_by_label("Category", exact=True).select_option("math.LO")
        self.assertEqual(len(self.paper_ids(panel)), 2)
        panel.get_by_label("Category", exact=True).select_option("math.GM")
        self.assertEqual(self.paper_ids(panel), [])
        expect(panel.get_by_role("button", name="Next page")).to_be_disabled()

    def test_feedback_revision_exclusions_reset_restore_and_permanent_deletion(self):
        self.prepare()
        panel = self.daily()
        card = panel.locator("article.card").first
        paper = card.get_attribute("data-paper-id")
        card.get_by_role("button", name="Like", exact=True).click()
        expect(card.get_by_role("button", name="Like", exact=True)).to_have_attribute("aria-pressed", "true")
        card.get_by_role("button", name="Dislike", exact=True).click()
        expect(card.get_by_role("button", name="Dislike", exact=True)).to_have_attribute("aria-pressed", "true")
        card.get_by_role("button", name="Bookmark", exact=True).click()
        card.get_by_role("button", name="Mark as read", exact=True).click()
        expect(panel).to_contain_text("1 / 3 papers reviewed")
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

        def tools_for(row_index):
            detail = self.page.locator("dl#articles dd").nth(row_index).locator("details.tools")
            if detail.get_attribute("open") is None:
                detail.locator("summary").click()
            return detail

        first = tools_for(0)
        first.get_by_role("button", name="Like", exact=True).click()
        first.get_by_role("button", name="Bookmark", exact=True).click()
        expect(first.get_by_role("button", name="Bookmarked")).to_be_visible()
        panel = self.nav("Settings")
        self.page.once("dialog", lambda prompt: prompt.accept())
        panel.get_by_role("button", name="Delete all local data").click()
        expect(panel).to_contain_text("All saved Discovery data has been deleted")
        self.close_dialog()

        first = tools_for(0)
        expect(first.get_by_role("button", name="Bookmark", exact=True)).to_be_visible()
        expect(first.get_by_role("button", name="Like", exact=True)).not_to_have_attribute(
            "aria-pressed", "true")
        second = tools_for(1)
        expect(second.get_by_role("button", name="Bookmark", exact=True)).to_be_visible()
        _, cleared = self.backup()
        for collection in ("bookmarks", "events", "papers", "selections"):
            self.assertFalse(cleared[collection], collection)

        self.assertEqual(len(self.paper_ids(self.daily())), 3)
        self.close_dialog()
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
        paper = bookmarks.locator("article.card")
        expect(paper).to_have_attribute("data-paper-id", "2611.00002")
        expect(paper.get_by_role("heading")).to_have_text("Fixture paper 2")
        expect(paper.get_by_role("link", name="Abstract page")).to_have_attribute(
            "href", "https://arxiv.org/abs/2611.00002v1")

    def test_name_only_subscription_requires_confirmation(self):
        self.prepare()
        panel = self.daily()
        follow = panel.locator("article.card").first.get_by_role("button", name="Follow Alex Doe")
        prompts = []
        def reject(prompt):
            prompts.append(prompt.message)
            prompt.dismiss()
        self.page.once("dialog", reject)
        follow.click()
        expect(self.nav("Authors")).to_contain_text("Use Follow")
        self.assertRegex(prompts[0], r"(?i)name.only")
        panel = self.daily()
        self.page.once("dialog", lambda prompt: prompt.accept())
        panel.locator("article.card").first.get_by_role("button", name="Follow Alex Doe").click()
        panel = self.nav("Authors")
        expect(panel).to_contain_text("verify identity")
        panel.get_by_label("Private notes").fill("Compare the linked research areas.")
        panel.get_by_role("button", name="Save notes").click()
        self.daily()
        self.assertEqual(len(self.paper_ids(self.change_mode("subscriptions"))), len(ROWS))

    def test_dictionary_selection_literal_markup_recursion_and_offline_cache(self):
        self.prepare(listing([ROWS[0]]))
        panel = self.daily()
        card = panel.locator("article.card")
        expect(card.get_by_role("heading")).to_contain_text("<em>notation</em>")
        self.assertEqual(card.locator("h3 em").count(), 0)
        card.get_by_text("Original abstract", exact=True).click()
        expect(card.locator(".abstract")).to_contain_text("<section>example</section>")
        self.assertEqual(card.locator(".abstract section").count(), 0)
        formula = card.locator(".abstract math")
        expect(formula).to_have_count(1)
        expect(formula.locator("msup")).to_have_count(1)
        expect(formula.locator("annotation")).to_have_text("x^2")
        expect(card).to_contain_text("No HTML link supplied")
        self.close_dialog()
        self.select_word(self.page.locator(".fixture-word"), "Compactness")
        self.page.get_by_role("button", name="Explain selection").click()
        expect(self.page.get_by_role("dialog")).to_have_attribute("aria-label", "Explain: Compactness")
        expect(self.page.get_by_role("button", name="Open AI settings")).to_be_visible()
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)
        self.configure_ai()
        self.page.evaluate("fixtureGM.network = 'ai-answer'")
        self.select_word(self.page.locator(".fixture-word"), "Compactness")
        self.page.get_by_role("button", name="Explain selection").click()
        panel = self.page.get_by_role("dialog")
        expect(panel.locator(".source")).to_contain_text("ABSTRACT")
        expect(panel.locator(".answer")).to_contain_text("Literal <em>notation</em>")
        self.assertEqual(panel.locator(".answer em").count(), 0)
        panel.get_by_label("My understanding").select_option("partial")
        self.select_word(panel.locator(".answer"), "Prerequisite")
        panel.get_by_role("button", name="Explain selection").click()
        expect(panel).to_have_attribute("aria-label", "Explain: Prerequisite")
        # A second uncached bridge request shares the real arXiv pacing queue.
        expect(panel.locator(".answer")).to_be_visible(timeout=22000)
        self.close_dialog()
        self.page.evaluate("fixtureGM.network = 'offline'")
        self.select_word(self.page.locator(".fixture-word"), "Compactness")
        self.page.get_by_role("button", name="Explain selection").click()
        expect(panel.locator(".source")).to_contain_text("Cached")
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 2)
        panel = self.nav("Knowledge")
        expect(panel).to_contain_text("Compactness")
        expect(panel).to_contain_text("Prerequisite")

    def test_explicit_ai_errors_keep_paper_and_controls_usable(self):
        self.prepare()
        self.configure_ai()
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)
        self.page.evaluate("fixtureGM.network = 'ai-error'")
        self.daily().locator("article.card").first.get_by_role("button", name="AI overview").click()
        panel = self.page.get_by_role("dialog")
        expect(panel.locator(".error")).to_contain_text("Fixture provider unavailable")
        expect(panel.get_by_role("button", name="Check AI settings")).to_be_visible()
        self.assertEqual(panel.locator(".answer").count(), 0)
        requests = self.page.evaluate("fixtureGM.requests")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["url"], "http://127.0.0.1:4317/v1/explain")
        self.assertTrue(requests[0]["body"]["noSpoilers"])
        self.assertTrue(set(requests[0]["body"]).isdisjoint({"events", "bookmarks", "subscriptions", "reading"}))
        expect(self.daily().locator("article.card").first).to_be_visible()

    def partial(self):
        link = '<a href="?skip=1&amp;show=1">Next page</a>'
        self.prepare(listing([ROWS[0]], total=2, page_link=link))
        panel = self.nav("Daily selection")
        expect(panel).to_contain_text("Only 1 of 2 entries")
        self.assertEqual(self.paper_ids(panel), [])
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 0)
        return panel

    def test_partial_listing_failure_never_generates_a_biased_feed(self):
        panel = self.partial()
        self.page.evaluate("fixtureGM.network = 'limited'")
        panel.get_by_role("button", name="Load complete publication").click()
        expect(panel).to_contain_text("HTTP 429")
        self.assertEqual(self.paper_ids(panel), [])
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 1)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))

    def test_partial_listing_recovers_on_demand(self):
        panel = self.partial()
        self.page.evaluate("(s) => {fixtureGM.network='page'; fixtureGM.responseHTML=s;}", listing(ROWS[:2]))
        panel.get_by_role("button", name="Load complete publication").click()
        expect(panel.get_by_text("End of this daily selection.", exact=True)).to_be_visible()
        self.assertEqual(len(self.paper_ids(panel)), 1)  # both eligible papers are in math.LO
        self.assertEqual(self.page.evaluate("fixtureGM.requests.length"), 1)
        self.assertTrue(self.page.evaluate("fixtureNativeUnchanged()"))

    def test_mobile_modal_keyboard_and_json_backup_import(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.prepare()
        panel = self.daily()
        card = panel.locator("article.card").first
        paper = card.get_attribute("data-paper-id")
        card.get_by_role("button", name="Bookmark", exact=True).click()
        self.page.keyboard.press("Escape")
        expect(self.page.locator("dialog[open]")).to_have_count(0)
        data, state = self.backup()
        self.assertIn(paper, state["bookmarks"])
        self.assertFalse(state["settings"]["ai"]["token"])
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

    def test_persistent_profile_restart_keeps_pinned_selection(self):
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
                panel = self.daily()
                pinned = self.paper_ids(panel)
                panel.locator("article.card").first.get_by_role("button", name="Bookmark", exact=True).click()
                expect(panel.locator("article.card").first.get_by_role("button", name="Bookmarked")).to_be_visible()
            finally:
                first.close()
            second = start_profile()
            try:
                panel = self.daily()
                self.assertEqual(self.paper_ids(panel), pinned)
                expect(panel.locator("article.card").first.get_by_role("button", name="Bookmarked")).to_be_visible()
            finally:
                second.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

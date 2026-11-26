"""Run with python tests/parser_browser.py. The browser receives only local fixtures."""
import os
import gzip
from pathlib import Path
import shutil
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "fixtures/arxiv-math-new.html"
FIXTURE = FIXTURE_PATH.read_text(encoding="utf-8") if FIXTURE_PATH.exists() else gzip.decompress((ROOT / "fixtures/arxiv-math-new.html.gz").read_bytes()).decode("utf-8")
ORIGIN = "https://arxiv.org"
BASE = ORIGIN + "/list/math/new"
DATE = "Thursday, 26 November 2026"


def row(paper="2611.00001", title="A result", subjects="Logic (math.LO)", extra=""):
    return f"""
    <dt><a title="Abstract" href="/abs/{paper}">arXiv:{paper}</a></dt>
    <dd><div class="list-title"><span class="descriptor">Title:</span>{title}</div>
        <div class="list-subjects">{subjects}</div>{extra}</dd>
    """


def listing(rows, total=1, shown=1, category_total=None, date=DATE, pagination="", section="New submissions"):
    available = total if category_total is None else category_total
    return f"""
    <div id="dlpage"><h3>Showing new listings for {date}</h3>
    <div class="paging">Total of {total} entries {pagination}</div>
    <dl id="articles"><h3>{section} (showing {shown} of {available} entries)</h3>{rows}</dl>
    </div>
    """


class ParserBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        bundled = Path(cls.playwright.chromium.executable_path)
        executable = os.getenv("CHROMIUM_BIN") or (str(bundled) if bundled.is_file() else None)
        executable = executable or shutil.which("chromium") or shutil.which("google-chrome")
        cls.browser = cls.playwright.chromium.launch(executable_path=executable, args=["--no-sandbox"])
        cls.page = cls.browser.new_page()

        def route_handler(route):
            name = route.request.url.removeprefix(ORIGIN + "/modules/")
            if name in {"parser.js", "categories.js", "network.js"}:
                route.fulfill(content_type="application/javascript", body=(ROOT / "src" / name).read_bytes())
            elif route.request.url == ORIGIN + "/test-entry":
                route.fulfill(content_type="text/html", body="<!doctype html><html lang=en></html>")
            else:
                route.abort()

        cls.page.route("**/*", route_handler)
        cls.page.goto(ORIGIN + "/test-entry")
        cls.page.evaluate("""async () => {
          window.ingest = await import('/modules/parser.js');
          window.taxonomy = await import('/modules/categories.js');
          window.network = await import('/modules/network.js');
          window.parse = text => new DOMParser().parseFromString(text, 'text/html');
        }""")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def parse_listing(self, html, base=BASE):
        return self.page.evaluate("([html,url]) => ingest.parseListing(parse(html),url)", [html, base])

    def test_entire_reference_fixture(self):
        result = self.page.evaluate("""([html,url]) => {
          const doc = parse(html);
          const original = doc.documentElement.outerHTML;
          const parsed = ingest.parseListing(doc,url);
          const nodes = ingest.findPaperNodes(doc,url);
          const htmlCount = parsed.papers.filter(p => p.links.html).length;
          const linked = parsed.papers.find(p => p.inlineLinks?.abstract?.length);
          const link = linked.inlineLinks.abstract[0];
          const fields = parsed.papers.every(p => p.title && p.id && p.authors.length &&
            p.abstract && p.primaryCategory && p.categories.includes(p.primaryCategory) &&
            p.announcementDate === parsed.announcementDate && p.links.abstract && p.links.pdf);
          return {counts:parsed.counts, date:parsed.announcementDate, complete:parsed.complete,
            warnings:parsed.warnings, next:parsed.nextUrls, total:parsed.advertisedTotal, htmlCount,
            sections:parsed.sectionTotals, fields, nodes:nodes.size, first:parsed.papers[0],
            second:parsed.papers[1], last:parsed.papers.at(-1), row:nodes.get(parsed.papers[0].id).dt.localName,
            unchanged:doc.documentElement.outerHTML === original,
            linkedText:linked.abstract.slice(link.start,link.end), linkedUrl:link.url,
            unknownReplacement:parsed.papers.find(p=>p.section==='replacement' && !p.links.html),
            journal:parsed.papers.some(p => p.journalRef)};
        }""", [FIXTURE, BASE])
        self.assertEqual(result["counts"], {"new": 379, "cross": 61, "replacement": 261, "total": 701})
        self.assertEqual(result["total"], 701)
        self.assertEqual(result["sections"], {"new": 379, "cross": 61, "replacement": 261})
        self.assertEqual(result["date"], "2026-11-26")
        self.assertTrue(result["complete"], result["warnings"])
        self.assertTrue(result["unchanged"])
        self.assertTrue(result["fields"])
        self.assertTrue(result["journal"])
        self.assertEqual(result["next"], [])
        self.assertEqual(result["nodes"], 701)
        self.assertEqual(result["row"], "dt")
        self.assertEqual(result["htmlCount"], 672)
        first = result["first"]
        self.assertEqual(first["id"], "2611.33166")
        self.assertEqual(first["versionedId"], "2611.33166v1")
        self.assertEqual(first["categories"], ["math.ST", "math.PR"])
        self.assertEqual(first["authors"][0]["name"], "Leonardo Chhabra")
        self.assertIn("Karhunen-Loève", first["title"])
        self.assertIn(r"$t\mapsto\int_0^t", first["abstract"])
        self.assertIn("14 pages", result["second"]["comments"])
        self.assertEqual(result["last"]["categories"], ["cs.LG", "math.IT"])
        self.assertEqual(result["last"]["version"], 2)
        self.assertEqual(result["unknownReplacement"]["version"], 0)
        self.assertEqual(result["unknownReplacement"]["id"], result["unknownReplacement"]["versionedId"])
        self.assertEqual(result["linkedText"], "this http URL")
        self.assertEqual(result["linkedUrl"], "http://process.based/")

    def test_multiple_lists_external_headings_and_honest_empty_day(self):
        html = """<div id=dlpage><h3>Results</h3><h3>Mon, 9 Mar 2026</h3>
          <div class=paging>Total of 2 entries</div>
          <h3>Cross-lists (showing 1 of 1 entries)</h3><dl id=articles>""" + row() + """</dl>
          <dl id=articles><h3>Replacement submissions (showing 1 of 1 entries)</h3>""" + row("0705.0123v3") + "</dl></div>"
        data = self.parse_listing(html)
        self.assertTrue(data["complete"], data["warnings"])
        self.assertEqual(data["announcementDate"], "2026-03-09")
        self.assertEqual([(p["section"], p["version"]) for p in data["papers"]], [("cross", 0), ("replacement", 3)])
        empty = self.parse_listing(listing("", total=0, shown=0))
        self.assertTrue(empty["complete"])
        self.assertEqual(empty["papers"], [])

    def test_explicit_cycle_boundaries_and_incomplete_notices(self):
        html = listing(row()).replace("</dl>", "</dl><h3>Showing new listings for 25 November 2026</h3>" +
            "<dl id=articles><h3>New submissions</h3>" + row("2611.00002") + "</dl>")
        data = self.parse_listing(html)
        self.assertFalse(data["complete"])
        self.assertEqual([p["id"] for p in data["papers"]], ["2611.00001"])
        invalid = self.parse_listing(listing(row(), date="31 November 2026"))
        self.assertIsNone(invalid["announcementDate"])
        self.assertFalse(invalid["complete"])
        missing_total = self.parse_listing(listing(row()).replace("Total of 1 entries", ""))
        self.assertIsNone(missing_total["advertisedTotal"])
        self.assertFalse(missing_total["complete"])
        broken = self.parse_listing(listing("<dt></dt>" + row() + row(), total=3, shown=3))
        self.assertEqual(len(broken["papers"]), 1)
        self.assertFalse(broken["complete"])
        self.assertTrue(any("Unpaired" in w for w in broken["warnings"]))
        self.assertTrue(any("Repeated" in w for w in broken["warnings"]))
        unknown_section = self.parse_listing(listing(row(), section="Some unrelated results"))
        self.assertFalse(unknown_section["complete"])
        self.assertEqual(unknown_section["papers"], [])

    def test_trusted_identity_paths_and_inert_inline_content(self):
        html = listing(row("hep-th/9603067v2",
            title='A <script type="application/json">metadata</script><i>θ</i> <a href="javascript:void(0)">result</a>',
            subjects='<span class="primary-subject">Information Theory (cs.IT)</span>; Information Theory (math.IT); Numerical Analysis (cs.NA); Statistics Theory (stat.TH); Mathematical Physics (math-ph); Quantum Physics (quant-ph)',
            extra='<p class="mathjax">See <a href="https://doi.org/10.1000/abc"><b>published</b> result</a>.<br>Also <math alttext="x^2"><mi>x</mi></math> and <script type="math/tex">y^3</script>.<iframe>metadata</iframe></p>'
            '<div class="list-authors"><a href="/search/math?searchtype=author&amp;query=M">Éva M.</a>'
            '<a href="https://orcid.org/0000-0002-1825-0097"><img alt="ORCID"></a>, '
            '<a href="/a/warner_s_1.html">Simeon Warner</a>, <a href="data:text/plain,hello">Éva M.</a></div>'))
        html = html.replace("</dt>", '<a href="https://example.invalid/html/hep-th/9603067v2" title="View HTML">HTML</a>'
            '<a href="/pdf/2611.00001" title="Download PDF">wrong paper</a></dt>')
        paper = self.parse_listing('<base href="https://example.invalid">' + html)["papers"][0]
        self.assertEqual(paper["title"], "A θ result")
        self.assertEqual(paper["id"], "hep-th/9603067")
        self.assertEqual(paper["links"], {"abstract": ORIGIN + "/abs/hep-th/9603067v2", "pdf": ORIGIN + "/pdf/hep-th/9603067v2", "html": None})
        self.assertEqual(paper["categories"], ["math.IT", "math.NA", "math.ST", "math.MP", "quant-ph"])
        self.assertEqual(paper["authors"][0]["stableId"], "orcid:0000-0002-1825-0097")
        self.assertEqual(paper["authors"][1]["stableId"], "arxiv:warner_s_1")
        self.assertEqual(paper["authors"][2], {"name": "Éva M.", "url": None, "stableId": None})
        self.assertEqual(paper["abstract"], "See published result.\nAlso " + r"\(x^2\) and \(y^3\).")
        link = paper["inlineLinks"]["abstract"][0]
        self.assertEqual(paper["abstract"][link["start"]:link["end"]], "published result")
        self.assertNotIn("title", paper["inlineLinks"])
        foreign = self.parse_listing(html.replace('/abs/hep-th/9603067v2', 'https://arxiv.org.example.invalid/abs/hep-th/9603067v2'))
        self.assertFalse(foreign["complete"])
        self.assertEqual(foreign["papers"], [])

    def test_abstract_and_full_html_reader(self):
        doc = """
        <div id="abs"><h1 class="title mathjax"><span class="descriptor">Title:</span>Topology</h1>
        <div class="authors"><a href="/search/math?searchtype=author&amp;query=Doe">Jo Doe</a></div>
        <blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>Geometric maps.</blockquote>
        <div class="dateline">[Submitted on 20 Nov 2026]</div>
        <table><tr><td class="tablecell subjects"><span class="primary-subject">Geometric Topology (math.GT)</span>; Logic (math.LO)</td></tr>
        <tr><td class="tablecell arxivid"><a href="/abs/math.GT/0211159v3">this version</a></td></tr>
        <tr><td class="tablecell comments">15 pages</td><td class="tablecell jref">Journal 7</td></tr></table>
        <div class="full-text"><a href="/pdf/math/0211159v3.pdf">View PDF</a><a href="/html/math/0211159v3">HTML</a></div>
        <nav>arXiv navigation</nav></div>
        """
        data = self.page.evaluate("""html => {
          const doc = parse(html);
          return {paper:ingest.parseAbstract(doc,'https://arxiv.org/abs/math/0211159'),
            older:ingest.parseAbstract(doc,'https://arxiv.org/abs/math/0211159v2'),
            wrong:ingest.parseAbstract(doc,'https://example.invalid/abs/math/0211159'),
            targets:['h1','blockquote','nav'].map(s=>ingest.readerTarget(doc.querySelector(s).firstChild)?.localName || null)};
        }""", doc)
        paper = data["paper"]
        self.assertEqual(paper["versionedId"], "math/0211159v3")
        self.assertEqual(paper["links"]["html"], ORIGIN + "/html/math/0211159v3")
        self.assertEqual(paper["journalRef"], "Journal 7")
        self.assertEqual(paper["abstract"], "Geometric maps.")
        self.assertEqual(paper["announcementDate"], None)
        self.assertIsNone(paper["section"])
        self.assertEqual(paper["categories"], ["math.GT", "math.LO"])
        self.assertIsNone(data["older"]["links"]["html"])
        self.assertIsNone(data["wrong"])
        self.assertEqual(data["targets"], ["h1", "blockquote", None])

        full = """<article class="ltx_document"><h1 class="ltx_title ltx_title_document">Topology with
          <math alttext="X"><mi>X</mi></math></h1>
          <div class="ltx_authors"><span class="ltx_personname">Jo Doe</span></div>
          <div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6><p>Geometric maps.</p></div>
          <section><p id="selected">A context-specific term.</p></section></article>"""
        data = self.page.evaluate("""html => {
          const doc = parse(html);
          return {paper:ingest.parseAbstract(doc,'https://arxiv.org/html/2611.00001v2'),
            target:ingest.readerTarget(doc.querySelector('#selected').firstChild)?.localName};
        }""", full)
        self.assertEqual(data["paper"]["title"], r"Topology with \(X\)")
        self.assertEqual(data["paper"]["abstract"], "Geometric maps.")
        self.assertEqual(data["paper"]["authors"][0]["name"], "Jo Doe")
        self.assertEqual(data["target"], "article")
        self.assertEqual(data["paper"]["version"], 2)

    def test_pagination_prioritizes_complete_rendering_and_ignores_foreign_links(self):
        markup = ('<a href="?skip=1&amp;show=1">next</a>'
                  '<a href="/list/math/new?show=20&amp;skip=0">all</a>'
                  '<a href="https://example.invalid/list/math/new?show=999">more</a>'
                  '<a href="/list/cs/new?skip=0&amp;show=5">next</a>'
                  '<a href="/list/math/new?show=3&amp;skip=1&amp;callback=bad">next</a>'
                  '<a href="?skip=0&amp;show=1">fewer</a>')
        first = listing(row(), total=2, pagination=markup)
        second = listing(row() + row("2611.00002"), total=2, shown=2)
        data = self.page.evaluate("""async ([first,second,url]) => {
          const initial=ingest.parseListing(parse(first),url);
          const calls=[];
          const completed=await network.loadCompleteListing(initial,{ request: async (url) => {
            calls.push(url); return {status:200,text:second,finalUrl:url};
          }});
          return {initial,completed,calls};
        }""", [first, second, BASE])
        self.assertFalse(data["initial"]["complete"])
        self.assertEqual(data["initial"]["nextUrls"], [BASE + "?show=20&skip=0", BASE + "?show=1&skip=1"])
        self.assertEqual(data["calls"], [BASE + "?show=20&skip=0"])
        self.assertTrue(data["completed"]["complete"], data["completed"]["warnings"])
        self.assertEqual(len(data["completed"]["papers"]), 2)

    def test_multi_page_overlap_wrong_cycles_rate_limiting_and_network_failures(self):
        first = listing(row() + row("2611.00002"), total=3, shown=2, pagination='<a href="?skip=1&amp;show=2">next</a>')
        second = listing(row("2611.00002") + row("2611.00003"), total=3, shown=2, pagination='<a href="/list/math/new">first</a>')
        result = self.page.evaluate("""async ([a,b,base]) => {
          const initial = ingest.parseListing(parse(a),base);
          const load = (request, extra={}) => network.loadCompleteListing(initial, {request,parseDocument:parse,...extra});
          const merged = await load(async () => ({status:200,text:b}));
          const changed = await load(async () => ({status:200,text:b.replace('26 November','27 November')}));
          const unavailable = await load(async () => ({status:429,text:''}));
          const redirect = await load(async () => ({status:200,text:b,finalUrl:'https://example.invalid/list/math/new'}));
          const mismatch = await load(async () => ({status:200,text:b.replace('Total of 3','Total of 4')}));
          const failed = await load(async () => { throw new Error('Offline'); });
          const cap = await load(async () => { throw new Error('unreachable'); },{maxPages:0});
          return {merged,changed,unavailable,redirect,mismatch,failed,cap};
        }""", [first, second, BASE])
        self.assertTrue(result["merged"]["complete"], result["merged"]["warnings"])
        self.assertEqual(len(result["merged"]["papers"]), 3)
        for case in ["changed", "unavailable", "redirect", "mismatch", "failed", "cap"]:
            with self.subTest(case=case):
                self.assertFalse(result[case]["complete"])
                self.assertEqual(len(result[case]["papers"]), 2)
                self.assertTrue(result[case]["warnings"])
        self.assertTrue(any("429" in w for w in result["unavailable"]["warnings"]))
        self.assertTrue(any("changed" in w for w in result["changed"]["warnings"]))
        self.assertEqual(result["failed"]["nextUrls"], [BASE + "?show=2&skip=1"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

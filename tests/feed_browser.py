"""Offline browser tests for the shipped feed UI.

All populations and observations below are explicitly synthetic. No arXiv,
readership-provider, or AI requests leave the disposable browser context.
"""
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

from browser_integration import (
    BUNDLE, CAPTURE_NATIVE, GM_MOCK, OPEN_TEST_HOSTS, ROWS, TEST_TOKEN, listing,
    optional_browser_path, row,
)


RECENT = 'https://arxiv.org/list/math/recent'
TODAY = 'https://arxiv.org/list/math/new'
PREFIX = 'arxiv-discovery:v1:'
FEED_GM_MOCK = GM_MOCK.replace(
    "url.startsWith('https://arxiv.org/list/math/new?')",
    "(url.startsWith('https://arxiv.org/list/math/new?') || url.startsWith('https://arxiv.org/list/math/recent?'))",
)


def recent_document(total=6, shown=None):
    """A two-cohort native-style Recent page; all paper data is synthetic."""
    shown = total if shown is None else shown
    boundary = total // 2
    rows = [row(i, ['math.LO','math.GN','math.FA'][(i-1)//2 % 3], first=i==1)
            for i in range(1, total+1)]
    navigation = f'''<ul><li><a href="?skip=0&amp;show={shown}#item1">2026-11-26</a></li>
      <li><a href="?skip={boundary}&amp;show={shown}#item{boundary+1}">2026-11-20</a></li></ul>'''
    complete_link = '<a href="?skip=0&amp;show=2000">all</a>' if shown < total else ''
    sections = []
    for date, start, end in [('2026-11-26',0,boundary), ('2026-11-20',boundary,total)]:
        visible = rows[start:min(shown,end)] if shown > start else []
        if visible:
            sections.append(f'<dl id="articles"><h3>{date} (showing {len(visible)} of {end-start} entries)</h3>' + ''.join(visible) + '</dl>')
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"></head>
      <body><main id="dlpage"><h1>Mathematics</h1><h2>Authors and titles for recent submissions</h2>
      {navigation}<div class="paging">Total of {total} entries {complete_link}</div>
      {''.join(sections)}</main></body></html>'''


class FeedBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data = BUNDLE.read_bytes()
        cls.bundle = data.decode('utf-8')
        print('Testing feed userscript SHA-256 ' + hashlib.sha256(data).hexdigest(), file=sys.stderr)
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(headless=True,
            executable_path=optional_browser_path(cls.playwright), args=['--no-sandbox'])
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(service_workers='block')
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.assertEqual(self.errors, [], 'Uncaught browser exceptions')

    def prepare(self, document=None, url=RECENT, seed_records=None):
        documents = {'/list/math/recent':document or recent_document(), '/list/math/new':listing(ROWS)}

        def intercept(route):
            if route.request.is_navigation_request() and urlparse(route.request.url).path in documents:
                route.fulfill(status=200, content_type='text/html; charset=utf-8',
                    body=documents[urlparse(route.request.url).path],
                    headers={'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-src 'none'; object-src 'none'"})
            else:
                route.abort()

        self.context.route('**/*', intercept)
        self.context.add_init_script(script=FEED_GM_MOCK)
        self.context.add_init_script(script=OPEN_TEST_HOSTS)
        self.page.goto(url, wait_until='networkidle')
        if seed_records:
            self.page.evaluate('(records)=>{for(const [key,value] of Object.entries(records))GM_setValue(key,value);}',seed_records)
        self.mount()

    def mount(self):
        self.page.evaluate(CAPTURE_NATIVE)
        self.page.evaluate(self.bundle)
        self.page.wait_for_function("() => fixtureGM.menu.has('Research feeds')")
        self.page.locator('#arxiv-discovery-settings').wait_for(state='attached')

    def reload(self):
        self.page.reload(wait_until='networkidle')
        self.mount()

    @property
    def controls(self):
        return self.page.locator('#ad-listing-controls')

    def close_dialog(self):
        panel = self.page.locator('dialog[open]')
        if panel.count():
            panel.get_by_role('button', name=re.compile('^Close')).click()

    def menu(self):
        self.close_dialog()
        self.page.locator('#arxiv-discovery-settings').get_by_role('button', name='Research feeds', exact=True).click()
        panel = self.page.get_by_role('dialog', name='Research feeds', exact=True)
        expect(panel).to_be_visible()
        return panel

    def open_feed(self, feed):
        panel = self.menu()
        panel.get_by_label('Feed', exact=True).select_option(feed)
        panel.get_by_role('button', name='Open selected feed', exact=True).click()

    def feed_settings(self):
        panel = self.menu()
        panel.get_by_role('button', name='Feed settings', exact=True).click()
        settings = self.page.get_by_role('dialog', name='Feed settings', exact=True)
        expect(settings).to_be_visible()
        return settings

    def store_value(self, suffix, default=None):
        return self.page.evaluate('([key,fallback])=>GM_getValue(key,fallback)', [PREFIX+suffix,default])

    def visible_ids(self):
        return self.page.locator('#dlpage dl > dt:visible').evaluate_all(r'''nodes => nodes.map(node =>
          new URL(node.querySelector('a[href*="/abs/"]').href).pathname.slice(5).replace(/v\d+$/,''))''')

    def observation_file(self, values):
        observed = self.page.evaluate('new Date().toISOString()')
        return {'schemaVersion':1, 'observations':[
            {'paperId':f'2611.{i:05}', 'provider':'openaire', 'metric':'views',
             'status':'positive' if value > 0 else 'zero', 'value':value,
             'match':'exact_identifier','observedAt':observed,
             'sourceUrl':f'https://explore.openaire.eu/search/publication?pid=fixture-{i}'}
            for i,value in enumerate(values,1)
        ]}

    def upload_observations(self, panel, payload):
        panel.get_by_label('Readership observation JSON', exact=True).set_input_files({
            'name':'synthetic-observations.json','mimeType':'application/json',
            'buffer':json.dumps(payload).encode('utf-8')})
        panel.get_by_role('button', name='Import observations', exact=True).click()

    def discovery_settings(self):
        self.close_dialog()
        self.page.locator('#arxiv-discovery-settings').get_by_role('button',name='Discovery settings',exact=True).click()
        panel=self.page.get_by_role('dialog',name='Discovery settings',exact=True)
        expect(panel).to_be_visible()
        return panel

    def configure_highlight_ai(self):
        panel=self.discovery_settings()
        self.page.once('dialog',lambda prompt:prompt.accept(TEST_TOKEN))
        panel.get_by_role('button',name='Pair / replace bridge token',exact=True).click()
        panel.get_by_label('Model',exact=True).fill('fixture-model')
        expect(panel.get_by_label('Local reading profile',exact=True)).to_have_value('quick')
        panel.get_by_label('No Spoilers by default',exact=True).uncheck()
        panel.get_by_label('Enable on-demand AI',exact=True).check()
        panel.get_by_label(re.compile('I authorize this selected provider')).check()
        panel.get_by_role('button',name='Save AI settings',exact=True).click()
        expect(panel.locator('.notice[role=status]')).to_contain_text('saved')
        self.assertFalse(self.store_value('settings')['noSpoilers'])
        self.close_dialog()

    def install_highlight_mock(self,hold=False):
        """Synthetic bridge-boundary responses; no provider inference is run."""
        self.page.evaluate(r'''hold => {
          const original=GM_xmlhttpRequest;
          fixtureGM.highlightPending=[];
          fixtureGM.highlightReply=options=>{
            const body=JSON.parse(options.data),paper=body.paper;
            const url='https://arxiv.org/abs/'+paper.id+(paper.version?'v'+paper.version:'');
            const candidate=paper.id==='2611.00001';
            const citation={label:'Fixture abstract paragraph',url:url+'#abstract',quotes:['A finite sequence $x^2$']};
            const highlight=candidate?{status:'candidate',basis:['method'],
              reason:'Synthetic candidate decision grounded in the fixture quotation.',citations:[citation]}:
              {status:'not_established',basis:[],reason:'Not enough source evidence in this synthetic fixture.',citations:[]};
            const response={text:candidate?'Synthetic candidate assessment.':'The synthetic assessment is inconclusive.',
              source:{kind:'abstract',url,note:'Offline synthetic evidence.',citations:candidate?[citation]:[]},
              highlight,usage:{inputTokens:10,outputTokens:12,estimatedCostUsd:0}};
            options.onload({status:200,responseText:JSON.stringify(response),finalUrl:options.url,responseHeaders:''});
          };
          window.GM_xmlhttpRequest=options=>{
            const body=options.data?JSON.parse(options.data):null;
            if(options.method==='POST'&&options.url==='http://127.0.0.1:4317/v1/explain'&&body?.action==='highlight'){
              fixtureGM.requests.push({url:options.url,method:options.method,body});
              if(hold){fixtureGM.highlightPending.push(options);return {abort:()=>options.onabort()};}
              const timer=setTimeout(()=>fixtureGM.highlightReply(options),0);
              return {abort:()=>{clearTimeout(timer);options.onabort();}};
            }
            return original(options);
          };
        }''',hold)

    def start_highlight_assessment(self,ids):
        self.controls.get_by_role('button',name='Assess selected Recent papers',exact=True).click()
        panel=self.page.get_by_role('dialog',name='Assess potential highlights',exact=True)
        panel.get_by_label('Recent papers to assess',exact=True).select_option(ids)
        panel.get_by_role('button',name='Assess selected papers',exact=True).click()
        return panel

    def test_today_default_and_all_feed_navigation_preserve_native_source_dates(self):
        self.prepare(url=TODAY)
        self.assertEqual(self.page.locator('#ad-listing-controls').count(),0)
        panel=self.menu()
        expect(panel.get_by_label('Feed',exact=True)).to_have_value('today')
        self.assertEqual(panel.get_by_label('Feed',exact=True).locator('option').all_text_contents(),
            ['Today','Trending','Rising','For You','Discovery','Subscriptions','Highlights','Random','Recent','Saved'])
        panel.get_by_label('Feed',exact=True).select_option('recent')
        panel.get_by_role('button',name='Open selected feed',exact=True).click()
        self.page.wait_for_url(re.compile(r'/list/math/recent\?.*#ad-feed=recent$'))
        self.mount()
        expect(self.controls).to_contain_text('Recent · 6 displayed')
        expect(self.controls).to_contain_text('2026-11-26, 2026-11-20')
        self.assertEqual(len(self.visible_ids()),6)
        self.assertEqual(self.store_value('feed-population:recent')['population']['announcementDate'],None)
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))

    def test_fifty_row_source_paginates_to_complete_population_and_survives_offline_restart(self):
        self.prepare(recent_document(total=60,shown=50))
        self.page.evaluate('(html)=>{fixtureGM.network="page";fixtureGM.responseHTML=html;}',recent_document(total=60))
        self.open_feed('recent')
        expect(self.controls).to_contain_text('Recent · 60 displayed')
        self.assertEqual(len(self.visible_ids()),60)
        self.assertEqual(self.page.locator('.ad-fetched-papers > dt').count(),10)
        request=self.page.evaluate('fixtureGM.requests')
        self.assertEqual(len(request),1)
        self.assertIn('/list/math/recent?',request[0]['url'])
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged(true)'))
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertEqual(len(self.visible_ids()),50)
        self.assertEqual(self.page.locator('.ad-fetched-papers').count(),0)
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))
        self.reload()
        self.open_feed('recent')
        expect(self.controls).to_contain_text('Recent · 60 displayed')
        self.assertEqual(self.page.evaluate('fixtureGM.requests'),[])
        self.assertEqual(self.store_value('feed-population:recent')['population']['distinctTotal'],60)

    def test_insufficient_popularity_is_explicit_and_other_feeds_remain_usable(self):
        self.prepare()
        self.open_feed('trending')
        expect(self.controls).to_contain_text('Insufficient readership data to establish a meaningful trending ranking.')
        expect(self.controls).to_contain_text('Readership statistics available for 0 of 6 recent papers')
        self.assertEqual(self.visible_ids(),[])
        self.open_feed('rising')
        expect(self.controls).to_contain_text('Insufficient comparable historical data to establish a meaningful rising ranking.')
        self.assertEqual(self.visible_ids(),[])
        self.open_feed('random')
        expect(self.controls).to_contain_text('Random · 6 displayed')
        self.assertEqual(len(self.visible_ids()),6)
        self.assertEqual(self.page.evaluate('fixtureGM.requests'),[])

    def test_expired_native_page_and_cached_population_are_refetched_before_timestamp_changes(self):
        self.prepare()
        self.page.evaluate('''html => {
          const actualNow=Date.now.bind(Date); fixtureGM.clockOffset=61*60000;
          Date.now=()=>actualNow()+fixtureGM.clockOffset;
          fixtureGM.network='page';fixtureGM.responseHTML=html;
        }''',recent_document())
        self.assertIsNone(self.store_value('feed-population:recent'))
        self.open_feed('recent')
        expect(self.controls).to_contain_text('Recent · 6 displayed')
        first=self.store_value('feed-population:recent')['savedAt']
        requests=self.page.evaluate('fixtureGM.requests')
        self.assertEqual(len(requests),1,'An expired complete native page must be fetched, not restamped.')
        self.assertIn('/list/math/recent?',requests[0]['url'])
        self.assertIn('skip=0',requests[0]['url'])
        self.page.evaluate('fixtureGM.clockOffset+=61*60000')
        self.open_feed('recent')
        expect(self.controls).to_contain_text('Recent · 6 displayed')
        requests=self.page.evaluate('fixtureGM.requests')
        self.assertEqual(len(requests),2,'Expired memory and private caches must trigger another first-page request.')
        self.assertGreaterEqual(self.store_value('feed-population:recent')['savedAt']-first,61*60000)
        self.assertEqual(len(self.visible_ids()),6)

    def test_cancelled_pagination_cannot_apply_or_cache_a_new_cycle_or_navigate(self):
        self.prepare(recent_document(total=60,shown=50))
        self.page.evaluate('''() => {
          const original=GM_xmlhttpRequest;
          fixtureGM.pending=[];
          window.GM_xmlhttpRequest=options=>{
            if(options.url.startsWith('https://arxiv.org/list/math/recent?')){
              fixtureGM.requests.push({url:options.url,method:options.method});
              fixtureGM.pending.push(options);
              return {abort:()=>options.onabort()};
            }
            return original(options);
          };
        }''')
        self.open_feed('recent')
        self.page.wait_for_function('()=>fixtureGM.pending.length===1')
        expect(self.controls).to_contain_text('Loading Recent')
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertEqual(len(self.visible_ids()),50)
        self.assertIsNone(self.store_value('feed-population:recent'))
        self.page.evaluate('''async html => {
          fixtureGM.writesAfterCancellation=[];
          const save=GM_setValue;
          window.GM_setValue=(key,value)=>{fixtureGM.writesAfterCancellation.push(key);return save(key,value);};
          const request=fixtureGM.pending.shift();
          request.onload({status:200,responseText:html,finalUrl:request.url,responseHeaders:''});
          await navigator.locks.request('arxiv-discovery-network',async()=>{});
          await navigator.locks.request('arxiv-discovery-private-storage-v1',async()=>{});
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }''',recent_document(total=60).replace('2026-11-26','2026-11-27'))
        expect(self.page).to_have_url(RECENT)
        self.assertEqual(self.page.locator('#ad-listing-controls').count(),0)
        self.assertEqual(self.page.locator('.ad-fetched-papers').count(),0)
        self.assertEqual(len(self.visible_ids()),50)
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))
        self.assertIsNone(self.store_value('feed-population:recent'))
        self.assertEqual(self.page.evaluate('fixtureGM.writesAfterCancellation'),[])

    def test_saved_old_paper_reading_and_settings_survive_restart_without_native_mutation(self):
        self.prepare()
        self.page.locator('#ad-paper-2611-00001').get_by_role('button',name='Like',exact=True).click()
        self.page.wait_for_function("()=>GM_listValues().some(key=>key.includes(':events:'))")
        self.page.evaluate('''() => {
          const id='2401.00001', paper=structuredClone(GM_getValue('arxiv-discovery:v1:papers:2611.00001'));
          Object.assign(paper,{id,version:1,versionedId:id+'v1',title:'Older saved mathematics',announcementDate:'2024-01-03'});
          paper.links={abstract:'https://arxiv.org/abs/'+id+'v1',pdf:'https://arxiv.org/pdf/'+id+'v1',html:null};
          GM_setValue('arxiv-discovery:v1:papers:'+id,paper);
          GM_setValue('arxiv-discovery:v1:bookmarks:'+id,new Date().toISOString());
          GM_setValue('arxiv-discovery:v1:reading:'+id,new Date().toISOString());
        }''')
        self.reload()
        self.open_feed('saved')
        expect(self.controls).to_contain_text('Saved · 1 displayed')
        self.assertEqual(self.visible_ids(),['2401.00001'])
        expect(self.page.locator('#ad-paper-2401-00001')).to_contain_text('Read · 2024-01-03')
        settings=self.feed_settings()
        settings.get_by_label('Search titles, abstracts and authors',exact=True).fill('Older saved')
        settings.get_by_label('Maximum displayed papers',exact=True).fill('2')
        settings.get_by_role('button',name='Save feed settings',exact=True).click()
        expect(self.controls).to_contain_text('Saved · 1 displayed')
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))
        self.assertEqual(self.page.locator('.ad-fetched-papers').count(),0)
        self.reload()
        self.assertEqual(self.store_value('settings')['feeds']['search'],'Older saved')
        self.assertEqual(self.store_value('settings')['feeds']['maxDisplayed'],2)
        self.assertTrue(self.store_value('bookmarks:2401.00001'))
        self.assertTrue(self.store_value('reading:2401.00001'))
        self.assertEqual(self.page.evaluate("GM_listValues().filter(key=>key.includes(':events:')).length"),1)
        self.open_feed('saved')
        expect(self.controls).to_contain_text('Saved · 1 displayed')

    def test_legacy_bookmark_keeps_rich_version_snapshot_when_recent_has_unknown_version(self):
        paper_id='2611.00001'
        legacy={
            'id':paper_id,'version':2,'versionedId':paper_id+'v2',
            'title':'Saved version two title',
            'abstract':'Saved version two complete abstract about compact operators.',
            'comments':'Saved version two comments: 42 pages and two appendices.',
            'journalRef':'Synthetic saved journal reference',
            'authors':[{'name':'Alex Doe','url':'https://arxiv.org/search/math?searchtype=author&query=Doe','stableId':None}],
            'categories':['math.LO'],'primaryCategory':'math.LO',
            'announcementDate':'2026-11-20','section':'replacement',
            'links':{'abstract':'https://arxiv.org/abs/'+paper_id+'v2',
                     'pdf':'https://arxiv.org/pdf/'+paper_id+'v2',
                     'html':'https://arxiv.org/html/'+paper_id+'v2'},
        }
        original_first=row(1,'math.LO',first=True)
        sparse_first=re.sub(r'\s*<p class="mathjax">.*?</p>','',
            original_first.replace(paper_id+'v1',paper_id),count=1,flags=re.S)
        document=recent_document().replace(original_first,sparse_first,1)
        self.prepare(document,seed_records={PREFIX+'schema':1,
            PREFIX+'papers:'+paper_id:legacy,
            PREFIX+'bookmarks:'+paper_id:'2026-11-20T00:00:00.000Z'})
        # This models an existing installation: no savedPapers key was seeded.
        snapshot=self.store_value('savedPapers:'+paper_id)
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot['version'],2)
        self.assertEqual(snapshot['abstract'],legacy['abstract'])
        self.assertEqual(snapshot['comments'],legacy['comments'])
        canonical=self.store_value('papers:'+paper_id)
        self.assertEqual(canonical['version'],0)
        self.assertEqual(canonical['abstract'],'')
        live_actions=self.page.locator('#ad-paper-2611-00001 .actions')
        self.assertEqual(live_actions.evaluate('node=>node._paper.version'),0)
        self.assertEqual(live_actions.evaluate('node=>node._paper.abstract'),'')
        self.open_feed('saved')
        expect(self.controls).to_contain_text('Saved · 1 displayed')
        self.assertEqual(self.visible_ids(),[paper_id])
        saved_rows=self.page.locator('.ad-fetched-papers')
        expect(saved_rows.locator('.list-title')).to_contain_text(legacy['title'])
        expect(saved_rows.locator('p.mathjax')).to_have_text(legacy['abstract'])
        expect(saved_rows.locator('.list-comments')).to_contain_text(legacy['comments'])
        expect(saved_rows.locator('.list-journal-ref')).to_contain_text(legacy['journalRef'])
        expect(saved_rows.locator('dt a[href*="/abs/"]')).to_have_attribute('href',legacy['links']['abstract'])
        expect(saved_rows.locator('dt a[href*="/pdf/"]')).to_have_attribute('href',legacy['links']['pdf'])
        expect(saved_rows.locator('dt a[href*="/html/"]')).to_have_attribute('href',legacy['links']['html'])
        saved_actions=saved_rows.locator('.actions')
        self.assertEqual(saved_actions.evaluate('node=>node._paper.version'),2)
        self.assertEqual(saved_actions.evaluate('node=>node._paper.comments'),legacy['comments'])
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged(true)'))
        saved_rows.get_by_role('button',name='Mark as read',exact=True).click()
        expect(saved_rows.get_by_role('button',name='Read',exact=True)).to_be_visible()
        self.assertTrue(self.store_value('reading:'+paper_id))
        self.assertEqual(self.store_value('papers:'+paper_id),canonical,
            'Mark as read in Saved must not replace canonical live metadata with the saved version.')
        saved_rows.get_by_role('button',name='Bookmarked',exact=True).click()
        expect(saved_rows.get_by_role('button',name='Bookmark',exact=True)).to_be_visible()
        self.assertIsNone(self.store_value('bookmarks:'+paper_id))
        self.assertIsNone(self.store_value('savedPapers:'+paper_id))
        self.assertEqual(self.store_value('papers:'+paper_id),canonical)
        saved_rows.get_by_role('button',name='Bookmark',exact=True).click()
        expect(saved_rows.get_by_role('button',name='Bookmarked',exact=True)).to_be_visible()
        self.assertTrue(self.store_value('bookmarks:'+paper_id))
        self.assertEqual(self.store_value('savedPapers:'+paper_id),snapshot,
            'Rebookmarking the displayed saved row must retain its rich version-two snapshot.')
        self.assertEqual(self.store_value('papers:'+paper_id),canonical,
            'Bookmarking from Saved must leave canonical live metadata unchanged.')
        self.assertEqual(saved_rows.locator('.actions').evaluate('node=>node._paper.version'),2)
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))
        self.assertEqual(self.page.locator('.ad-fetched-papers').count(),0)
        native=self.page.locator('dl[id="articles"] > dd').first
        expect(native.locator('.list-title')).to_contain_text('Compactness and literal <em>notation</em>')
        self.assertEqual(native.locator('.actions').evaluate('node=>node._paper.version'),0)
        self.assertEqual(native.locator('.actions').evaluate('node=>node._paper.abstract'),'')
        expect(self.page.locator('dl[id="articles"] > dt').first.locator('a[title="Abstract"]')).to_have_attribute('href','/abs/'+paper_id)
        self.assertEqual(self.store_value('papers:'+paper_id),canonical)
        self.reload()
        self.assertEqual(self.store_value('savedPapers:'+paper_id)['comments'],legacy['comments'])
        self.assertEqual(self.store_value('savedPapers:'+paper_id)['version'],2)
        self.open_feed('saved')
        expect(self.controls).to_contain_text('Saved · 1 displayed')
        expect(self.page.locator('.ad-fetched-papers p.mathjax')).to_have_text(legacy['abstract'])
        expect(self.page.locator('.ad-fetched-papers .list-comments')).to_contain_text(legacy['comments'])
        expect(self.page.locator('.ad-fetched-papers .list-journal-ref')).to_contain_text(legacy['journalRef'])
        expect(self.page.locator('.ad-fetched-papers').get_by_role('button',name='Read',exact=True)).to_be_visible()
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))
        self.assertEqual(native.locator('.actions').evaluate('node=>node._paper.version'),0)
        # The legacy dialog renders the saved version but must refresh actions
        # using the version of the native row that is currently displayed.
        self.page.evaluate("()=>fixtureGM.menu.get('Bookmarks and reading')()")
        bookmarks=self.page.get_by_role('dialog',name='Bookmarks and reading',exact=True)
        expect(bookmarks).to_contain_text(legacy['title'])
        bookmarks.get_by_role('button',name='Remove bookmark',exact=True).click()
        expect(bookmarks).to_contain_text('0 bookmarked papers')
        self.close_dialog()
        self.assertIsNone(self.store_value('bookmarks:'+paper_id))
        self.assertIsNone(self.store_value('savedPapers:'+paper_id))
        self.assertEqual(self.store_value('papers:'+paper_id),canonical)
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))
        self.assertEqual(native.locator('.actions').evaluate('node=>node._paper.version'),0)
        self.assertEqual(native.locator('.actions').evaluate('node=>node._paper.abstract'),'')
        expect(native.get_by_role('button',name='Bookmark',exact=True)).to_be_visible()
        self.reload()
        self.assertIsNone(self.store_value('bookmarks:'+paper_id))
        self.assertIsNone(self.store_value('savedPapers:'+paper_id))
        self.assertEqual(self.store_value('papers:'+paper_id),canonical)
        self.assertTrue(self.store_value('reading:'+paper_id))
        self.open_feed('saved')
        expect(self.controls).to_contain_text('Saved · 0 displayed')

    def test_invalid_observation_import_is_atomic_and_cannot_fabricate_activity(self):
        self.prepare()
        panel=self.feed_settings()
        invalid=self.observation_file([1,2,3,4,0,0])
        invalid['observations'][2]['value']=-3
        self.upload_observations(panel,invalid)
        expect(panel).to_contain_text('Invalid readership metric value.')
        self.assertIsNone(self.store_value('external-readership'))
        self.close_dialog()
        self.open_feed('trending')
        expect(self.controls).to_contain_text('Readership statistics available for 0 of 6 recent papers')
        self.assertEqual(self.visible_ids(),[])

    def test_imported_metric_ties_filters_keyboard_order_and_coverage_use_the_full_population(self):
        self.prepare()
        panel=self.feed_settings()
        self.upload_observations(panel,self.observation_file([0,10,4,10,2,0]))
        expect(panel).to_contain_text('6 retained external observations.')
        panel.get_by_label('Provider and metric',exact=True).select_option('openaire:views')
        panel.get_by_role('button',name='Save feed settings',exact=True).click()
        self.close_dialog()
        self.open_feed('trending')
        expect(self.controls).to_contain_text('Trending · 6 displayed')
        expect(self.controls).to_contain_text('Readership statistics available for 6 of 6 recent papers; 4 have positive activity.')
        self.controls.get_by_text('Feed order',exact=True).click()
        order=self.controls.locator('.feed-index ol button').all_text_contents()
        self.assertEqual(order[:4],['Rank 1 · 2611.00002','Rank 1 · 2611.00004','Rank 3 · 2611.00003','Rank 4 · 2611.00005'])
        self.assertEqual(self.visible_ids(),[f'2611.{i:05}' for i in range(1,7)])
        self.page.keyboard.press('Alt+j')
        self.assertTrue(self.page.evaluate("document.activeElement.href.endsWith('/abs/2611.00002v1')"))
        self.page.keyboard.press('Alt+j')
        self.assertTrue(self.page.evaluate("document.activeElement.href.endsWith('/abs/2611.00004v1')"))
        settings=self.feed_settings()
        settings.get_by_label('Mathematical categories',exact=True).select_option(['math.LO'])
        settings.get_by_role('button',name='Save feed settings',exact=True).click()
        expect(self.controls).to_contain_text('Trending · 2 displayed')
        expect(self.controls).to_contain_text('Readership statistics available for 6 of 6 recent papers; 4 have positive activity.')
        self.controls.get_by_text('Feed order',exact=True).click()
        self.assertEqual(self.controls.locator('.feed-index ol button').all_text_contents(),
            ['Rank 1 · 2611.00002','Rank 5 · 2611.00001'])
        self.assertEqual(self.visible_ids(),['2611.00001','2611.00002'])
        self.open_feed('rising')
        expect(self.controls).to_contain_text('no independently verified cumulative readership counter')
        self.assertEqual(self.visible_ids(),[])

    def test_explicit_highlight_candidate_uses_full_action_and_inconclusive_history_stays_separate(self):
        self.prepare()
        self.configure_highlight_ai()
        self.install_highlight_mock()
        self.open_feed('highlights')
        expect(self.controls).to_contain_text('Highlights · 0 displayed')
        self.start_highlight_assessment(['2611.00001'])
        expect(self.controls).to_contain_text('Highlights · 1 displayed')
        self.assertEqual(self.visible_ids(),['2611.00001'])
        requests=self.page.evaluate('fixtureGM.requests')
        self.assertEqual(len(requests),1)
        self.assertEqual(requests[0]['body']['action'],'highlight')
        self.assertEqual(requests[0]['body']['profile'],'full')
        self.assertFalse(requests[0]['body']['noSpoilers'])
        self.assertEqual(requests[0]['body']['paper']['id'],'2611.00001')
        candidate=self.store_value('highlights:2611.00001')
        self.assertEqual(candidate['highlight']['status'],'candidate')
        self.assertEqual(candidate['highlight']['citations'],candidate['source']['citations'])
        tools=self.page.locator('#ad-paper-2611-00001')
        tools.get_by_text('AI assessment and evidence',exact=True).click()
        expect(tools.get_by_role('link',name='Fixture abstract paragraph',exact=True)).to_have_attribute('href',
            'https://arxiv.org/abs/2611.00001v1#abstract')
        expect(tools).to_contain_text('A finite sequence $x^2$')
        expect(tools).to_contain_text('author claims unverified')
        self.start_highlight_assessment(['2611.00002'])
        # The second explicit request obeys the real shared 15-second pacing queue.
        self.page.wait_for_function('()=>GM_getValue("arxiv-discovery:v1:highlights:2611.00002",null)!==null',timeout=25000)
        expect(self.controls).to_contain_text('Highlights · 1 displayed')
        self.assertEqual(self.visible_ids(),['2611.00001'])
        self.assertEqual(self.store_value('highlights:2611.00002')['highlight']['status'],'not_established')
        self.assertEqual(self.page.evaluate('fixtureGM.requests.length'),2)
        self.controls.get_by_role('button',name='Assess selected Recent papers',exact=True).click()
        history=self.page.get_by_role('dialog',name='Assess potential highlights',exact=True)
        history.get_by_text('1 inconclusive assessment(s)',exact=True).click()
        expect(history).to_contain_text('Not enough source evidence in this synthetic fixture.')
        self.close_dialog()
        settings=self.discovery_settings()
        settings.get_by_label('No Spoilers by default',exact=True).check()
        expect(self.controls).to_contain_text('Highlights · 0 displayed')
        self.assertEqual(self.visible_ids(),[])
        self.assertEqual(self.store_value('highlights:2611.00001')['highlight']['status'],'candidate')
        settings.get_by_label('No Spoilers by default',exact=True).uncheck()
        expect(self.controls).to_contain_text('Highlights · 1 displayed')
        self.close_dialog()
        self.assertEqual(tools.locator('.feed-note').count(),1)
        self.controls.get_by_role('button',name='Show all papers',exact=True).click()
        self.assertEqual(self.page.locator('.feed-note').count(),0)
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged()'))

    def test_closing_pending_highlight_batch_and_switching_view_stops_remaining_requests_and_writes(self):
        self.prepare()
        self.configure_highlight_ai()
        self.install_highlight_mock(hold=True)
        settings=self.feed_settings()
        settings.get_by_label('Maximum papers per explicit AI assessment batch',exact=True).fill('2')
        settings.get_by_role('button',name='Save feed settings',exact=True).click()
        self.close_dialog()
        self.open_feed('highlights')
        expect(self.controls).to_contain_text('Highlights · 0 displayed')
        self.start_highlight_assessment(['2611.00001','2611.00002'])
        self.page.wait_for_function('()=>fixtureGM.highlightPending.length===1')
        self.close_dialog()
        self.open_feed('recent')
        expect(self.controls).to_contain_text('Recent · 6 displayed')
        self.page.evaluate('''async () => {
          fixtureGM.highlightReply(fixtureGM.highlightPending.shift());
          await navigator.locks.request('arxiv-discovery-network',async()=>{});
          await navigator.locks.request('arxiv-discovery-private-storage-v1',async()=>{});
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        }''')
        expect(self.controls).to_contain_text('Recent · 6 displayed')
        self.assertEqual(self.page.locator('dialog[open]').count(),0)
        self.assertEqual(len(self.visible_ids()),6)
        self.assertEqual(self.page.evaluate('fixtureGM.requests.length'),1)
        self.assertEqual(self.page.evaluate('fixtureGM.highlightPending.length'),0)
        self.assertEqual(self.page.evaluate('GM_listValues().filter(key=>key.includes(":highlights:"))'),[])
        self.assertTrue(self.page.evaluate('fixtureNativeUnchanged(true)'))


if __name__ == '__main__':
    unittest.main(verbosity=2)

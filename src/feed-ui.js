import {FEEDS, buildFeed} from './feeds.js';
import {CATEGORIES} from './categories.js';
import {parseListing} from './parser.js';
import {loadCompleteListing} from './network.js';
import {gmRequest} from './transport.js';
import {METRIC_DEFINITIONS} from './readership.js';
import {element, link, field, select, checkbox, richText} from './dom.js';
import {downloadText, bookmarksBibtex} from './exports.js';
import {makeId} from './storage.js';
import {mergePaperMetadata} from './schema.js';
import {mathFragment} from './math.js';

const LABEL = Object.fromEntries(FEEDS);
const RECENT_URL = 'https://arxiv.org/list/math/recent?skip=0&show=2000';
const TODAY_URL = 'https://arxiv.org/list/math/new?skip=0&show=2000';
const instant = value => new Date(value).toISOString();

function parseHTML(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function sameCycle(a,b) {
  if (!a || !b || a.population !== b.population || a.advertisedTotal !== b.advertisedTotal || a.cohortSignature !== b.cohortSignature) return false;
  const rows = new Map((b.sourceEntries || []).map(row => [row.index,row]));
  return (a.sourceEntries || []).every(row => {
    const other = rows.get(row.index);
    return other && row.paperId === other.paperId && row.announcementDate === other.announcementDate && row.version === other.version;
  });
}

// This controller adds controls and safely constructed missing native rows only
// after a deliberate feed selection. Existing arXiv elements are never replaced.
export class FeedController {
  constructor(app) {
    this.app = app; this.active = null; this.result = null; this.population = null;
    this.added = []; this.addedIds = new Set(); this.seed = makeId(); this.cacheInfo = null;
    this.pageObservedAt = Date.now(); this.initialAvailable = true;
    this.replacedNative = new Map(); this.liveMetadata = new Map();
  }

  async resume() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const requested = hash.get('ad-feed');
    if (requested && LABEL[requested]) return this.open(requested);
    const preferred = this.app.state.settings.feeds.landing;
    if (!location.hash && location.pathname === '/list/math/new' && preferred !== 'today' && this.app.toolsEnabled()) return this.open(preferred);
  }

  navigate(feed) {
    const url = new URL(feed === 'today' ? TODAY_URL : RECENT_URL);
    url.hash = 'ad-feed=' + feed;
    location.assign(url.href);
  }

  openMenu() {
    const app = this.app, body = app.panel('Research feeds','feeds');
    const choice = select(FEEDS,this.active || app.state.settings.feeds.landing);
    body.append(field('Feed',choice),app.button('Open selected feed',() => this.open(choice.value)),
      app.button('Feed settings',() => this.openSettings()),
      element('p',{class:'muted'},'Today uses arXiv’s latest announcement. Recent-based feeds use every page of the official Recent listing. Saved includes papers from any date.'));
    body.append(element('dl',{},FEEDS.map(([id,label]) => [element('dt',{},label),element('dd',{}, {
      today:'The saved daily selection and its existing recommendation mode.',
      trending:'Observed external readership or attention, with coverage and freshness checks.',
      rising:'Growth only when comparable cumulative measurements support it.',
      'for-you':'The existing local interest model applied to Recent.',
      discovery:'Unfamiliar categories, concepts and author labels.',
      subscriptions:'Recent papers matching confirmed followed researchers.',
      highlights:'On-demand AI assessments with source evidence; significance remains unverified.',
      random:'Preference-independent random sampling from Recent.',
      recent:'The complete chronological source population.',
      saved:'All locally bookmarked papers, with search, filters and export.'
    }[id])])));
  }

  clear() {
    const app = this.app;
    this.active = null; this.result = null;
    for (const tools of app.paperTools.values()) for (const note of tools.root.querySelectorAll('.feed-note')) note.remove();
    for (const id of this.addedIds) {
      const tools = app.paperTools.get(id);
      if (tools) { app.removeHost(tools.host); app.paperTools.delete(id); }
      app.paperNodes.delete(id);
      app.inlineAI.get(id)?.remove(); app.inlineAI.delete(id);
    }
    for (const node of this.added) node.remove();
    this.added = []; this.addedIds.clear();
    for (const [id,nodes] of this.replacedNative) app.paperNodes.set(id,nodes);
    for (const [id,paper] of this.liveMetadata) if (paper) app.state.papers[id] = paper;
    const replaced = this.replacedNative.size;
    this.replacedNative.clear(); this.liveMetadata.clear();
    if (replaced && app.mounted && app.toolsEnabled()) app.attachPaperTools();
  }

  feedbackMode() { return this.active && this.active !== 'today' ? this.active : this.app.state.settings.mode; }
  visibleIds() {
    const visible = new Set(this.app.nativeListing.visibleIds());
    return this.result ? this.result.entries.map(entry => entry.paperId).filter(id => visible.has(id)) : [...visible];
  }

  async getPopulation(refresh, progress, generation, isCurrent = () => true) {
    const app = this.app, maxAge = app.state.settings.feeds.refreshMinutes * 60000;
    const initial = app.listing;
    const assertCurrent = () => { if (!isCurrent()) throw new Error('Feed request cancelled.'); };
    assertCurrent();
    if (!refresh && this.population && sameCycle(initial,this.population) && this.cacheInfo && !this.cacheInfo.stale && Date.now()-this.cacheInfo.savedAt < maxAge) return this.population;
    if (!refresh && this.initialAvailable && Date.now()-this.pageObservedAt < maxAge && initial?.population === 'recent' && initial.complete) {
      this.initialAvailable = false;
      const cachedInitial = await app.store.cacheFeedPopulation(initial,generation,this.pageObservedAt);
      assertCurrent(); this.population = initial; this.cacheInfo = cachedInitial;
      if (!this.cacheInfo) throw new Error('Saved data changed during loading.');
      return initial;
    }
    const cached = await app.store.feedPopulation('recent',maxAge);
    assertCurrent();
    if (!refresh && cached && !cached.stale && sameCycle(initial,cached.population)) {
      this.population = cached.population; this.cacheInfo = cached; return this.population;
    }
    let start = initial;
    try {
      if (refresh || initial?.population !== 'recent' || initial.complete || Date.now()-this.pageObservedAt >= maxAge) {
        const response = await gmRequest(RECENT_URL);
        assertCurrent();
        if (response.status !== 200) throw new Error('arXiv returned HTTP ' + response.status + '.');
        if (typeof response.text !== 'string' || response.text.length > 32*1024*1024) throw new Error('The listing response exceeds the supported size.');
        start = parseListing(parseHTML(response.text),RECENT_URL);
      }
      const complete = await loadCompleteListing(start,{request:async (url,options) => {assertCurrent();const response=await gmRequest(url,options);assertCurrent();return response;},onProgress:progress});
      assertCurrent();
      if (!complete.complete) throw new Error(complete.warnings.join(' '));
      // A live refresh can cross an announcement boundary. Navigate rather than
      // mix current native rows with a different source snapshot.
      if (!sameCycle(initial,complete)) {
        this.navigate(this.active || 'recent');
        throw new Error('The arXiv announcement population changed. Reloading its native listing.');
      }
      const cachedComplete = await app.store.cacheFeedPopulation(complete,generation);
      assertCurrent(); this.population = complete; this.cacheInfo = cachedComplete;
      if (!this.cacheInfo) throw new Error('Saved data changed during loading.');
      return complete;
    } catch (error) {
      assertCurrent();
      if (cached && sameCycle(initial,cached.population)) {
        this.population = cached.population; this.cacheInfo = {...cached,offline:true,stale:true,error:error.message};
        return this.population;
      }
      throw error;
    }
  }

  async open(feed, {refresh = false, regenerate = false} = {}) {
    const app = this.app;
    if (!LABEL[feed]) throw new Error('Unknown feed.');
    if (!app.toolsEnabled()) await app.show();
    if (feed === 'today') {
      if (location.pathname !== '/list/math/new') return this.navigate(feed);
      return app.openDaily();
    }
    if (!app.listing || feed !== 'saved' && (location.pathname !== '/list/math/recent' || Number(new URL(location.href).searchParams.get('skip') || 0) !== 0)) return this.navigate(feed);
    app.closePanel(); app.showAllPapers();
    const epoch = app.viewEpoch, generation = await app.store.generation();
    if (epoch !== app.viewEpoch || !app.mounted || !app.toolsEnabled()) return;
    this.active = feed; if (regenerate) this.seed = makeId();
    const root = app.listingControls();
    const status = element('p',{class:'feed-status',role:'status','aria-live':'polite'},'Loading ' + LABEL[feed] + '…');
    root.append(status,app.button('Show all papers',() => app.showAllPapers()));
    const current = () => epoch === app.viewEpoch && app.mounted && this.active === feed;
    try {
      const population = feed === 'saved' ? null : await this.getPopulation(refresh, info => {
        if (current()) status.textContent = 'Retrieving the complete Recent population… ' + (info?.papers?.length || info?.received || '') ;
      },generation,current);
      if (!current() || generation !== await app.store.generation()) return;
      const observations = ['trending','rising'].includes(feed) ? await app.store.readership() : [];
      if (!current() || generation !== await app.store.generation()) return;
      const result = buildFeed(feed,population,app.state,{model:app.model,observations,seed:this.seed});
      if (['trending','rising'].includes(feed) && this.cacheInfo?.stale) {
        result.available = false; result.entries = [];
        result.reasons = [...(result.reasons || []),'The cached population is stale. Refresh the complete Recent listing before establishing a current popularity ranking.'];
      }
      // Keep known richer metadata when Recent omits the abstract for the same
      // paper title. The feed's source dates and identifiers remain authoritative.
      for (const p of result.papers) {
        const old = app.state.papers[p.id];
        if (feed === 'saved') this.liveMetadata.set(p.id,old);
        app.state.papers[p.id] = feed === 'saved' ? p : mergePaperMetadata(old,p);
      }
      this.result = result;
      this.render(root,result);
    } catch (error) {
      if (!current()) return;
      status.textContent = 'Unable to load ' + LABEL[feed] + ': ' + error.message;
      root.append(app.button('Try again',() => this.open(feed,{refresh:true})),
        link('Open the official Recent listing','https://arxiv.org/list/math/recent'));
    }
  }

  appendMissing(entries) {
    const app = this.app, missing = entries.filter(e => !app.paperNodes.has(e.paperId));
    if (!missing.length) return;
    const container = element('dl',{'data-arxiv-discovery':'true',class:'ad-fetched-papers'});
    let date = null;
    for (const entry of missing) {
      const p = app.state.papers[entry.paperId]; if (!p) continue;
      if (date !== p.announcementDate) {
        date = p.announcementDate;
        container.append(element('h3',{},date || 'Saved papers without an announcement date'));
      }
      const dt = element('dt',{},link('arXiv:' + p.versionedId,p.links.abstract),' [',link('pdf',p.links.pdf),p.links.html ? [', ',link('html',p.links.html)] : null,']');
      const dd = element('dd',{},element('div',{class:'meta'},
        element('div',{class:'list-title mathjax'},element('span',{class:'descriptor'},'Title: '),richText(p,'title')),
        element('div',{class:'list-authors'},element('span',{class:'descriptor'},'Authors: '),p.authors.map((a,i) => [i ? ', ' : '',a.url ? link(a.name,a.url) : a.name])),
        element('div',{class:'list-subjects'},element('span',{class:'descriptor'},'Subjects: '),p.categories.join('; ')),
        p.comments ? element('div',{class:'list-comments'},element('span',{class:'descriptor'},'Comments: '),richText(p,'comments')) : null,
        p.journalRef ? element('div',{class:'list-journal-ref'},element('span',{class:'descriptor'},'Journal reference: '),richText(p,'journalRef')) : null,
        p.abstract ? element('p',{class:'mathjax'},richText(p,'abstract')) : null));
      container.append(dt,dd); app.paperNodes.set(p.id,{dt,dd}); this.addedIds.add(p.id);
    }
    const target = document.querySelector('#dlpage');
    target.append(container); this.added.push(container);
    for (const id of this.addedIds) if (!app.paperTools.has(id)) app.addPaperTools(id,app.paperNodes.get(id).dd);
  }

  render(root,result) {
    const app = this.app, feed = result.feed;
    for (const node of [...root.children]) if (node.tagName !== 'STYLE') node.remove();
    for (const tools of app.paperTools.values()) for (const note of tools.root.querySelectorAll('.feed-note')) note.remove();
    if (feed === 'saved') {
      // Saved may refer to a different version from the native page. Keep its
      // original metadata in a removable row instead of attaching old-version
      // controls to a newly announced paper's native title and abstract.
      app.nativeListing.apply([]);
      for (const entry of result.entries) {
        const id = entry.paperId, nodes = app.paperNodes.get(id);
        if (!nodes || this.addedIds.has(id)) continue;
        this.replacedNative.set(id,nodes);
        const tools = app.paperTools.get(id);
        if (tools) {app.removeHost(tools.host);app.paperTools.delete(id);}
        app.paperNodes.delete(id);
      }
    }
    this.appendMissing(result.entries);
    app.nativeListing.apply(result.entries.map(entry => entry.paperId));
    app.listView = 'feed';
    const count = `${result.entries.length} displayed${result.truncated ? ' of ' + result.filteredCount + ' matches' : ''}`;
    root.append(element('p',{class:'listing-summary feed-status',role:'status'},`${LABEL[feed]} · ${count} · ${result.label || ''}`),
      element('div',{class:'row'},app.button('Choose feed',() => this.openMenu()),app.button('Feed settings',() => this.openSettings()),
        app.button('Refresh feed',() => this.open(feed,{refresh:feed !== 'saved'})),
        ['random','discovery','for-you'].includes(feed) ? app.button('New draw',() => this.open(feed,{regenerate:true})) : null,
        app.button('Show all papers',() => app.showAllPapers())));
    if (feed !== 'saved' && this.population) {
      root.append(element('p',{class:'muted'},`${this.population.papers.length} distinct papers in the complete Recent source · ${(this.population.announcementDates || []).join(', ')}. Source retrieved ${instant(this.cacheInfo.savedAt)}.`));
      if (this.cacheInfo?.offline) root.append(element('p',{class:'notice'},'Offline cached snapshot. Current source membership has not been reverified. ' + this.cacheInfo.error));
    }
    if (result.unknownSections) root.append(element('p',{class:'muted'},'The source does not label submission type for ' + result.unknownSections + ' papers. Unknown types remain eligible unless explicitly filtered.'));
    if (result.coverage) {
      const c = result.coverage;
      root.append(element('p',{class:'readership-coverage'},`Readership statistics available for ${c.measured} of ${c.total} recent papers; ${c.positive} have positive activity. Coverage is evaluated before display filters.`));
      const rows = Object.entries(c.outcomes || {}).filter(([,n]) => n);
      root.append(element('details',{},element('summary',{},'Coverage and availability'),element('ul',{},rows.map(([name,n]) => element('li',{},`${name.replaceAll('_',' ')}: ${n}`))),
        element('p',{},'A retrieval timestamp states when the observation was collected. Provider update time and underlying metric freshness may remain unknown.')));
    }
    if (!result.available) root.append(element('p',{class:'notice'},feed === 'trending' ? 'Insufficient readership data to establish a meaningful trending ranking.' : feed === 'rising' ? 'Insufficient comparable historical data to establish a meaningful rising ranking.' : 'No qualifying highlight candidates are available.'),
      element('ul',{},(result.reasons || []).map(reason => element('li',{},reason))));
    else if (!result.entries.length) root.append(element('p',{class:'notice'},'No papers match these feed filters.'));
    if (feed === 'highlights') root.append(element('p',{class:'notice'},'These are AI assessments grounded in paper passages. Claims and significance have not been independently verified. No automatic bulk AI analysis runs.'),
      app.button('Assess selected Recent papers',() => this.openHighlights()));
    if (feed === 'saved') root.append(app.button('Export bookmarks (BibTeX)',() => downloadText('arxiv-bookmarks.bib',bookmarksBibtex(app.state),'application/x-bibtex')));
    if (result.entries.length) {
      root.append(element('p',{class:'muted'},'Native arXiv rows keep their original order. The feed index and Alt+J / Alt+K follow feed order.'),
        element('details',{class:'feed-index'},element('summary',{},'Feed order'),element('ol',{},result.entries.map((entry,index) => element('li',{},
          app.button(`${entry.rank ? 'Rank ' + entry.rank + ' · ' : ''}${entry.paperId}`,() => app.focusPaper(entry.paperId)),
          index === 0 && result.truncated ? ' (display limit applies)' : null)))));
    }
    for (const [index,entry] of result.entries.entries()) {
      const tools = app.paperTools.get(entry.paperId); if (!tools) continue;
      const paper = app.state.papers[entry.paperId], settings = app.state.settings.feeds;
      const note = element('div',{class:'feed-note selection-note'},`${LABEL[feed]} · ${entry.rank ? 'Rank ' + entry.rank : 'Position ' + (index+1)} · ${app.state.reading[entry.paperId] ? 'Read' : 'Unread'} · ${paper.announcementDate || 'Unknown announcement date'}`);
      if (entry.observation) {
        const o = entry.observation, definition = METRIC_DEFINITIONS[o.provider + ':' + o.metric];
        if (settings.showRaw) note.append(element('p',{},`${o.value} ${definition?.label || o.metric}`));
        if (settings.showGrowth && Number.isFinite(entry.velocity)) note.append(element('p',{},`${entry.velocity.toFixed(3)} ${definition?.kind || 'observations'} / hour over ${entry.intervalHours.toFixed(2)} hours`));
        note.append(element('details',{},element('summary',{},feed === 'rising' ? 'Why is this rising?' : 'Why is this trending?'),
          element('p',{},`Provider: ${o.provider}. Metric: ${o.metric}. Value: ${o.value}. Measurement window: ${o.window.kind}${o.window.days ? ' (' + o.window.days + ' days)' : ''}.`),
          element('p',{},`Observed ${o.observedAt}. Provider updated: ${o.providerUpdatedAt || 'unknown'}. Availability: ${o.status}.`),
          element('p',{},definition?.limitation || ''),
          element('p',{},'Ranks use this metric alone. Equal values share a rank; arXiv IDs resolve display ties. Older papers can accumulate more activity; this is not an age-adjusted growth claim.'),
          o.sourceUrl ? link('Provider record',o.sourceUrl) : null));
      } else if (entry.assessment) {
        note.append(element('details',{},element('summary',{},'AI assessment and evidence'),element('p',{class:'answer'},mathFragment(document,entry.assessment.text,{recoverBareTex:true})),
          element('p',{},mathFragment(document,entry.assessment.highlight.reason,{recoverBareTex:true})),element('p',{},'Assessment basis: ' + entry.assessment.highlight.basis.join(', ')),
          link('Source (' + entry.assessment.source.kind + ')',entry.assessment.source.url),
          element('ul',{},(entry.assessment.highlight.citations || []).map(c => element('li',{},link(c.label,c.url),c.quotes.length ? ' — ' + c.quotes.join(' / ') : ''))),
          element('p',{class:'muted'},'AI assessment · author claims unverified · ' + entry.assessment.assessedAt)));
      } else note.append(element('details',{},element('summary',{},'Why this paper?'),element('p',{},entry.reason || result.label)));
      tools.root.insertBefore(note,tools.body);
    }
  }

  refreshProtection() {
    if (this.active !== 'highlights' || !this.population || !this.app.listRoot) return;
    this.result = buildFeed('highlights',this.population,this.app.state,{model:this.app.model});
    this.render(this.app.listRoot,this.result);
  }

  openSettings() {
    const app = this.app, body = app.panel('Feed settings','feed-settings'), s = app.state.settings.feeds;
    const landing = select(FEEDS,s.landing), categories = select(Object.entries(CATEGORIES).map(([id,name]) => [id,id + ' — ' + name]),'');
    categories.multiple = true; categories.size = 6;
    for (const option of categories.options) option.selected = s.categories.includes(option.value);
    const number = (value,min,max,step = 1) => element('input',{type:'number',value,min,max,step});
    const maximum = number(s.maxDisplayed,0,10000), refresh = number(s.refreshMinutes,15,10080);
    const coverage = number(Math.round(s.minimumCoverage*100),25,100), age = number(s.maxMetricAgeHours,1,168);
    const randomCount = number(s.randomCount,1,200), intensity = number(Math.round(s.discoveryIntensity*100),0,100);
    const author = element('input',{type:'text',maxlength:500,value:s.author}), date = element('input',{type:'date',value:s.date}), search = element('input',{type:'search',maxlength:500,value:s.search});
    const reading = select([['all','All'],['unread','Unread'],['read','Read']],s.reading), bookmark = select([['all','All'],['saved','Bookmarked'],['unsaved','Not bookmarked']],s.bookmark);
    const section = select([['all','All'],['new','New'],['cross','Cross-submissions'],['replacement','Replacements'],['unknown','Unknown']],s.section);
    const sort = select([['saved','Bookmark date'],['date','Announcement date'],['title','Title']],s.savedSort);
    const metrics = select([['none','No provider selected'],...Object.entries(METRIC_DEFINITIONS).map(([id,d]) => [id,d.label])],s.provider === 'none' ? 'none' : s.provider + ':' + s.metric);
    const toggles = {};
    const toggle = (key,label) => { const node = checkbox(label,s[key]); toggles[key] = node.querySelector('input'); return node; };
    body.append(field('Default landing feed',landing),field('Mathematical categories',categories,'Select multiple categories. No selection includes all 32.'),
      element('div',{class:'columns'},field('Search titles, abstracts and authors',search),field('Author contains',author),field('Announcement date within source',date),field('Reading status',reading),field('Bookmark status',bookmark),field('Submission type',section)),
      toggle('includeCross','Include known cross-submissions'),toggle('includeReplacements','Include known replacements'),
      element('div',{class:'columns'},field('Maximum displayed papers',maximum,'0 displays every matching paper. This does not change source eligibility or daily quotas.'),field('Source refresh interval (minutes)',refresh,'Cache lifetime on feed visits. Nothing runs while the browser is closed.')),
      element('h3',{},'Observed attention'),field('Provider and metric',metrics),
      element('div',{class:'columns'},field('Minimum Recent metric coverage (%)',coverage),field('Maximum observation age (hours)',age)),
      toggle('showRaw','Display raw measurements'),toggle('showGrowth','Display growth when valid'),
      element('p',{class:'muted'},'Coverage and ranks use the full Recent population. Category, date, author, read and bookmark controls filter results afterward. Personal interests never alter Trending or Rising ranks.'),
      element('h3',{},'Exploration'),toggle('randomBalanced','Use adaptive category quotas in the Recent Random feed'),
      field('Global Random sample size',randomCount,'Used only when category quotas are disabled.'),field('Discovery novelty strength (%)',intensity),field('Saved sort order',sort));
    const batch = number(s.highlightBatch,1,10); body.append(field('Maximum papers per explicit AI assessment batch',batch,'AI also obeys the existing provider consent, request allowance and spending limits.'));
    body.append(app.button('Save feed settings',async () => {
      const metricKey = metrics.value, separator = metricKey.indexOf(':');
      const patch = {landing:landing.value,categories:[...categories.selectedOptions].map(o => o.value),maxDisplayed:Number(maximum.value),refreshMinutes:Number(refresh.value),
        minimumCoverage:Number(coverage.value)/100,maxMetricAgeHours:Number(age.value),provider:metricKey === 'none' ? 'none' : metricKey.slice(0,separator),metric:metricKey === 'none' ? '' : metricKey.slice(separator+1),
        randomCount:Number(randomCount.value),discoveryIntensity:Number(intensity.value)/100,author:author.value,date:date.value,search:search.value,reading:reading.value,bookmark:bookmark.value,section:section.value,savedSort:sort.value,highlightBatch:Number(batch.value)};
      for (const [key,input] of Object.entries(toggles)) patch[key] = input.checked;
      app.state.settings = await app.store.settings({feeds:patch});
      const feed = this.active; if (feed) await this.open(feed); else app.notify('Feed settings saved.');
    }));
    body.append(element('h3',{},'External observation files'),element('p',{class:'muted'},'Import the reproducible collector’s JSON observations. Provider credentials stay outside the userscript. History is limited to 30 days and 50,000 observations; personal-data exports omit it.'));
    const input = element('input',{type:'file',accept:'.json,application/json'});
    body.append(field('Readership observation JSON',input),app.button('Import observations',async () => {
      const file = input.files?.[0]; if (!file) throw new Error('Choose an observation file.');
      if (file.size > 50000000) throw new Error('The observation file exceeds 50 MB.');
      const observations = await app.store.importReadership(JSON.parse(await file.text()));
      app.notify(observations.length + ' retained external observations. Choose the matching provider and metric, then save these settings.');
    }),app.button('Export external observations',async () => downloadText('arxiv-readership-observations.json',JSON.stringify({schemaVersion:1,observations:await app.store.readership()},null,2),'application/json')),
    app.button('Clear external observations',async () => { if (!confirm('Clear the imported readership observation history? Personal interests and saved papers will remain.')) return; await app.store.clearReadership(); app.notify('External observations cleared.'); }));
  }

  openHighlights() {
    const app = this.app, body = app.panel('Assess potential highlights','highlight-assessment');
    if (!this.population?.complete) { body.append(element('p',{},'Open a complete Recent feed first.')); return; }
    const candidates = this.population.papers, choices = select(candidates.map(p => [p.id,p.id + ' — ' + p.title]),'');
    choices.multiple = true; choices.size = 8;
    for (const option of choices.options) option.selected = false;
    body.append(element('p',{class:'notice'},'Choose papers explicitly. AI assessments can discuss author-claimed results only when the paper’s No Spoilers setting permits it. The existing bridge validates source evidence; no assessment is independent verification.'),field('Recent papers to assess',choices));
    const inconclusive = candidates.filter(p => {
      const h = app.state.highlights[p.id];
      return h?.highlight?.status === 'not_established' && h.version === p.version &&
        (!app.noSpoilers(p) || h.noSpoilers) && (p.version || h.announcementDate === p.announcementDate && Date.now()-Date.parse(h.assessedAt) >= 0 && Date.now()-Date.parse(h.assessedAt) < 3600000);
    });
    if (inconclusive.length) body.append(element('details',{},element('summary',{},`${inconclusive.length} inconclusive assessment(s)`),element('ul',{},inconclusive.map(p => element('li',{},link(p.title,p.links.abstract),' — ',mathFragment(document,app.state.highlights[p.id].highlight.reason,{recoverBareTex:true}))))));
    body.append(app.button('Assess selected papers',async () => {
      const ids = [...choices.selectedOptions].map(o => o.value), maximum = app.state.settings.feeds.highlightBatch;
      if (!ids.length || ids.length > maximum) throw new Error('Select between 1 and ' + maximum + ' papers.');
      const dialog = app.dialog, epoch = app.viewEpoch;
      const current = () => dialog?.isConnected && dialog.open && app.currentPanel === 'highlight-assessment' && app.viewEpoch === epoch;
      const generation = await app.store.generation();
      for (const id of ids) {
        if (!current() || generation !== await app.store.generation()) return;
        const paper = candidates.find(p => p.id === id), noSpoilers = app.noSpoilers(paper);
        app.notify('Assessing ' + id + '…');
        const answer = await app.ai.highlight(paper,{noSpoilers});
        if (!current() || generation !== await app.store.generation()) return;
        if (app.noSpoilers(paper) !== noSpoilers) throw new Error('Spoiler protection changed during generation. Request a new assessment under the current setting.');
        const assessment = {paperId:id,version:paper.version,announcementDate:paper.announcementDate,text:answer.text,source:answer.source,highlight:answer.highlight,assessedAt:instant(Date.now()),noSpoilers,assessmentKind:'unverified_ai_assessment'};
        if (!await app.store.setIfGeneration('highlights',id,assessment,generation)) throw new Error('Saved data changed; the assessment was not retained.');
        app.state.highlights[id] = assessment;
      }
      if (current()) await this.open('highlights');
    }));
  }
}

import {FEEDS, checkedFeedSettings} from './feed-settings.js';
import {generateRecentSelection} from './sampling.js';
import {predict, subscriptionMatches, paperCategories} from './recommender.js';
import {rankTrending, rankRising} from './readership.js';

export {FEEDS};

export function filterFeedEntries(entries, papers, state, settings) {
  const byId = new Map(papers.map(p => [p.id,p]));
  const s = checkedFeedSettings(settings);
  const query = s.search.toLocaleLowerCase(), author = s.author.toLocaleLowerCase();
  return entries.filter(entry => {
    const p = byId.get(entry.paperId); if (!p) return false;
    if (s.categories.length && !paperCategories(p).some(c => s.categories.includes(c))) return false;
    if (!s.includeCross && p.section === 'cross' || !s.includeReplacements && p.section === 'replacement') return false;
    if (s.section !== 'all' && (p.section || 'unknown') !== s.section) return false;
    if (s.date && p.announcementDate !== s.date) return false;
    if (author && !p.authors.some(a => a.name.toLocaleLowerCase().includes(author))) return false;
    if (query && ![p.id,p.title,p.abstract,...p.authors.map(a => a.name)].join(' ').toLocaleLowerCase().includes(query)) return false;
    const read = !!state.reading?.[p.id], saved = !!state.bookmarks?.[p.id];
    return !(s.reading === 'read' && !read || s.reading === 'unread' && read ||
      s.bookmark === 'saved' && !saved || s.bookmark === 'unsaved' && saved);
  });
}

// Public popularity calculation never receives the interest model or histories.
// Local filters run AFTER its quality assessment and ranks have been fixed.
export function buildFeed(feed, population, state, {model, observations = [], seed = 'recent', now = Date.now()} = {}) {
  if (!FEEDS.some(([id]) => id === feed) || feed === 'today') throw new Error('Choose a supported Recent or Saved feed.');
  const settings = checkedFeedSettings(state.settings?.feeds);
  let papers, result;
  if (feed === 'saved') {
    papers = Object.keys(state.bookmarks || {}).map(id => state.savedPapers?.[id] || state.papers?.[id]).filter(Boolean);
    papers.sort((a,b) => settings.savedSort === 'title' ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id) :
      settings.savedSort === 'date' ? String(b.announcementDate || '').localeCompare(a.announcementDate || '') || a.id.localeCompare(b.id) :
        String(state.bookmarks[b.id]).localeCompare(state.bookmarks[a.id]) || a.id.localeCompare(b.id));
    result = {available:true, entries:papers.map(p => ({paperId:p.id,reason:'Saved locally; retained independently of Recent.'})), reasons:[], label:'Saved papers'};
  } else {
    if (population?.population !== 'recent' || population.complete !== true) return {available:false, entries:[], papers:[], reasons:['The complete authoritative arXiv Recent listing has not been verified.'],label:feed};
    papers = population.papers;
    const sample = mode => generateRecentSelection(population, {
      mode, seed, model:mode === 'random' ? null : model,
      settings:{...state.settings, includeCross:settings.includeCross, includeReplacements:settings.includeReplacements},
      subscriptions:mode === 'random' ? [] : state.subscriptions,
      reading:mode === 'discovery' ? state.reading : {}, knownPapers:mode === 'discovery' ? state.papers : {},
      discoveryIntensity:settings.discoveryIntensity
    });
    if (feed === 'trending' || feed === 'rising') {
      const options = {provider:settings.provider,metric:settings.metric,now,
        minCoverage:settings.minimumCoverage,maxAgeHours:settings.maxMetricAgeHours};
      result = (feed === 'trending' ? rankTrending : rankRising)(population,observations,options);
    } else if (feed === 'for-you') {
      if (model?.sampleCount) {
        const entries = papers.map(p => ({paperId:p.id,score:predict(model,p),reason:'Ranked by the existing local interest model. This is personal relevance, not readership.'}))
          .sort((a,b) => b.score - a.score || a.paperId.localeCompare(b.paperId));
        result = {available:true,entries,reasons:[],label:'Personal relevance'};
      } else result = {available:true,...sample('random'),reasons:[],label:'Balanced random fallback — no usable interest feedback yet'};
    } else if (feed === 'discovery') {
      result = {available:true,...sample('discovery'),reasons:[],label:'Unfamiliar topics, categories and author labels'};
    } else if (feed === 'random') {
      let draw;
      if (settings.randomBalanced) draw = sample('random');
      else {
        draw = generateRecentSelection(population,{mode:'personalized',seed,
          settings:{includeCross:settings.includeCross,includeReplacements:settings.includeReplacements,personalizedCount:settings.randomCount,useSubscriptions:false},
          model:null,subscriptions:[]});
        draw.mode = 'random';
        for (const entry of draw.entries) entry.reason = 'Uniform global sampling without replacement; independent of interests, authors and readership.';
      }
      result = {available:true,...draw,reasons:[],label:settings.randomBalanced ? 'Random with adaptive category quotas' : 'Uniform global random sample'};
    } else if (feed === 'subscriptions') {
      result = {available:true,entries:papers.filter(p => p.authors.some(a => (state.subscriptions || []).some(s => subscriptionMatches(a,s))))
        .map(p => ({paperId:p.id,reason:'Matches a stable author identity or an explicitly confirmed name-only subscription.'})),reasons:[],label:'Followed researchers'};
    } else if (feed === 'highlights') {
      const entries = papers.filter(p => {
        const h = state.highlights?.[p.id];
        const protectedPaper = state.settings.paperSpoilers?.[p.id] ?? state.settings.noSpoilers;
        return h && h.highlight?.status === 'candidate' && h.version === p.version && (!protectedPaper || h.noSpoilers) &&
          (p.version || h.announcementDate === p.announcementDate && now-Date.parse(h.assessedAt) >= 0 && now-Date.parse(h.assessedAt) < 3600000);
      }).map(p => ({paperId:p.id,assessment:state.highlights[p.id],reason:'On-demand AI assessment grounded in the cited source. Author claims and significance remain unverified.'}));
      result = {available:entries.length > 0,entries,reasons:entries.length ? [] : ['No source-backed AI candidates are available under the current version and spoiler settings. Inconclusive assessments are kept separately.'],label:'Potential highlights — unverified AI assessments'};
    } else result = {available:true,entries:papers.map(p => ({paperId:p.id,reason:'Original arXiv Recent order.'})),reasons:[],label:'Complete chronological Recent listing'};
  }
  const rankedCount = result.entries?.length || 0;
  const filtered = filterFeedEntries(result.entries || [],papers,state,settings);
  const entries = settings.maxDisplayed ? filtered.slice(0,settings.maxDisplayed) : filtered;
  return {...result,feed,papers,entries,rankedCount,filteredCount:filtered.length,displayedCount:entries.length,
    truncated:entries.length < filtered.length,unknownSections:papers.filter(p => p.section == null).length};
}

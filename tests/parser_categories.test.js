import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, normalizeCategory } from '../src/categories.js';
import { listingUrl } from '../src/parser.js';
import { mergeListingPages, validatePopulationSnapshot } from '../src/network.js';

test('all 32 mathematical subjects retain their canonical codes', () => {
  const expected = 'AC AG AP AT CA CO CT CV DG DS FA GM GN GR GT HO IT KT LO MG MP NA NT OA OC PR QA RA RT SG SP ST'.split(' ').map(s => 'math.' + s);
  assert.deepEqual(Object.keys(CATEGORIES), expected);
  for (const field of expected) assert.equal(normalizeCategory(field.toLowerCase()), field);
  assert.equal(normalizeCategory('cs.IT'), 'math.IT');
  assert.equal(normalizeCategory('cs.NA'), 'math.NA');
  assert.equal(normalizeCategory('math-ph'), 'math.MP');
  assert.equal(normalizeCategory('stat.TH'), 'math.ST');
  assert.equal(normalizeCategory('physics.flu-dyn'), 'physics.flu-dyn');
  assert.equal(normalizeCategory('cond-mat.stat-mech'), 'cond-mat.stat-mech');
  assert.equal(normalizeCategory('cs.LO'), 'cs.LO');
  assert.equal(normalizeCategory('missing.subject'), null);
  assert.equal(normalizeCategory(null), null);
});

test('pagination accepts only numeric controls on the same daily listing', () => {
  const base = 'https://arxiv.org/list/math/new';
  assert.equal(listingUrl('?skip=100&show=50', base), base + '?show=50&skip=100');
  for (const url of ['https://example.invalid/list/math/new?show=25', '/list/math/recent',
    '/list/cs/new?skip=0', '?show=0', '?show=1&show=2', '?skip=-1', '?token=x',
    'https://arxiv.org:3000/list/math/new', 'https://visitor@arxiv.org/list/math/new']) {
    assert.equal(listingUrl(url, base), null);
  }
});

test('an overlap can complete a day only with consistent identifiers, section totals and date', () => {
  const baseUrl = 'https://arxiv.org/list/math/new';
  const paper = { id: '2601.00001', version: 1, section: 'new', title: 'First' };
  const other = { id: '2601.00002', version: 1, section: 'cross', title: 'Second' };
  const first = { baseUrl, announcementDate: '2026-03-02', advertisedTotal: 2, papers: [paper],
    sectionTotals: { new: 1, cross: 1 }, integrityWarnings: [], nextUrls: [baseUrl + '?skip=1'] };
  const second = { ...first, baseUrl: baseUrl + '?skip=1', papers: [paper, other], nextUrls: [] };
  assert.equal(mergeListingPages([first, second]).complete, true);
  assert.equal(mergeListingPages([first, { ...second, papers: [{ ...paper, section: 'cross' }, other] }]).complete, false);
  assert.equal(mergeListingPages([first, { ...second, advertisedTotal: 3 }]).complete, false);
  assert.equal(mergeListingPages([first, { ...second, sectionTotals: { new: 2 } }]).complete, false);
  const changed = mergeListingPages([first, { ...second, announcementDate: '2026-03-03' }]);
  assert.equal(changed.complete, false);
  assert.deepEqual(changed.papers, [paper]);
});

test('Recent pagination retains the authoritative archive and rejects Today, arbitrary filters and invalid controls', () => {
  const base = 'https://arxiv.org/list/math/recent';
  assert.equal(listingUrl('?skip=2000&show=2000#item2001', base), base + '?show=2000&skip=2000');
  for (const raw of ['/list/math/new', '/list/cs/recent', '?days=7', '?show=0', '?skip=-1', '?skip=1&skip=2',
    'https://arxiv.org.evil.invalid/list/math/recent', 'https://name@arxiv.org/list/math/recent']) {
    assert.equal(listingUrl(raw, base), null);
  }
});

const recentBase = 'https://arxiv.org/list/math/recent';
const dates = ['2026-11-26', '2026-11-20'];
function recentPage(indices, ids, {skip=0, total=3, signature=JSON.stringify([[dates[0],1],[dates[1],3]]), extra={}}={}) {
  const papers = [...new Set(ids)].map(id => ({id, version:1, title:id, section:null,
    announcementDate: indices[ids.indexOf(id)] < 3 ? dates[0] : dates[1]}));
  return {population:'recent', baseUrl:recentBase + (skip ? '?skip=' + skip + '&show=2' : ''),
    announcementDate:null, announcementDates:dates, dateTotals:{[dates[0]]:2,[dates[1]]:1},
    dateStarts:{[dates[0]]:1,[dates[1]]:3}, cohortSignature:signature, advertisedTotal:total,
    papers, sourceEntries:indices.map((index,i)=>({index,paperId:ids[i],announcementDate:index<3?dates[0]:dates[1],section:null,version:1})),
    nextUrls:[recentBase+'?show=2&skip=1'], integrityWarnings:[], ...extra};
}

test('Recent completeness reconciles source positions and all cohorts while deduplicating normalized paper IDs', () => {
  const first = recentPage([1,2],['2611.00001','2611.00002']);
  const last = recentPage([2,3],['2611.00002','2611.00001'],{skip:1});
  const merged = mergeListingPages([first,last]);
  assert.equal(merged.complete,true,merged.warnings.join('\n'));
  assert.equal(merged.advertisedTotal,3);
  assert.equal(merged.entryCount,3);
  assert.equal(merged.distinctTotal,2);
  assert.equal(merged.counts.total,2);
  assert.equal(merged.announcementDate,null);
  assert.deepEqual(merged.announcementDates,dates);
  assert.deepEqual(merged.papers.map(p=>p.id),['2611.00001','2611.00002']);
  assert.equal(merged.papers[0].announcementDate,dates[0]);
  assert.deepEqual(merged.nextUrls,[]);
});

test('Recent rejects omitted rows, shifted cohort boundaries and mutable overlapping records', () => {
  const first = recentPage([1,2],['2611.00001','2611.00002']);
  const last = recentPage([2,3],['2611.00002','2611.00003'],{skip:1});
  const cases = [
    [recentPage([1],['2611.00001']),recentPage([3],['2611.00003'],{skip:2})],
    [first,{...last,cohortSignature:'different day'}],
    [first,{...last,advertisedTotal:4}],
    [first,{...last,dateTotals:{[dates[0]]:1,[dates[1]]:2}}],
    [first,{...last,sourceEntries:last.sourceEntries.map(e=>e.index===2?{...e,paperId:'2611.00003'}:e)}],
    [first,{...last,papers:last.papers.map(p=>p.id==='2611.00002'?{...p,title:'Changed'}:p)}],
    [first,{...last,sourceEntries:last.sourceEntries.map(e=>e.index===2?{...e,version:2}:e)}],
    [first,{...last,baseUrl:'https://arxiv.org/list/math/new'}],
  ];
  for (const pages of cases) {
    const result = mergeListingPages(pages);
    assert.equal(result.complete,false);
    assert.equal(result.distinctTotal,null);
    assert.ok(result.warnings.length);
  }
});

test('cached population validation recomputes completeness and rejects forged counters, dates and missing source rows', () => {
  const merged=mergeListingPages([
    recentPage([1,2],['2611.00001','2611.00002']),
    recentPage([3],['2611.00003'],{skip:2}),
  ]);
  assert.equal(validatePopulationSnapshot(merged).complete,true);
  const changes=[
    {complete:false}, {warnings:['Incomplete']}, {entryCount:4}, {distinctTotal:1},
    {cohortSignature:'invented'}, {announcementDate:'2026-11-26'},
    {announcementDates:['2026-11-31',dates[1]]}, {dateStarts:{[dates[0]]:1,[dates[1]]:2}},
    {counts:{...merged.counts,total:99}}, {sourceEntries:merged.sourceEntries.slice(1)},
    {papers:merged.papers.map((p,i)=>i===0?{...p,announcementDate:dates[1]}:p)},
    {sourceEntries:merged.sourceEntries.map((e,i)=>i===2?{...e,index:4}:e)},
    {nextUrls:[recentBase+'?skip=3']}, {baseUrl:'https://evil.invalid/list/math/recent'},
  ];
  for(const change of changes)assert.throws(()=>validatePopulationSnapshot({...merged,...change}),/Invalid population snapshot/);
  const today=mergeListingPages([{population:'today',baseUrl:'https://arxiv.org/list/math/new',
    announcementDate:dates[0],advertisedTotal:1,sectionTotals:{new:1},nextUrls:[],integrityWarnings:[],
    papers:[{id:'2611.00001',version:1,title:'Title',section:'new',announcementDate:dates[0]}]}]);
  assert.equal(validatePopulationSnapshot(today).complete,true);
  assert.throws(()=>validatePopulationSnapshot({...today,papers:[{...today.papers[0],announcementDate:dates[1]}]}));
});

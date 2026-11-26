import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState,validateImport} from '../src/storage.js';
import {activeFeedback,trainModel} from '../src/recommender.js';
import {feedbackCSV,readingCSV,bookmarksBibtex,csvCell} from '../src/exports.js';
import {checkedRecord,mergedSettings} from '../src/schema.js';
import {CATEGORIES} from '../src/categories.js';
import {DiscoveryApp} from '../src/app.js';

function adapter() {const values=new Map();return {values,get:async(k,d)=>values.has(k)?structuredClone(values.get(k)):d,set:async(k,v)=>{values.set(k,structuredClone(v));},remove:async k=>{values.delete(k);},keys:async()=>[...values.keys()]};}
const paper={id:'2611.12345',version:1,versionedId:'2611.12345v1',title:'An inequality in $x$',authors:[{name:'A. Author',url:'https://arxiv.org/a/author_a_1',stableId:'arxiv:author_a_1'}],categories:['math.CA'],primaryCategory:'math.CA',abstract:'We study elementary inequalities for convex functions.',announcementDate:'2026-11-26',section:'new',links:{abstract:'https://arxiv.org/abs/2611.12345',pdf:'https://arxiv.org/pdf/2611.12345',html:null}};
test('GM records survive fresh Store instances and retain separate personal collections',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();await store.cachePapers([paper]);
  await store.set('bookmarks',paper.id,'2026-11-26T10:00:00Z');await store.set('reading',paper.id,'2026-11-26T11:00:00Z');
  await store.set('knowledge','Limits',{level:'Comfortable',updatedAt:'2026-11-26T10:00:00Z'});
  await store.feedback(paper,'like','Interesting mathematical technique','random');
  await store.settings({history:{mode:'none'}});
  const state=await new Store(a).initialize();assert.equal(state.events.length,1);assert.equal(state.papers[paper.id].title,paper.title);assert.ok(state.bookmarks[paper.id]);assert.ok(state.reading[paper.id]);assert.ok(state.knowledge.Limits);assert.equal(activeFeedback(state.events,state.settings).active.length,0);
});
test('feedback revisions are authoritative, and removing a rating cannot resurrect its old like',async()=>{
  const store=new Store(adapter());await store.initialize();const first=await store.feedback(paper,'like','','random');
  const last=await store.feedback(paper,'removed','','random');assert.equal(last.revisionOf,first.eventId);
  const state=await store.load();assert.equal(state.events.length,2);assert.equal(activeFeedback(state.events,state.settings).active.length,0);assert.equal(trainModel(state.events,state.settings).sampleCount,0);
});
test('reset, restore and permanent deletion are separate from saved reading data',async()=>{
  const store=new Store(adapter());await store.initialize();await store.feedback(paper,'like','','balanced');await store.set('bookmarks',paper.id,'2026-11-26T10:00:00Z');await store.settings({resetAt:new Date(Date.now()+100).toISOString()});
  let state=await store.load();assert.equal(activeFeedback(state.events,state.settings).active.length,0);assert.equal(state.events.length,1);assert.equal(state.bookmarks[paper.id],'2026-11-26T10:00:00Z');
  await store.settings({resetAt:null});state=await store.load();assert.equal(activeFeedback(state.events,state.settings).active.length,1);
  await store.deleteFeedback([paper.id]);state=await store.load();assert.equal(state.events.length,0);assert.equal(trainModel(state.events,state.settings).sampleCount,0);assert.equal(state.bookmarks[paper.id],'2026-11-26T10:00:00Z');
});
test('independent tabs append events without overwriting each other',async()=>{
  const a=adapter(),first=new Store(a),second=new Store(a);await first.initialize();await second.initialize();
  await Promise.all([first.feedback(paper,'like','','balanced'),second.feedback({...paper,id:'2611.54321',versionedId:'2611.54321v1',links:{abstract:'https://arxiv.org/abs/2611.54321',pdf:'https://arxiv.org/pdf/2611.54321',html:null}},'dislike','','balanced')]);
  assert.equal((await first.load()).events.length,2);
});
test('portable JSON deliberately omits pairing credentials and requires consent again',async()=>{
  const store=new Store(adapter());await store.initialize();await store.cachePapers([paper]);await store.feedback(paper,'like','','balanced');await store.settings({ai:{token:'fixture-only-local-pairing-identifier-0001',model:'fixture-model',enabled:true,consent:true}});
  const exported=await store.export();assert.equal(exported.state.settings.ai.token,'');assert.equal(exported.state.settings.ai.enabled,false);assert.equal(exported.state.settings.ai.consent,false);assert.equal((await store.load()).settings.ai.token,'fixture-only-local-pairing-identifier-0001');
  const restored=new Store(adapter());await restored.initialize();await restored.import(exported);await restored.import(exported);assert.equal((await restored.load()).events.length,1);assert.equal((await restored.load()).settings.ai.token,'');
});
test('malformed imports cannot write partial data or prototype-pollution keys',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();const before=JSON.stringify([...a.values]);
  const bad={format:'arxiv-discovery',schemaVersion:1,state:emptyState()};bad.state.events=[{eventId:'broken'}];await assert.rejects(store.import(bad));assert.equal(JSON.stringify([...a.values]),before);
  const pollution=JSON.parse('{"format":"arxiv-discovery","schemaVersion":1,"state":{"__proto__":{"polluted":true}}}');assert.throws(()=>validateImport(pollution),/Unsafe key/);assert.equal({}.polluted,undefined);
  assert.throws(()=>validateImport({format:'arxiv-discovery',schemaVersion:2,state:{}}),/supported/);
});
test('CSV quotes Unicode and mitigates spreadsheet formula injection',()=>{
  assert.equal(csvCell('=2+2'),'"\'=2+2"');assert.equal(csvCell('A, "B"'),'"A, ""B"""');
  const state=emptyState();state.events=[{eventId:'x',paperId:paper.id,version:1,timestamp:'date',value:'like',reason:'+SUM(A1)',mode:'random',paper}];state.papers[paper.id]=paper;state.bookmarks[paper.id]='date';state.reading[paper.id]='date';
  assert.match(feedbackCSV(state),/'\+SUM/);assert.match(readingCSV(state),/An inequality/);assert.match(bookmarksBibtex(state),/archivePrefix = \{arXiv\}/);assert.match(bookmarksBibtex(state),/author = \{A\. Author\}/);
});
test('unknown future storage schema fails closed without data writes',async()=>{
  const a=adapter();
  a.values.set('arxiv-discovery:v1:schema',999);
  a.values.set('arxiv-discovery:v1:reading:' + paper.id, '2026-11-26T10:00:00Z');
  a.values.set('arxiv-discovery:v1:transaction', {kind:'remove', keys:['arxiv-discovery:v1:reading:' + paper.id]});
  const before=structuredClone([...a.values]);
  const store=new Store(a);
  await assert.rejects(store.initialize(),/newer script version/);
  await assert.rejects(store.clearAll(),/newer script version/);
  assert.deepEqual([...a.values],before);
});

test('explicit revision ancestry survives sorting by timestamp and a local clock rollback', async () => {
  const store = new Store(adapter());
  await store.initialize();
  const first = await store.feedback(paper, 'like', '', 'random');
  const backup = await store.export();
  // A clock correction makes the actual successor appear older than its parent.
  backup.state.events[0].timestamp = '2099-01-01T12:00:00Z';
  backup.state.events.push({...first, eventId: 'earlier-clock', revisionOf: first.eventId,
    timestamp: '2020-01-01T12:00:00Z', value: 'dislike'});
  await store.import(backup);
  const removed = await store.feedback(paper, 'removed', '', 'random');
  assert.equal(removed.revisionOf, 'earlier-clock');
  assert.deepEqual(activeFeedback((await store.load()).events).active, []);
});

test('concurrent edits to one paper form one chain and stale exclusions cannot restore deleted history', async () => {
  const a = adapter();
  const first = new Store(a);
  const second = new Store(a);
  await first.initialize();
  const [liked, disliked] = await Promise.all([
    first.feedback(paper, 'like', '', 'balanced'), second.feedback(paper, 'dislike', '', 'balanced')
  ]);
  assert.equal(disliked.revisionOf, liked.eventId);
  await first.deleteFeedback([paper.id]);
  await assert.rejects(second.set('events', disliked.eventId, {...disliked, excluded: true}), /deleted/);
  assert.equal(trainModel((await second.load()).events).sampleCount, 0);
});

test('deletions invalidate pending private writes across Store instances and clear all personal records', async () => {
  const a = adapter();
  const first = new Store(a);
  const other = new Store(a);
  await first.initialize();
  const initial = await other.generation();
  assert.ok(await first.setIfGeneration('bookmarks', paper.id, '2026-11-26T01:00:00Z', initial));
  await first.clearCollection('glossary');
  assert.equal(await other.setIfGeneration('reading', paper.id, '2026-11-26T02:00:00Z', initial), false);
  const afterGlossary = await other.generation();
  await first.clearAll();
  assert.equal(await other.setIfGeneration('bookmarks', paper.id, '2026-11-26T03:00:00Z', afterGlossary), false);
  assert.deepEqual(await other.load(), emptyState());
  assert.deepEqual([...a.values.keys()].sort(), ['arxiv-discovery:v1:generation', 'arxiv-discovery:v1:revision']);
});

test('private future records remain intact on unsupported schemas and malformed old rows are isolated', async () => {
  const a = adapter();
  const store = new Store(a);
  await store.initialize();
  await store.cachePapers([paper]);
  a.values.set('arxiv-discovery:v1:glossary:old', {answer: []});
  a.values.set('arxiv-discovery:v1:settings', {history: 'unreadable'});
  const state = await store.load();
  assert.equal(state.papers[paper.id].title, paper.title);
  assert.equal(state.settings.ai.enabled, false);
  assert.equal(state.storageWarnings.length, 2);
  assert.equal(await store.get('glossary', 'old'), null);
  assert.equal(a.values.has('arxiv-discovery:v1:glossary:old'), true);
});

test('an interrupted import rolls back earlier rows, and an interrupted deletion completes on restart', async () => {
  const a = adapter();
  const store = new Store(a);
  await store.initialize();
  await store.cachePapers([paper]);
  const data = await store.export();
  data.state.papers[paper.id].title = 'Imported title';
  data.state.bookmarks[paper.id] = '2026-11-26T12:00:00Z';
  const set = a.set;
  let offline = false;
  a.set = async (key, value) => {
    if (key.endsWith('bookmarks:' + paper.id)) offline = true;
    if (offline) throw new Error('Simulated storage interruption');
    return set(key, value);
  };
  await assert.rejects(store.import(data), /interruption/);
  assert.ok(a.values.has('arxiv-discovery:v1:transaction'));
  a.set = set;
  const restarted = new Store(a);
  const recovered = await restarted.initialize();
  assert.equal(recovered.papers[paper.id].title, paper.title);
  assert.deepEqual(recovered.bookmarks, {});
  assert.equal(a.values.has('arxiv-discovery:v1:transaction'), false);
  const liked = await restarted.feedback(paper, 'like', '', 'random');
  const latest = await restarted.feedback(paper, 'removed', '', 'random');
  const remove = a.remove;
  a.remove = async key => {
    if (key.endsWith(latest.eventId)) throw new Error('Simulated deletion interruption');
    return remove(key);
  };
  await assert.rejects(restarted.deleteFeedback([paper.id]), /interruption/);
  assert.equal(a.values.has('arxiv-discovery:v1:events:' + liked.eventId), false);
  a.remove = remove;
  assert.deepEqual((await new Store(a).initialize()).events, []);
});

test('simultaneous first selections pin one draw and reading it again produces no change notification', async () => {
  const a = adapter();
  let notifications = 0;
  const save = a.set;
  a.set = async (key, value) => {
    if (key === 'arxiv-discovery:v1:revision') notifications++;
    await save(key, value);
  };
  const first = new Store(a), second = new Store(a);
  await first.initialize();
  const generation = await first.generation();
  const key = '2026-11-26|random|new|originals|32|math';
  function draw(seed) {
    const selection = {mode:'random', date:'2026-11-26', seed, entries:[], missing:[]};
    return {original:selection, current:selection, revisions:[], createdAt:'2026-11-26T00:00:00Z'};
  }
  const [one, two] = await Promise.all([
    first.getOrCreateSelection(key, draw('first-tab'), generation),
    second.getOrCreateSelection(key, draw('second-tab'), generation)
  ]);
  assert.deepEqual(one, two);
  assert.deepEqual(await second.get('selections', key), one);
  assert.deepEqual(await first.getOrCreateSelection(key, draw('later'), generation), one);
  assert.equal(notifications, 1);
  await first.clearCollection('selections');
  assert.equal(await second.getOrCreateSelection(key, draw('stale'), generation), null);
  assert.equal(await first.get('selections', key), null);
  assert.equal(notifications, 2);
});

test('overlapping selection edits preserve the complete winning history, original and paper snapshots', async () => {
  const shared = adapter();
  const first = new Store(shared), second = new Store(shared);
  await first.initialize();
  const key = '2026-11-26|random|new|originals|32|math';
  const generation = await first.generation();
  const selection = {mode:'random', date:'2026-11-26', seed:'original', entries:[], missing:[]};
  const before = await first.getOrCreateSelection(key, {original:selection, current:selection, revisions:[],
    createdAt:'2026-11-26T00:00:00Z', paperSnapshots:{[paper.id]:paper}}, generation);
  const alternate = {...paper, id:'2611.00010', versionedId:'2611.00010v1', links:{}};
  const additions = {[alternate.id]:alternate};
  const proposals = await Promise.all([
    first.commitSelectionRevision(key, before, {...selection, seed:'edit-1'}, additions, generation),
    second.commitSelectionRevision(key, before, {...selection, seed:'edit-2'}, additions, generation)
  ]);
  const committed = proposals.filter(Boolean);
  assert.equal(committed.length, 1);
  assert.equal(proposals.filter(record => record === null).length, 1);
  const [winner] = committed;
  assert.deepEqual(winner.original, before.original);
  assert.deepEqual(winner.revisions, [before.current]);
  assert.equal(winner.paperSnapshots[paper.id].title, paper.title);
  assert.equal(winner.paperSnapshots[alternate.id].id, alternate.id);
  assert.deepEqual(await second.get('selections', key), winner);

  // A conflicting base can have the same revision count. Check the actual draw.
  const changedBase = {...winner, current:{...winner.current, seed:'different-current'}};
  assert.equal(await first.commitSelectionRevision(key, changedBase, selection, {}, generation), null);
  const restored = await second.commitSelectionRevision(key, winner, before.original, {}, generation);
  assert.deepEqual(restored.revisions, [before.current, winner.current]);
  assert.deepEqual(restored.current, before.original);

  await first.clearCollection('selections');
  assert.equal(await second.commitSelectionRevision(key, restored, selection, additions, generation), null);
  assert.equal(await first.get('selections', key), null);
});

test('Personalized defaults to 50, accepts 1–200, and preserves saved legacy size preferences', () => {
  assert.equal(mergedSettings().personalizedCount, 50);
  assert.equal(mergedSettings({personalizedCount:32}).personalizedCount, 32);
  for (const size of [1, 50, 200]) assert.equal(mergedSettings({personalizedCount:size}).personalizedCount, size);
  for (const size of [0, 201, 1.5, '50', NaN]) assert.throws(() => mergedSettings({personalizedCount:size}), /daily count/);
});

function adaptiveRecord() {
  const entries = Array.from({length:40}, (_, i) => ({paperId:'2611.' + String(i + 1).padStart(5, '0'),
    category:'math.CA', reason:'Adaptive random draw.', probability:40 / 1600}));
  const categoryDistribution = Object.keys(CATEGORIES).sort().map(category => ({category,
    eligibleCount:category === 'math.CA' ? 1600 : 0, squareRootQuota:category === 'math.CA' ? 40 : 0,
    quota:category === 'math.CA' ? 40 : 0, selectedCount:category === 'math.CA' ? 40 : 0,
    reason:category === 'math.CA' ? null : 'No eligible papers.'}));
  const current = {mode:'random', date:'2026-11-26', seed:'adaptive', entries, missing:[],
    samplingVersion:2, categoryDistribution, targetSize:40, shortfall:0};
  return {original:current, current, revisions:[], createdAt:'2026-11-26T00:00:00Z'};
}

test('adaptive selections above 32 and their distribution snapshots survive reload, backup and import with old revisions intact', async () => {
  const key = '2026-11-26|random|new|originals|32|math';
  const legacy = {mode:'random', date:'2026-11-26', seed:'old-seed', entries:[
    {paperId:paper.id, category:'math.CA', reason:'Original one-category draw.', probability:1}], missing:[]};
  const old = {original:legacy, current:legacy, revisions:[], createdAt:'2026-11-26T00:00:00Z'};
  const a = adapter(), store = new Store(a);
  await store.initialize();
  await store.set('selections', key, old);
  assert.deepEqual(await store.get('selections', key), old);
  const next = adaptiveRecord();
  next.original = legacy;
  next.revisions = [legacy];
  await store.set('selections', key, next);
  assert.deepEqual((await new Store(a).initialize()).selections[key], next);
  const backup = await store.export();
  const restored = new Store(adapter());
  await restored.import(backup);
  assert.deepEqual((await restored.load()).selections[key], next);
  assert.equal(Object.hasOwn((await restored.load()).selections[key].original, 'categoryDistribution'), false);
  assert.equal(backup.schemaVersion, 1);
});

test('quota metadata rejects fabricated counts, duplicates, missing categories and unexplained shortages before import writes', async () => {
  const key = '2026-11-26|random|new|originals|auto|math';
  const mutations = [
    v => { v.categoryDistribution[0].eligibleCount = -1; },
    v => { v.categoryDistribution.find(r => r.category === 'math.CA').squareRootQuota = 39; },
    v => { v.categoryDistribution.find(r => r.category === 'math.CA').quota = 39; },
    v => { v.categoryDistribution.find(r => r.category === 'math.CA').selectedCount = 39; },
    v => { v.categoryDistribution[0].category = v.categoryDistribution[1].category; },
    v => { v.categoryDistribution.pop(); },
    v => { v.targetSize = 39; },
    v => { v.shortfall = 1; },
    v => { v.entries.pop(); const row = v.categoryDistribution.find(r => r.category === 'math.CA'); row.selectedCount = 39; v.shortfall = 1; row.reason = null; },
    v => { delete v.samplingVersion; },
    v => { delete v.categoryDistribution; },
  ];
  const a = adapter(), store = new Store(a);
  await store.initialize();
  const before = structuredClone([...a.values]);
  for (const mutate of mutations) {
    const record = structuredClone(adaptiveRecord());
    mutate(record.current);
    const state = emptyState();state.selections[key] = record;
    await assert.rejects(store.import({format:'arxiv-discovery', schemaVersion:1, state}));
    assert.deepEqual([...a.values], before);
  }
});

test('the storage boundary accepts a 200-paper global Personalized selection without category quotas', () => {
  const entries = Array.from({length:200}, (_, i) => ({paperId:'2611.' + String(i + 1).padStart(5, '0'),
    category:null, reason:'Global draw.', probability:null}));
  const current = {mode:'personalized', date:'2026-11-26', seed:'global', entries, missing:[]};
  const record = {original:current, current, revisions:[], createdAt:'2026-11-26T00:00:00Z'};
  assert.deepEqual(checkedRecord('selections', '2026-11-26|personalized|new|originals|200|math', record), record);
});

test('automatic selection keys reuse matching legacy draws across count changes and isolate dates, sections and archives', () => {
  const previousLocation = globalThis.location;
  globalThis.location = {pathname:'/list/math/new'};
  try {
    const state = {settings:mergedSettings(), selections:{}};
    const app = {state, listing:{announcementDate:'2026-11-26'}};
    const key = () => DiscoveryApp.prototype.selectionKey.call(app);
    const legacy = '2026-11-26|random|new|originals|32|math';
    state.selections['2026-11-26|random|new|originals|50|math.CA'] = {};
    state.selections['2026-11-25|random|new|originals|50|math'] = {};
    state.selections['2026-11-26|random|cross|originals|50|math'] = {};
    state.selections['2026-11-26|random|new|originals|32'] = {};
    assert.equal(key(), '2026-11-26|random|new|originals|auto|math');
    state.selections[legacy] = adaptiveRecord();
    assert.equal(key(), legacy);
    state.settings.personalizedCount = 200;
    assert.equal(key(), legacy);
    const exact = '2026-11-26|random|new|originals|200|math';
    state.selections[exact] = adaptiveRecord();
    assert.equal(key(), exact);
    state.settings.mode = 'balanced';
    assert.equal(key(), '2026-11-26|balanced|new|originals|auto|math');
    state.settings.mode = 'personalized';
    assert.equal(key(), '2026-11-26|personalized|new|originals|200|math');
    globalThis.location.pathname = '/list/math.CA/new';
    state.settings.mode = 'random';
    assert.equal(key(), '2026-11-26|random|new|originals|50|math.CA');
  } finally {
    if(previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

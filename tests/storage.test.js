import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState,validateImport} from '../src/storage.js';
import {activeFeedback,trainModel} from '../src/recommender.js';
import {feedbackCSV,readingCSV,bookmarksBibtex,csvCell} from '../src/exports.js';

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

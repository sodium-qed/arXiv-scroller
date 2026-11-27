import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFeed, FEEDS} from '../src/feeds.js';
import {checkedFeedSettings} from '../src/feed-settings.js';
import {Store, emptyState} from '../src/storage.js';
import {generateSelection, generateRecentSelection} from '../src/sampling.js';
import {trainModel} from '../src/recommender.js';
import {mergeListingPages} from '../src/network.js';
import {mergePaperMetadata,checkedPaper} from '../src/schema.js';

const now = Date.parse('2026-11-26T12:00:00Z');
const day = '2026-11-26';
function paper(n, category = 'math.LO', date = day) {
  const id = '2611.' + String(n).padStart(5,'0');
  return {id,version:1,versionedId:id+'v1',title:'Logic and proof ' + n,abstract:'A model theoretic result.',authors:[{name:'A Author',url:null,stableId:null}],
    categories:[category],primaryCategory:category,announcementDate:date,section:null,comments:'',journalRef:'',links:{abstract:'https://arxiv.org/abs/'+id+'v1',pdf:'https://arxiv.org/pdf/'+id+'v1',html:null}};
}
const papers = Array.from({length:9},(_,i) => paper(i+1,i<4 ? 'math.LO' : 'math.NT',i<4 ? day : '2026-11-20'));
function population(items=papers) {
  const dates = [...new Set(items.map(p=>p.announcementDate))];
  const starts = Object.fromEntries(dates.map(date => [date,items.findIndex(p=>p.announcementDate===date)+1]));
  return mergeListingPages([{population:'recent',baseUrl:'https://arxiv.org/list/math/recent',announcementDate:null,announcementDates:dates,
    dateStarts:starts,dateTotals:Object.fromEntries(dates.map(date => [date,items.filter(p=>p.announcementDate===date).length])),
    cohortSignature:JSON.stringify(dates.map(date => [date,starts[date]])),advertisedTotal:items.length,papers:items,
    sourceEntries:items.map((p,i)=>({index:i+1,paperId:p.id,announcementDate:p.announcementDate,section:p.section,version:p.version})),
    nextUrls:[],integrityWarnings:[]}]);
}
function state() {
  const s = emptyState(); s.papers = Object.fromEntries(papers.map(p => [p.id,p]));
  s.settings.feeds = checkedFeedSettings({provider:'openaire',metric:'views'}); return s;
}
const observations = papers.map((p,i)=>({paperId:p.id,provider:'openaire',metric:'views',status:i ? 'positive' : 'zero',value:i===8?7:i,
  observedAt:'2026-11-26T11:00:00Z',match:'exact_identifier'}));
function adapter() {const values=new Map();return {values,get:async(k,d)=>values.has(k)?structuredClone(values.get(k)):d,set:async(k,v)=>values.set(k,structuredClone(v)),remove:async k=>values.delete(k),keys:async()=>[...values.keys()]};}

test('ten feed choices preserve authoritative source separation and Saved works without Recent',()=>{
  assert.equal(FEEDS.length,10);
  const s=state(),p=population();
  for(const feed of ['recent','for-you','random','discovery','subscriptions','trending','rising','highlights']) {
    assert.equal(buildFeed(feed,{...p,population:'today'},s,{now}).available,false,feed);
    assert.equal(buildFeed(feed,{...p,complete:false},s,{now}).available,false,feed);
  }
  const old=paper(99,'math.NT','2025-01-02');s.papers[old.id]=old;s.bookmarks[old.id]='2025-02-01T00:00:00Z';
  assert.deepEqual(buildFeed('saved',null,s,{now}).entries.map(e=>e.paperId),[old.id]);
  assert.equal(buildFeed('recent',p,s,{now}).entries.length,9);
  assert.throws(()=>buildFeed('today',p,s),/supported/);
});

test('Recent reuses adaptive matching without changing dates, daily selections or preference independence',()=>{
  const s=state(),p=population(),before=JSON.stringify(p);
  const random=buildFeed('random',p,s,{now,seed:'fixed'});
  assert.equal(random.entries.length,5); // ceil(sqrt(4))+ceil(sqrt(5))
  assert.equal(new Set(random.entries.map(e=>e.paperId)).size,5);
  const changed=structuredClone(s);changed.settings.exploration=0;changed.settings.useSubscriptions=true;changed.reading=Object.fromEntries(papers.map(p=>[p.id,'2026-11-26T00:00:00Z']));
  changed.subscriptions=[{name:'A Author',confirmedNameOnly:true}];
  assert.deepEqual(buildFeed('random',p,changed,{now,seed:'fixed',model:{sampleCount:999,weights:new Map(),bias:99}}).entries,random.entries);
  assert.equal(JSON.stringify(p),before);
  assert.equal(generateSelection(papers,{date:day}).entries.length,0,'unknown sections stay excluded from Today');
  assert.throws(()=>generateRecentSelection({...p,complete:false}),/complete/);
  const daily=generateSelection(papers.map(p=>({...p,section:'new'})),{date:day,seed:'fixed'});
  assert.equal(daily.entries.length,2);assert.equal(daily.date,day);
});

test('global Random ignores the model and cold-start For You has an explicit balanced fallback',()=>{
  const s=state(),p=population();s.settings.feeds=checkedFeedSettings({...s.settings.feeds,randomBalanced:false,randomCount:3});
  const a=buildFeed('random',p,s,{now,seed:'global'}),b=buildFeed('random',p,s,{now,seed:'global',model:{sampleCount:1,weights:new Map(),bias:50}});
  assert.equal(a.entries.length,3);assert.deepEqual(a.entries,b.entries);assert.match(a.label,/Uniform global/);
  const cold=buildFeed('for-you',p,s,{now,seed:'fixed',model:trainModel([],s.settings)});
  assert.match(cold.label,/no usable interest/);assert.equal(cold.entries.length,5);
});

test('Trending filters and display limits preserve global ranks and complete-population coverage',()=>{
  const s=state(),p=population();
  const full=buildFeed('trending',p,s,{observations,now});
  assert.equal(full.available,true);assert.equal(full.coverage.total,9);assert.equal(full.coverage.measured,9);
  assert.equal(full.entries[0].rank,1);assert.equal(full.entries[1].rank,1);
  s.settings.feeds=checkedFeedSettings({...s.settings.feeds,categories:['math.LO'],maxDisplayed:2});
  s.bookmarks[papers[0].id]='2026-11-26T00:00:00Z';s.reading[papers[8].id]='2026-11-26T00:00:00Z';
  const filtered=buildFeed('trending',p,s,{observations,now,model:{sampleCount:100,weights:new Map(),bias:99}});
  assert.equal(filtered.entries.length,2);assert.equal(filtered.coverage.total,9);assert.equal(filtered.coverage.measured,9);
  assert.equal(filtered.entries[0].rank,full.entries.find(e=>e.paperId===filtered.entries[0].paperId).rank);
  assert.ok(filtered.entries[0].rank>1);assert.equal(filtered.filteredCount,4);assert.equal(filtered.truncated,true);
  assert.equal(buildFeed('rising',p,s,{observations,now}).available,false);
});

test('Subscriptions require stable identity or deliberate name confirmation and expose older Recent dates',()=>{
  const s=state(),p=population();s.subscriptions=[{name:'A Author',confirmedNameOnly:false}];
  assert.equal(buildFeed('subscriptions',p,s,{now}).entries.length,0);
  s.subscriptions[0].confirmedNameOnly=true;
  assert.equal(buildFeed('subscriptions',p,s,{now}).entries.length,9);
  s.settings.feeds=checkedFeedSettings({...s.settings.feeds,date:'2026-11-20',reading:'unread'});s.reading[papers[8].id]='2026-11-26T00:00:00Z';
  assert.equal(buildFeed('subscriptions',p,s,{now}).entries.length,4);
});

test('Highlights never disclose an unprotected cached assessment after spoiler protection is enabled',()=>{
  const s=state(),p=population(),id=papers[0].id;
  s.highlights[id]={paperId:id,version:1,assessmentKind:'unverified_ai_assessment',highlight:{status:'candidate'},text:'Unverified fixture assessment.',noSpoilers:false,assessedAt:'2026-11-26T11:30:00Z'};
  assert.equal(buildFeed('highlights',p,s,{now}).available,false);
  s.settings.paperSpoilers[id]=false;
  assert.equal(buildFeed('highlights',p,s,{now}).entries.length,1);
  s.settings.paperSpoilers[id]=true;
  assert.equal(buildFeed('highlights',p,s,{now}).entries.length,0);
  s.highlights[id].noSpoilers=true;s.highlights[id].version=2;
  assert.equal(buildFeed('highlights',p,s,{now}).entries.length,0,'different source versions cannot reuse an assessment');
});

test('legacy settings and backups preserve interests while feed settings and assessments round-trip',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();await store.feedback(papers[0],'like','','balanced');
  await store.settings({feeds:{landing:'saved',categories:['math.LO'],minimumCoverage:0.9}});
  await store.settings({feeds:{showRaw:false}});
  const current=await store.load();assert.equal(current.events.length,1);assert.equal(current.settings.feeds.minimumCoverage,0.9);assert.equal(current.settings.feeds.landing,'saved');
  const id=papers[0].id;await store.set('highlights',id,{paperId:id,version:1,text:'Fixture only.',source:{kind:'abstract',url:papers[0].links.abstract},highlight:{status:'not_established',basis:[],reason:'No qualifying evidence.',citations:[]},assessedAt:'2026-11-26T11:00:00Z',noSpoilers:true,assessmentKind:'unverified_ai_assessment'});
  const exported=await store.export(),restored=new Store(adapter());await restored.initialize();await restored.import(exported);
  assert.equal((await restored.load()).highlights[id].text,'Fixture only.');
  assert.throws(()=>checkedFeedSettings({categories:['cs.AI']}));assert.throws(()=>checkedFeedSettings({minimumCoverage:0.1}));
});

test('external history is separately retained, validated, excluded from private backups and unaffected by interest reset',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();
  const recent=observations.map(o=>({...o,observedAt:new Date().toISOString()}));
  assert.equal((await store.importReadership({schemaVersion:1,observations:recent})).length,9);
  await store.settings({resetAt:new Date().toISOString()});await store.clearCollection('events');
  assert.equal((await new Store(a).readership()).length,9);
  assert.equal(JSON.stringify(await store.export()).includes('external-readership'),false);
  const before=JSON.stringify([...a.values]);
  assert.throws(()=>store.importReadership({schemaVersion:1,observations:[{...recent[0],value:null}]}));
  assert.equal(JSON.stringify([...a.values]),before);
  assert.throws(()=>store.importReadership({schemaVersion:1,observations:[{...recent[1],provider:'ads',metric:'read_count'}]}),/does not archive/);
  await store.clearAll();assert.equal((await store.readership()).length,0);
});

test('external history prunes expired observations on access even without another import',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();
  a.values.set('arxiv-discovery:v1:external-readership',{schemaVersion:1,observations:observations.map(o=>({...o,observedAt:new Date(Date.now()-31*86400000).toISOString()}))});
  assert.equal((await store.readership()).length,0);
  assert.equal(a.values.get('arxiv-discovery:v1:external-readership').observations.length,0);
});

test('Highlight backup validation binds candidate evidence to the recorded source and spoiler state',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();const p=papers[0];
  const citation={label:'[S1] Abstract',url:p.links.abstract,quotes:['A model theoretic result.']};
  const h={paperId:p.id,version:1,text:'Unverified candidate.',source:{kind:'abstract',url:p.links.abstract,citations:[citation]},highlight:{status:'candidate',basis:['method'],reason:'The authors describe a method.',citations:[citation]},assessedAt:new Date().toISOString(),noSpoilers:false,assessmentKind:'unverified_ai_assessment'};
  await store.set('highlights',p.id,h);assert.equal((await store.get('highlights',p.id)).highlight.status,'candidate');
  await assert.rejects(store.set('highlights',p.id,{...h,noSpoilers:true}),/protected highlight/);
  await assert.rejects(store.set('highlights',p.id,{...h,source:{kind:'abstract',url:p.links.abstract,citations:[]}}),/evidence provenance/);
  await assert.rejects(store.set('highlights',p.id,{...h,highlight:{...h.highlight,basis:[]}}),/source-backed/);
});

test('complete population cache survives a restart and in-flight writes cannot recreate an erased cache',async()=>{
  const a=adapter(),store=new Store(a);await store.initialize();const p=population(),generation=await store.generation();
  await store.cacheFeedPopulation(p,generation);
  const loaded=await new Store(a).feedPopulation('recent');assert.equal(loaded.population.papers.length,9);assert.equal(loaded.stale,false);
  assert.throws(()=>store.cacheFeedPopulation({...p,sourceEntries:p.sourceEntries.slice(1)}));
  await store.clearAll();assert.equal(await store.cacheFeedPopulation(p,generation),null);assert.equal(await store.feedPopulation('recent'),null);
});

test('sparse Recent metadata never transfers old text or inline link offsets into a different or unknown version',()=>{
  const old={...papers[0],abstract:'An earlier cited result.',inlineLinks:{abstract:[{start:3,end:10,url:'https://example.org/reference'}]}};
  const same={...papers[0],abstract:''};
  const merged=mergePaperMetadata(old,same);assert.equal(merged.abstract,old.abstract);assert.deepEqual(merged.inlineLinks.abstract,old.inlineLinks.abstract);checkedPaper(merged);
  const newer={...same,version:2,versionedId:same.id+'v2',links:{abstract:'https://arxiv.org/abs/'+same.id+'v2',pdf:'https://arxiv.org/pdf/'+same.id+'v2',html:null}};
  const changed=mergePaperMetadata(old,newer);assert.equal(changed.abstract,'');assert.equal(changed.inlineLinks,undefined);checkedPaper(changed);
  assert.equal(mergePaperMetadata(old,{...same,version:0}).abstract,'');
  assert.equal(same.abstract,'','source record remains unchanged');
});

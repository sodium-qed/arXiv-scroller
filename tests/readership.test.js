// All fixtures in this file are synthetic; live results are separately recorded
// under research/trending and are not asserted as permanent provider behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {validateObservation,validateSnapshot,normalizeObservationId,coverageReport,rankTrending,rankRising,
  cumulativeGrowth,retainObservations} from '../src/readership.js';
import {normalizeProviderResponse,providerRequest,providerFailure,classifyProviderHttp,providerPageInfo} from '../src/readership-providers.js';
import {stratifiedSample,parseArguments,measure} from '../scripts/measure-indexing-coverage.mjs';

const NOW='2026-11-26T22:00:00.000Z';
const papers=Array.from({length:6},(_,i)=>({id:`2611.${String(i+1).padStart(5,'0')}`,categories:[i<3?'math.NT':'math.PR'],primaryCategory:i<3?'math.NT':'math.PR',announcementDate:i<3?'2026-11-26':'2026-11-25',section:'new'}));
const population={population:'recent',complete:true,papers};
const options={provider:'openaire',metric:'views',now:NOW};
const observation=(index,value,extra={})=>validateObservation({paperId:papers[index].id,provider:'openaire',metric:'views',status:value===null?'metric_unavailable':value===0?'zero':'positive',value,observedAt:NOW,match:'exact_identifier',...extra});
const observations=[6,5,4,3,2,0].map((value,index)=>observation(index,value));

test('external observation validation preserves genuine zero and rejects fake metrics, values and inconsistent identities',()=>{
  assert.equal(observation(0,0).value,0);
  for(const extra of [{status:'positive',value:0},{status:'zero',value:null},{value:'6'},{value:1.5},{value:NaN},{metric:'AI_importance'},{match:null},{definitionVersion:'changed'},
    {window:{kind:'cumulative'}},{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://u:p@api.openaire.eu/'},{observedAt:'yesterday'}]){
    assert.throws(()=>observation(0,6,extra));
  }
  const file=validateSnapshot({schemaVersion:1,observations,token:'removed'});assert.deepEqual(Object.keys(file),['schemaVersion','observations']);
  assert.throws(()=>validateSnapshot({schemaVersion:2,observations}));
  assert.equal(normalizeObservationId('https://arxiv.org/pdf/2611.00001v3.pdf'),'2611.00001');
  assert.equal(normalizeObservationId('math.NT/0301001v2'),'math/0301001');
});

test('provider record links stay on their registered public hosts and cannot retain URL credentials',()=>{
  for(const sourceUrl of ['https://api.openaire.eu/graph/v4/research-products?filter=ids.arxiv%3A2611.00001&page_size=100&page=1',
    'https://explore.openaire.eu/search/publication?pid=2611.00001', 'https://graph.openaire.eu/docs/data-model/entities/other/']){
    assert.equal(observation(0,1,{sourceUrl}).sourceUrl,new URL(sourceUrl).href);
  }
  for(const sourceUrl of ['https://attacker.example/paper','https://127.0.0.1/paper','https://api.openaire.eu.attacker.example/paper',
    'https://api.openaire.eu:8443/paper','http://api.openaire.eu/paper','https://secret@api.openaire.eu/paper',
    'https://api.openaire.eu/paper?api_key=secret','https://api.openaire.eu/paper?%74oken=secret',
    'https://api.openaire.eu/paper?X-Amz-Credential=secret','https://api.openaire.eu/paper?authorization=secret',
    'https://api.openaire.eu/paper?clientSecret=secret','https://api.openaire.eu/paper?session_id=secret',
    'https://api.openaire.eu/paper?x-api-key=secret','https://api.openaire.eu/paper?redirect=https://attacker.example']){
    assert.throws(()=>observation(0,1,{sourceUrl}),/source URL/);
  }
  assert.throws(()=>observation(0,1,{sourceUrl:'https://api.mendeley.com/catalog?arxiv=2611.00001'}),/provider source URL/);
  const mendeley=validateObservation({paperId:papers[0].id,provider:'mendeley',metric:'reader_count',status:'positive',value:1,observedAt:NOW,match:'exact_identifier',
    sourceUrl:'https://api.mendeley.com/catalog?arxiv=2611.00001&view=stats'});
  assert.equal(mendeley.sourceUrl,'https://api.mendeley.com/catalog?arxiv=2611.00001&view=stats');
});

test('coverage separates indexed, unavailable, zero, positive, auth failures and untested with explicit bounds',()=>{
  const rows=[observation(0,4),observation(1,0),observation(2,null),...providerFailure('openaire',[papers[3].id],'authentication_failure',NOW,'HTTP401')];
  const report=coverageReport(population,rows,options);
  assert.equal(report.matched,3);assert.equal(report.measured,2);assert.equal(report.positive,1);assert.equal(report.unresolved,3);
  assert.equal(report.metric.numerator,2);assert.equal(report.metric.denominator,6);assert.ok(Math.abs(report.metric.percentage-100/3)<1e-10);
  assert.equal(report.outcomes.untested,2);assert.equal(report.outcomes.authentication_failure,1);
  assert.equal(report.conditionalMetric.denominator,3);assert.equal(report.byCategory['math.NT'].total,3);
  assert.equal(report.byCategory['math.AC'].metric.percentage,null);
  assert.equal(report.indexingBounds.maximum.numerator,6);assert.equal(report.metricBounds.maximum.numerator,5);
  assert.equal(report.byAnnouncementDate['2026-11-25'].measured,0);
});

test('Trending has reproducible shared ties and ignores personalized inputs and measurements outside Recent',()=>{
  const rows=observations.map((row,i)=>i===1?{...row,value:6}:row);
  rows.push({...rows[0],paperId:'2611.99999',value:99999});
  const result=rankTrending(population,rows,{...options,interests:{'math.PR':100000},bookmarks:[papers[0].id]});
  assert.equal(result.available,true);assert.deepEqual(result.entries.map(e=>e.rank),[1,1,3,4,5,6]);
  assert.deepEqual(result.entries.map(e=>e.paperId),papers.map(p=>p.id));
  assert.deepEqual(result,rankTrending(population,rows.slice().reverse(),options));
  assert.equal(result.coverage.total,6);assert.match(result.ageDisclosure,/Older announcements/);
});

test('Today, incomplete Recent, unidentified populations, stale observations and stale provider updates fail closed',()=>{
  for(const source of [{...population,population:'today'},{...population,complete:false},{...population,papers:[...papers,papers[0]]},{...population,distinctTotal:10},papers])assert.equal(rankTrending(source,observations,options).available,false);
  assert.equal(rankTrending(papers,observations,{...options,population:'recent',populationComplete:true}).available,true);
  const stale=observations.map(row=>({...row,observedAt:'2026-11-20T22:00:00.000Z'}));
  assert.equal(rankTrending(population,stale,options).available,false);
  const staleUnderlying=observations.map(row=>({...row,providerUpdatedAt:'2026-11-20T22:00:00.000Z'}));
  assert.equal(rankTrending(population,staleUnderlying,options).available,false);
  const future=observations.map(row=>({...row,observedAt:'2026-11-28T22:00:00.000Z'}));assert.equal(rankTrending(population,future,options).available,false);
});

test('category gaps, few positives and flat counters cannot create a meaningful popularity ranking',()=>{
  const gaps=observations.filter(row=>papers.find(p=>p.id===row.paperId).categories.includes('math.NT'));
  const result=rankTrending(population,gaps,{...options,minCoverage:0.4,minMeasured:3});
  assert.equal(result.available,false);assert.ok(result.reasons.some(r=>r.includes('math.PR')));
  assert.equal(rankTrending(population,observations.map(row=>({...row,value:1,status:'positive'})),options).available,false);
  assert.equal(rankTrending(population,observations.map((row,i)=>({...row,value:i<2?i+1:0,status:i<2?'positive':'zero'})),options).available,false);
});

test('latest failures suppress old values and simultaneous conflicting measurements stay ambiguous',()=>{
  const prior=observations.map(row=>({...row,observedAt:'2026-11-26T20:00:00.000Z'}));
  const failed=providerFailure('openaire',[papers[0].id],'network_failure',NOW,'outage');
  const report=coverageReport(population,[...prior,...failed],options);assert.equal(report.measured,5);assert.equal(report.outcomes.network_failure,1);
  const conflict=coverageReport(population,[...observations,{...observations[0],value:100}],options);
  assert.equal(conflict.outcomes.ambiguous_match,1);assert.equal(conflict.measured,5);
});

test('separate provider measurements are never blended and rolling/window-unknown metrics never imply Rising',()=>{
  const other=observations.map(row=>validateObservation({...row,provider:'ads',metric:'read_count',window:undefined,definitionVersion:undefined}));
  assert.deepEqual(rankTrending(population,[...observations,...other],options),rankTrending(population,observations,options));
  const rising=rankRising(population,[...observations,...observations.map(row=>({...row,observedAt:'2026-11-25T22:00:00.000Z',value:Math.floor(row.value/2)}))],options);
  assert.equal(rising.available,false);assert.equal(rising.entries.length,0);assert.ok(rising.reasons.some(r=>r.includes('cumulative')));
  assert.equal(rankRising(population,other,{...options,provider:'ads',metric:'read_count'}).available,false);
});

test('synthetic cumulative calculation rejects corrections, resets, changed windows and inadequate intervals',()=>{
  const definition={cumulative:true,windowKind:'cumulative',kind:'downloads'};
  const before={...observations[0],value:10,observedAt:'2026-11-25T22:00:00.000Z',window:{kind:'cumulative',start:'2026-11-01T00:00:00Z',days:null}},
    after={...before,value:34,observedAt:NOW};
  assert.deepEqual(cumulativeGrowth(before,after,definition),{velocity:1,change:24,intervalHours:24});
  for(const patch of [{value:4},{corrected:true},{counterEpoch:'reset'},{definitionVersion:'v2'},{observedAt:before.observedAt},
    {window:{...after.window,start:'2026-11-20T00:00:00Z'}},{window:{kind:'rolling',days:90}},{status:'metric_unavailable',value:null}])assert.equal(cumulativeGrowth(before,{...after,...patch},definition),null);
  assert.equal(cumulativeGrowth(before,after,{...definition,kind:'citations'}),null);
});

test('snapshot retention deduplicates exact observations, preserves conflicts and enforces age and size bounds',()=>{
  const old={...observations[0],observedAt:'2026-09-01T00:00:00Z'};
  const rows=retainObservations([...observations,...observations,old,{...observations[0],value:20}],{now:Date.parse(NOW),maxRecords:100});
  assert.equal(rows.length,7);assert.equal(rows.filter(row=>row.paperId===papers[0].id).length,2);
  assert.equal(retainObservations(rows,{now:Date.parse(NOW),maxRecords:3}).length,3);
});

test('OpenAIRE exact identifiers distinguish zero, missing, ambiguous and unindexed outcomes',()=>{
  const payload={results:[{id:'exact',pids:[{scheme:'arXiv',value:papers[0].id}],indicators:{usageCounts:{views:'0',downloads:'4'}}},
    {id:'missing',pids:[{scheme:'arXiv',value:papers[1].id}]},{id:'dupeA',pids:[{scheme:'arXiv',value:papers[2].id}]},{id:'dupeB',pids:[{scheme:'arXiv',value:papers[2].id}]}]};
  const rows=normalizeProviderResponse('openaire',papers.slice(0,4).map(p=>p.id),payload,{observedAt:NOW});
  assert.deepEqual(rows.filter(o=>o.metric==='views').map(o=>o.status),['zero','metric_unavailable','ambiguous_match','not_indexed']);
  assert.equal(rows[1].value,4);
  const bad=normalizeProviderResponse('openaire',[papers[0].id],{results:[{id:'uncertain',pids:[]}]},{observedAt:NOW});
  assert.ok(bad.every(o=>o.status==='ambiguous_match'));
  assert.equal(normalizeProviderResponse('openaire',[papers[0].id],{results:[]},{observedAt:NOW,complete:false})[0].status,'network_failure');
  assert.equal(normalizeProviderResponse('openaire',[papers[0].id],payload,{observedAt:NOW,complete:false})[0].status,'network_failure');
});

test('provider adapters preserve API identity and missing data instead of matching titles or AI quality scores',()=>{
  const s2=normalizeProviderResponse('semantic-scholar',papers.slice(0,2).map(p=>p.id),[{paperId:'abc',externalIds:{ArXiv:papers[0].id},citationCount:0},null],{observedAt:NOW});
  assert.deepEqual(s2.map(o=>o.status),['zero','not_indexed']);
  const arc=normalizeProviderResponse('arcxiv',[papers[0].id],{arxivId:papers[0].id,citationCount:null,qualitySignals:{impact:10}},{observedAt:NOW});
  assert.equal(arc[0].status,'metric_unavailable');assert.equal(arc[0].value,null);
  assert.equal(classifyProviderHttp(401),'authentication_failure');assert.equal(classifyProviderHttp(429),'rate_limit_failure');assert.equal(classifyProviderHttp(503),'network_failure');
  assert.throws(()=>providerPageInfo('openaire',{header:{numFound:100},results:[]}));
  const request=providerRequest('openaire',papers.map(p=>p.id),{token:'test-secret'});assert.ok(!request.url.includes('test-secret'));assert.equal(request.headers.Authorization,'Bearer test-secret');
});

test('sampling is reproducible across input order and covers primary-category/date strata without provider knowledge',()=>{
  const pool=Array.from({length:40},(_,i)=>({...papers[i%6],id:`2611.${String(i+1).padStart(5,'0')}`}));
  const first=stratifiedSample(pool,10,'seed'),second=stratifiedSample(pool.slice().reverse(),10,'seed');
  assert.deepEqual(first,second);assert.equal(first.papers.length,10);assert.equal(new Set(first.papers.map(p=>p.announcementDate)).size,2);
  assert.ok(first.design.strata.every(s=>s.inclusionProbability>0));
  assert.equal(stratifiedSample(pool,0,'seed').design.kind,'census');
  assert.throws(()=>stratifiedSample(pool,1,'seed'));
  assert.throws(()=>parseArguments(['--max-requests','1000']));
});

test('collector stops on real-shaped rate/auth failures without turning unqueried identifiers into misses',async()=>{
  const directory=fs.mkdtempSync(path.join(tmpdir(),'arxiv-readership-test-'));
  const filename=path.join(directory,'population.json'),pool=Array.from({length:120},(_,i)=>({...papers[0],id:`2611.${String(i+1).padStart(5,'0')}`}));
  fs.writeFileSync(filename,JSON.stringify(syntheticFrozenToday(pool)));
  const config={...parseArguments(['--population-json',filename]),rateState:path.join(directory,'rate.json')};
  let requests=0;
  try{
    const result=await measure(config,{request:async()=>{requests++;return new Response('{"message":"Too many requests"}',{status:429});},onProgress:()=>{}});
    assert.equal(requests,1);assert.equal(result.requestCount,1);
    const report=result.reports[0].byMetric.views;assert.equal(report.outcomes.rate_limit_failure,50);assert.equal(report.outcomes.untested,70);assert.equal(report.outcomes.not_indexed,0);
    assert.equal(report.indexingBounds.maximum.numerator,120);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('collector rejects stuck pagination and never certifies a partial provider search',async()=>{
  const directory=fs.mkdtempSync(path.join(tmpdir(),'arxiv-readership-pages-')),filename=path.join(directory,'population.json');
  fs.writeFileSync(filename,JSON.stringify(syntheticFrozenToday(papers)));
  let requestCount=0;
  try{
    const result=await measure({...parseArguments(['--population-json',filename]),rateState:path.join(directory,'rate.json')},
      {request:async()=>{requestCount++;return new Response(JSON.stringify({header:{numFound:2,page:1,pageSize:1},results:[{id:'one',pids:[{scheme:'arxiv',value:papers[0].id}]}]}),{status:200});},onProgress:()=>{}});
    assert.equal(requestCount,2);assert.equal(result.reports[0].byMetric.views.matched,0);assert.equal(result.reports[0].byMetric.views.outcomes.network_failure,6);
    assert.match(result.stopReason,/pagination page/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

function syntheticFrozenToday(pool) {
  const rows=pool.map(paper=>({...paper,version:0,announcementDate:'2026-11-26',section:'new'}));
  return {population:'today',papers:rows,complete:true,baseUrl:'https://arxiv.org/list/math/new',announcementDate:'2026-11-26',
    advertisedTotal:rows.length,counts:{total:rows.length,new:rows.length,cross:0,replacement:0},sectionTotals:{new:rows.length},warnings:[],integrityWarnings:[],nextUrls:[]};
}

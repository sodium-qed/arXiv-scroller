#!/usr/bin/env node
// Reproduce the recorded experiment without network access or provider keys.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateObservationFile,coverageReport,rankTrending,rankRising} from '../src/readership.js';
import {normalizeProviderResponse,providerPageInfo} from '../src/readership-providers.js';
import {loadPopulations} from './measure-indexing-coverage.mjs';

const directory=path.resolve(process.argv[2]||'research/trending');
const summary=JSON.parse(fs.readFileSync(path.join(directory,'coverage-results.json'),'utf8'));
const observations=validateObservationFile(JSON.parse(fs.readFileSync(path.join(directory,summary.observationFile),'utf8'))).observations;
const ids=new Set(),replayed=[];
for(const request of summary.requests){
  assert.equal(request.httpStatus,200,'This replay is for the successful recorded OpenAIRE census.');
  const bytes=fs.readFileSync(path.join(directory,request.responseFile));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),request.responseSha256,'Raw provider response checksum');
  const data=JSON.parse(bytes),page=providerPageInfo(summary.provider,data);
  assert.equal(page.hasNext,false,'A complete query response is required by this archived run.');
  assert.equal(data.results.length,page.total,'Provider records reconcile');
  for(const id of request.requestedIds){assert.ok(!ids.has(id),'Every union identifier queried once');ids.add(id);}
  const observedAt=observations.find(o=>o.paperId===request.requestedIds[0]).observedAt;
  replayed.push(...normalizeProviderResponse(summary.provider,request.requestedIds,data,{observedAt,sourceUrl:request.url,complete:true}));
}
const sorted=rows=>rows.slice().sort((a,b)=>`${a.paperId}:${a.metric}`.localeCompare(`${b.paperId}:${b.metric}`));
assert.deepEqual(sorted(replayed),sorted(observations),'Normalized observations reproduce from exact raw provider replies');
const results=[];
for(const report of summary.reports){
  const [population]=loadPopulations([path.join(directory,'populations',report.inputFile)]);
  assert.equal(population.inputSha256,report.inputSha256,'Frozen population checksum');
  for(const [metric,expected] of Object.entries(report.byMetric)){
    const options={provider:summary.provider,metric,now:summary.finishedAt};
    const actual=coverageReport(population,observations,options);
    assert.deepEqual(actual,expected,'Coverage ratios and cohort/category breakdowns reproduce');
    results.push({population:population.population,metric,total:actual.total,indexed:actual.matched,measured:actual.measured,positive:actual.positive,
      trendingAvailable:rankTrending(population,observations,options).available,risingAvailable:rankRising(population,observations,options).available});
  }
}
console.log(JSON.stringify({verified:true,requests:summary.requests.length,distinctQueriedIds:ids.size,results},null,2));

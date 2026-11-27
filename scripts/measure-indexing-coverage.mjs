#!/usr/bin/env node
// Reproducible observation collector. Only public paper IDs reach providers.
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {coverageReport,retainObservations,validateObservationFile,normalizeObservationId} from '../src/readership.js';
import {validatePopulationSnapshot} from '../src/network.js';
import {PROVIDER_METRICS,PROVIDER_BATCH_SIZE,providerRequest,providerFailure,normalizeProviderResponse,
  providerPageInfo,classifyProviderHttp} from '../src/readership-providers.js';

export function parseArguments(args) {
  const result={populationFiles:[],provider:'openaire',output:'research/trending/latest',sampleSize:0,seed:'arxiv-trending-v1',maxRequests:50,intervalSeconds:1,category:null,history:null,
    rateState:path.join(tmpdir(),'arxiv-readership-rate-state.json')};
  const fields={'--provider':'provider','--output':'output','--sample-size':'sampleSize','--seed':'seed','--max-requests':'maxRequests','--interval-seconds':'intervalSeconds','--category':'category','--history':'history','--rate-state':'rateState'};
  for(let i=0;i<args.length;i++){
    const name=args[i];if(name==='--help'){result.help=true;continue;}
    if(name==='--allow-provider-storage'){result.allowProviderStorage=true;continue;}
    if(name==='--population-json'){if(!args[i+1])throw new Error('Missing population file.');result.populationFiles.push(args[++i]);continue;}
    if(!fields[name]||args[i+1]===undefined)throw new Error('Unknown or incomplete argument '+name);
    result[fields[name]]=args[++i];
  }
  for(const key of ['sampleSize','maxRequests','intervalSeconds']){result[key]=Number(result[key]);if(!Number.isFinite(result[key])||result[key]<0)throw new Error('Invalid '+key);}
  if(!Number.isInteger(result.sampleSize)||!Number.isInteger(result.maxRequests)||result.maxRequests<1)throw new Error('Integer request/sample limits required.');
  if(!PROVIDER_METRICS[result.provider])throw new Error('Unsupported provider.');
  if(result.provider==='openaire'&&result.maxRequests>60&&!process.env.OPENAIRE_TOKEN)throw new Error('Anonymous OpenAIRE runs are capped at60 requests/hour, including requests recorded in the local rate ledger.');
  return result;
}

function hash(seed,id){return createHash('sha256').update(seed+'\0'+id).digest('hex');}

export function stratifiedSample(papers,size,seed) {
  if(!size||size>=papers.length)return {papers,design:{kind:'census',seed,sampleSize:papers.length,populationSize:papers.length,strata:[]}};
  // Primary-category x full category-set x announcement-date strata avoid selecting known indexed
  // papers. Nonempty strata get one slot first, then proportional deficits.
  const groups=new Map();
  for(const paper of papers){const key=(paper.primaryCategory||'unknown')+'|'+[...(paper.categories||[])].sort().join(',')+'|'+(paper.announcementDate||'unknown');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(paper);}
  const strata=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,rows])=>({key,rows:rows.slice().sort((a,b)=>hash(seed,a.id).localeCompare(hash(seed,b.id))),count:0}));
  if(size<strata.length)throw new Error(`Sample size ${size} cannot represent all ${strata.length} category/date strata; increase it or run a census.`);
  for(const stratum of strata)stratum.count=1;
  for(let count=strata.length;count<size;count++){
    const next=strata.filter(s=>s.count<s.rows.length).sort((a,b)=>(b.rows.length*size/papers.length-b.count)-(a.rows.length*size/papers.length-a.count)||a.key.localeCompare(b.key))[0];
    next.count++;
  }
  return {papers:strata.flatMap(s=>s.rows.slice(0,s.count)),design:{kind:'stratified-random-without-replacement',seed,sampleSize:size,populationSize:papers.length,
    strata:strata.map(s=>({key:s.key,populationSize:s.rows.length,sampleSize:s.count,inclusionProbability:s.count/s.rows.length})),
    uncertainty:'Observed sample ratios are not census coverage. Full-population reports preserve unsampled papers as untested; conservative identification bounds are reported. Stratum inclusion probabilities permit independent design-based estimation.'}};
}

export function loadPopulations(filenames,category=null) {
  if(!filenames.length)throw new Error('Provide --population-json for each frozen authoritative population. See scripts/freeze-readership-population.py.');
  return filenames.map(filename=>{
    const population=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(!['today','recent'].includes(population.population)||population.complete!==true||!Array.isArray(population.papers))throw new Error('A verified complete Today/Recent population is required: '+filename);
    validatePopulationSnapshot(population);
    if(population.papers.some(paper=>normalizeObservationId(paper.id)!==paper.id))throw new Error('The frozen population contains a noncanonical arXiv identifier.');
    const papers=category?population.papers.filter(p=>p.categories?.includes(category)):population.papers;
    return {...population,papers,measurementCategoryFilter:category,inputFile:path.basename(filename),inputSha256:createHash('sha256').update(fs.readFileSync(filename)).digest('hex')};
  });
}

export async function measure(config,{request=fetch,onProgress=console.error}={}) {
  const populations=loadPopulations(config.populationFiles,config.category),provider=config.provider;
  const all=new Map();for(const population of populations)for(const paper of population.papers)if(!all.has(paper.id))all.set(paper.id,paper);
  let selected=stratifiedSample([...all.values()],0,config.seed);
  if(config.sampleSize){
    const perPopulation=populations.map(population=>{
      if(config.sampleSize<Math.min(100,population.papers.length))throw new Error('A sampling fallback must include at least100 papers per population where feasible.');
      return {population:population.population,...stratifiedSample(population.papers,config.sampleSize,config.seed+':'+population.population)};
    });
    const union=new Map();for(const sample of perPopulation)for(const paper of sample.papers)union.set(paper.id,paper);
    selected={papers:[...union.values()],design:{kind:'union-of-independent-stratified-population-samples',seed:config.seed,sampleSize:union.size,populationSize:all.size,
      perPopulation:perPopulation.map(({population,design})=>({population,...design})),
      uncertainty:'Each original design records exact stratum probabilities. Reused observations from overlapping populations add opportunistic coverage; do not treat combined observed ratios as an unbiased prevalence estimator. Full-population identification bounds retain every untested paper.'}};
  }
  const ids=selected.papers.map(p=>p.id);
  const tokenNames={openaire:'OPENAIRE_TOKEN',ads:'ADS_API_TOKEN',mendeley:'MENDELEY_TOKEN','semantic-scholar':'SEMANTIC_SCHOLAR_API_KEY'};
  const token=process.env[tokenNames[provider]]||'';
  if(provider==='ads'&&token&&!config.allowProviderStorage)throw new Error('ADS forbids third-party redistribution and restricts regular storage. Obtain provider permission before using --allow-provider-storage; no data was requested.');
  const startedAt=new Date().toISOString(),observations=[],requests=[];
  let stopped=false,stopReason=null,requestCount=0,lastRequest=0;
  const chunkSize=PROVIDER_BATCH_SIZE[provider];
  for(let offset=0;offset<ids.length&&!stopped;offset+=chunkSize){
    const batch=ids.slice(offset,offset+chunkSize);let payload=null,complete=true,page=1,expected=null,rows=[];
    while(true){
      if(requestCount>=config.maxRequests){stopped=true;stopReason='Configured request limit reached.';complete=false;break;}
      const descriptor=providerRequest(provider,batch,{page,token});
      if(provider==='openaire'){
        const stateFile=config.rateState||path.join(tmpdir(),'arxiv-readership-rate-state.json');
        const ledger=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{openaire:[]};
        if(!Array.isArray(ledger.openaire))throw new Error('Invalid rate-limit ledger; inspect it before running another collector.');
        ledger.openaire=ledger.openaire.filter(time=>Number.isFinite(time)&&time>Date.now()-3600000);
        if(ledger.openaire.length>=(token?7200:60)){stopped=true;complete=false;stopReason='The documented OpenAIRE hourly request budget is exhausted; remaining papers were not queried.';break;}
        ledger.openaire.push(Date.now());fs.mkdirSync(path.dirname(stateFile),{recursive:true});
        fs.writeFileSync(stateFile+'.tmp',JSON.stringify(ledger));fs.renameSync(stateFile+'.tmp',stateFile);
      }
      const remaining=lastRequest+Math.max(config.intervalSeconds,1)*1000-Date.now();if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
      lastRequest=Date.now();requestCount++;
      const observedAt=new Date().toISOString();
      let response,body,data;
      try{
        response=await request(descriptor.url,{method:descriptor.method,headers:descriptor.headers,body:descriptor.body,redirect:'error',signal:AbortSignal.timeout(30000)});
        body=await response.text();if(body.length>16000000)throw new Error('Provider response exceeded16MB.');
        const failure=classifyProviderHttp(response.status);
        requests.push({url:descriptor.url,method:descriptor.method,requestedIds:batch,httpStatus:response.status,observedAt,
          responseSha256:createHash('sha256').update(body).digest('hex'),retryAfter:response.headers.get('retry-after'),
          // Public OpenAIRE records are CC-BY. Other providers retain only parsed
          // observation/error evidence, never confidential credentials.
          ...(provider==='openaire'?{responseBody:body}:{})});
        if(failure){observations.push(...providerFailure(provider,batch,failure,observedAt,'HTTP '+response.status,descriptor.url));stopped=true;stopReason='Provider returned HTTP '+response.status+'; no retries or further requests were made.';payload=null;break;}
        data=JSON.parse(body);const info=providerPageInfo(provider,data);
        if(info.page!==page)throw new Error('Provider returned a different pagination page than requested.');
        if(expected!==null&&expected!==info.total)throw new Error('Provider total changed during pagination.');expected=info.total;
        if(provider==='openaire'){
          const previousIds=new Set(rows.map(row=>row?.id));
          if(data.results.some(row=>row?.id&&previousIds.has(row.id)))throw new Error('Provider repeated a record across result pages.');
          rows.push(...data.results);payload={...data,results:rows};
          if(info.hasNext){page++;continue;}
          if(rows.length!==info.total)throw new Error('Provider results do not reconcile with advertised count.');
        }else{payload=data;complete=!info.hasNext;}
        break;
      }catch(error){
        const message=error.name==='TimeoutError'?'Provider request timed out.':'Provider request or response validation failed: '+String(error.message).slice(0,300);
        observations.push(...providerFailure(provider,batch,'network_failure',observedAt,message,descriptor.url));
        if(!response)requests.push({url:descriptor.url,method:descriptor.method,requestedIds:batch,httpStatus:null,observedAt,error:message});
        stopped=true;stopReason=message;payload=null;break;
      }
    }
    if(payload){observations.push(...normalizeProviderResponse(provider,batch,payload,{observedAt:new Date().toISOString(),sourceUrl:providerRequest(provider,batch).url,complete}));}
    onProgress(`${provider}: ${Math.min(offset+chunkSize,ids.length)}/${ids.length} selected identifiers; ${requestCount} requests${stopped?' (stopped)':''}`);
  }
  const attempted=new Set(observations.map(o=>o.paperId));
  const finishedAt=new Date().toISOString();
  for(const paperId of all.keys())if(!attempted.has(paperId))observations.push(...providerFailure(provider,[paperId],'untested',finishedAt,
    ids.includes(paperId)?stopReason||'No provider request completed.':'Not selected by the documented sampling design.'));
  const reports=populations.map(population=>({population:population.population,sourceUrl:population.baseUrl??population.sourceUrl,
    frozenAt:population.fetchedAt??population.retrievedAt??null,inputSha256:population.inputSha256,
    byMetric:Object.fromEntries(PROVIDER_METRICS[provider].map(metric=>[metric,coverageReport(population,observations,{provider,metric,now:finishedAt})]))}));
  return {schemaVersion:1,startedAt,finishedAt,provider,requestCount,stopReason,
    experimentScope:selected.design,observations,reports,requests,
    interpretation:'All-population observed coverage uses the frozen eligible denominator. Untested, ambiguous, authentication, rate-limit, and network outcomes remain unresolved; no unresolved outcome is a confirmed indexing miss. Announcement-date cohorts do not measure exact latency.'};
}

const csvValue=value=>{const text=String(value??'');return '"'+(/^[=+\-@]/.test(text)?"'":'')+text.replaceAll('"','""')+'"';};
export function writeResults(result,config) {
  const output=path.resolve(config.output);fs.mkdirSync(output,{recursive:true});
  const requests=result.requests.map((request,index)=>{
    const {responseBody,...metadata}=request;
    if(responseBody===undefined)return metadata;
    const responseFile='provider-responses/'+String(index+1).padStart(3,'0')+'.json';
    fs.mkdirSync(path.join(output,'provider-responses'),{recursive:true});fs.writeFileSync(path.join(output,responseFile),responseBody);
    return {...metadata,responseFile};
  });
  const {observations,...summary}=result;
  fs.writeFileSync(path.join(output,'coverage-results.json'),JSON.stringify({...summary,observationFile:'observations.json',requests},null,2)+'\n');
  fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify({schemaVersion:1,observations})+'\n');
  const populations=loadPopulations(config.populationFiles,config.category),fields=['population','paperId','version','announcementDate','ageDays','primaryCategory','categories','submissionType','provider','metric','status','value','observedAt','providerUpdatedAt','window','definitionVersion','providerRecordId','sourceUrl','error'];
  const records=[];
  for(const population of populations){const byId=new Map(population.papers.map(p=>[p.id,p]));for(const observation of result.observations){const paper=byId.get(observation.paperId);if(!paper)continue;
    records.push({population:population.population,...observation,version:paper.version,announcementDate:paper.announcementDate,
      ageDays:paper.announcementDate?Math.floor((Date.parse(observation.observedAt)-Date.parse(paper.announcementDate+'T00:00:00Z'))/86400000):null,
      primaryCategory:paper.primaryCategory,categories:(paper.categories||[]).join(';'),submissionType:paper.section,window:JSON.stringify(observation.window)});}}
  fs.writeFileSync(path.join(output,'coverage-results.csv'),[fields.map(csvValue).join(','),...records.map(record=>fields.map(field=>csvValue(record[field])).join(','))].join('\n')+'\n');
  if(config.history){
    if(config.provider==='ads'&&!config.allowProviderStorage)throw new Error('ADS history requires documented provider permission.');
    const previous=fs.existsSync(config.history)?validateObservationFile(JSON.parse(fs.readFileSync(config.history,'utf8'))).observations:[];
    const observations=retainObservations([...previous,...result.observations],{now:Date.parse(result.finishedAt)});
    const temporary=config.history+'.tmp';fs.mkdirSync(path.dirname(path.resolve(config.history)),{recursive:true});
    fs.writeFileSync(temporary,JSON.stringify({schemaVersion:1,observations},null,2)+'\n');fs.renameSync(temporary,config.history);
  }
}

export async function main(args=process.argv.slice(2)) {
  const config=parseArguments(args);
  if(config.help){console.log('node scripts/measure-indexing-coverage.mjs --population-json recent.json [--population-json today.json] --provider openaire --output DIR [--sample-size N --seed TEXT --category math.NT --max-requests 50 --history FILE]\nFreeze authoritative populations first with scripts/freeze-readership-population.py. Token environment names: OPENAIRE_TOKEN, ADS_API_TOKEN, MENDELEY_TOKEN, SEMANTIC_SCHOLAR_API_KEY. Credentials never enter results.');return;}
  const result=await measure(config);writeResults(result,config);console.log(JSON.stringify({provider:result.provider,requestCount:result.requestCount,stopReason:result.stopReason,output:path.resolve(config.output)}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});

// External observations are independent of feedback, knowledge, and reading history.
import {CATEGORIES, normalizeCategory} from './categories.js';

export const READERSHIP_SCHEMA_VERSION = 1;
export const OUTCOMES = Object.freeze(['indexed', 'not_indexed', 'metric_unavailable', 'zero', 'positive',
  'ambiguous_match', 'authentication_failure', 'rate_limit_failure', 'network_failure', 'untested']);
export const DEFAULT_QUALITY = Object.freeze({minCoverage:0.75, minCategoryCoverage:0.25,
  minMeasured:5, minPositive:3, maxAgeHours:48, minIntervalHours:1, maxIntervalHours:168});

// A timestamped observation is not evidence of a provider's update frequency.
// None of the investigated readership providers currently documents a verified
// cumulative counter. The Rising gate remains closed for these definitions.
export const METRIC_DEFINITIONS = Object.freeze({
  'ads:read_count':Object.freeze({provider:'ads', metric:'read_count', label:'ADS + arXiv accesses (rolling 90 days)',
    kind:'accesses', windowKind:'rolling', windowDays:90, definitionVersion:'ads-read-count-2026-11',
    cumulative:false, source:'https://adsabs.github.io/scixhelp/search-scix/comprehensive-solr-term-list',
    limitation:'Combined access types; not unique people or a separate PDF-download count.', retentionRestricted:true}),
  'mendeley:reader_count':Object.freeze({provider:'mendeley', metric:'reader_count', label:'Mendeley library saves',
    kind:'saves', windowKind:'stock', definitionVersion:'mendeley-reader-count-2026-11', cumulative:false,
    source:'https://dev.mendeley.com/methods',
    limitation:'Current library membership; a save does not establish a read or download.', retentionRestricted:false}),
  'openaire:views':Object.freeze({provider:'openaire', metric:'views', label:'OpenAIRE network views',
    kind:'views', windowKind:'unknown', definitionVersion:'openaire-usage-counts-2026-11', cumulative:false,
    source:'https://graph.openaire.eu/docs/data-model/entities/other/',
    limitation:'Usage reported by participating sources; the Graph field does not specify a measurement window or prove arXiv-site coverage.', retentionRestricted:false}),
  'openaire:downloads':Object.freeze({provider:'openaire', metric:'downloads', label:'OpenAIRE network downloads',
    kind:'downloads', windowKind:'unknown', definitionVersion:'openaire-usage-counts-2026-11', cumulative:false,
    source:'https://graph.openaire.eu/docs/data-model/entities/other/',
    limitation:'Downloads reported by participating sources; the Graph field does not specify a measurement window or prove arXiv-site coverage.', retentionRestricted:false}),
  'semantic-scholar:citation_count':Object.freeze({provider:'semantic-scholar', metric:'citation_count', label:'Semantic Scholar citations',
    kind:'citations', windowKind:'unknown', definitionVersion:'semantic-scholar-citations-2026-11', cumulative:false,
    source:'https://api.semanticscholar.org/api-docs/graphs',
    limitation:'Citations measure scholarly attention, not readership; indexing and corrections can change counts.', retentionRestricted:false}),
  'arcxiv:citation_count':Object.freeze({provider:'arcxiv', metric:'citation_count', label:'ArcXiv citations',
    kind:'citations', windowKind:'unknown', definitionVersion:'arcxiv-citations-2026-11', cumulative:false,
    source:'https://arcxiv.org/docs/agents',
    limitation:'Citations are not readership. AI quality signals are never admitted as observed attention.', retentionRestricted:false})
});

const ID=/^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3})$/;
const measuredStatuses=new Set(['zero','positive']);
const matchedStatuses=new Set(['indexed','metric_unavailable','zero','positive']);
// An imported observation may name a supported provider, but that must not turn
// an unrelated destination into a trusted-looking "Provider record" link.
const PROVIDER_SOURCE_HOSTS=Object.freeze({
  ads:['adsabs.harvard.edu','ui.adsabs.harvard.edu','api.adsabs.harvard.edu','scixplorer.org','www.scixplorer.org','adsabs.github.io'],
  mendeley:['mendeley.com','www.mendeley.com','api.mendeley.com','dev.mendeley.com'],
  openaire:['openaire.eu','www.openaire.eu','api.openaire.eu','explore.openaire.eu','graph.openaire.eu','usagecounts.openaire.eu'],
  'semantic-scholar':['semanticscholar.org','www.semanticscholar.org','api.semanticscholar.org'],
  arcxiv:['arcxiv.org','www.arcxiv.org']
});
const CREDENTIAL_QUERY_KEYS=new Set(['key','apikey','xapikey','accesskey','accesskeyid','awsaccesskeyid','subscriptionkey','privatekey','password','passwd','pass',
  'authorization','auth','authcode','authorizationcode','bearer','jwt','secret','clientsecret','token','accesstoken','refreshtoken','idtoken','oauth',
  'oauthcode','code','credential','credentials','signature','sig','session','sessionid','sessionkey','sessiontoken']);
const PROVIDER_PUBLIC_QUERY_KEYS=Object.freeze({
  ads:['q','fl','rows','start','sort','bibcode'],
  mendeley:['arxiv','view','id','doi'],
  openaire:['filter','page','pagesize','pid','doi','id','query','search','keywords'],
  'semantic-scholar':['fields','limit','offset'],
  arcxiv:[]
});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function requireValue(ok,label){if(!ok)throw new Error('Invalid readership '+label+'.');}
function text(value,label,maximum=1000){requireValue(typeof value==='string'&&value.length<=maximum&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),label);return value;}
function instant(value,label){requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)),label);return new Date(value).toISOString();}
function finite(value,label,min=0,max=Number.MAX_SAFE_INTEGER){requireValue(Number.isFinite(value)&&value>=min&&value<=max,label);return value;}
function safeUrl(value,provider){
  if(value==null)return null;
  const url=new URL(text(value,'source URL',2048));
  requireValue(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.port&&
    PROVIDER_SOURCE_HOSTS[provider]?.includes(url.hostname),'provider source URL');
  for(const name of url.searchParams.keys()){
    const key=name.toLowerCase().replace(/[^a-z0-9]/g,'');
    requireValue(!CREDENTIAL_QUERY_KEYS.has(key)&&!/(?:token|password|passwd|secret|credential|signature)/.test(key),
      'credential-bearing source URL');
    requireValue(PROVIDER_PUBLIC_QUERY_KEYS[provider]?.includes(key),'provider source URL parameter');
  }
  return url.href;
}

export function normalizeObservationId(raw) {
  if(typeof raw!=='string')return null;
  const id=raw.trim().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i,'').replace(/^arxiv:\s*/i,'')
    .replace(/\.pdf$/i,'').replace(/v[1-9]\d*$/i,'').replace(/\.[a-z]{2}(?=\/)/i,'').toLowerCase();
  return ID.test(id)?id:null;
}

export function validateObservation(raw) {
  requireValue(plain(raw),'observation');
  const paperId=normalizeObservationId(raw.paperId);
  requireValue(Boolean(paperId),'paper identifier');
  const definition=METRIC_DEFINITIONS[`${raw.provider}:${raw.metric}`];
  requireValue(Boolean(definition),'provider and metric');
  requireValue(OUTCOMES.includes(raw.status),'outcome');
  const status=raw.status;
  const measured=measuredStatuses.has(status),matched=matchedStatuses.has(status);
  const value=raw.value??null;
  if(measured){finite(value,'metric value');requireValue(Number.isSafeInteger(value),'integer metric count');requireValue(status==='zero'?value===0:value>0,'metric outcome');}
  else requireValue(value===null,'missing metric value');
  requireValue(!matched||raw.match==='exact_identifier','identity match');
  requireValue(raw.match==null||raw.match==='exact_identifier','identity match');
  const observedAt=instant(raw.observedAt,'observation timestamp');
  const providerUpdatedAt=raw.providerUpdatedAt==null?null:instant(raw.providerUpdatedAt,'provider timestamp');
  requireValue(!providerUpdatedAt||Date.parse(providerUpdatedAt)<=Date.parse(observedAt)+300000,'provider timestamp');
  const definitionVersion=raw.definitionVersion??definition.definitionVersion;
  requireValue(definitionVersion===definition.definitionVersion,'metric definition version');
  const defaultWindow={kind:definition.windowKind,days:definition.windowDays??null,start:null,end:null};
  const window=raw.window??defaultWindow;
  requireValue(plain(window)&&window.kind===definition.windowKind,'measurement window');
  requireValue((window.days??null)===(definition.windowDays??null),'measurement window length');
  const start=window.start==null?null:instant(window.start,'window start'),end=window.end==null?null:instant(window.end,'window end');
  requireValue(!start||!end||Date.parse(start)<Date.parse(end),'measurement window order');
  requireValue(!end||Date.parse(end)<=Date.parse(observedAt)+300000,'measurement window end');
  requireValue(raw.corrected===undefined||typeof raw.corrected==='boolean','correction flag');
  return {paperId,provider:definition.provider,metric:definition.metric,status,value,observedAt,providerUpdatedAt,
    window:{kind:definition.windowKind,days:definition.windowDays??null,start,end},definitionVersion,
    providerRecordId:raw.providerRecordId==null?null:text(raw.providerRecordId,'provider record identifier',500),
    sourceUrl:safeUrl(raw.sourceUrl,definition.provider),match:matched?'exact_identifier':null,
    corrected:raw.corrected===true,counterEpoch:raw.counterEpoch==null?null:text(raw.counterEpoch,'counter epoch',200),
    error:raw.error==null?null:text(raw.error,'diagnostic',2000)};
}

export function validateObservationFile(raw) {
  requireValue(plain(raw)&&raw.schemaVersion===READERSHIP_SCHEMA_VERSION,'snapshot schema');
  requireValue(Array.isArray(raw.observations)&&raw.observations.length<=100000,'snapshot size');
  const observations=raw.observations.map(validateObservation);
  return {schemaVersion:READERSHIP_SCHEMA_VERSION,observations};
}
export const validateSnapshot=validateObservationFile;

export function retainObservations(raw,{now=Date.now(),retentionDays=30,maxRecords=50000}={}) {
  finite(now,'retention clock');finite(retentionDays,'retention days',1,365);finite(maxRecords,'retention size',1,100000);
  const cutoff=now-retentionDays*86400000,map=new Map();
  for(const candidate of raw){const observation=validateObservation(candidate),time=Date.parse(observation.observedAt);
    if(time<cutoff||time>now+300000)continue;
    // Keep conflicts. The latest-observation resolver marks them ambiguous.
    const key=JSON.stringify(observation);map.set(key,observation);
  }
  return [...map.values()].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.paperId.localeCompare(b.paperId)).slice(0,maxRecords);
}

function normalizePopulation(population,options={}) {
  const source=Array.isArray(population)?{papers:population,population:options.population,complete:options.populationComplete}:population;
  const seen=new Set(),papers=[];let invalid=!Array.isArray(source?.papers);
  for(const paper of source?.papers||[]){const id=normalizeObservationId(paper?.id);if(!id||id!==paper.id||seen.has(id)){invalid=true;continue;}seen.add(id);papers.push({...paper,id});}
  if(source?.distinctTotal!==undefined&&source.distinctTotal!==null&&source.distinctTotal!==papers.length)invalid=true;
  if(source?.counts?.total!==undefined&&source.counts.total!==papers.length)invalid=true;
  return {...source,papers,complete:source?.complete===true&&!invalid,populationIntegrity:invalid?'Invalid or duplicate identifiers, or inconsistent distinct-population counts.':null};
}
function optionsWithDefaults(options) {
  const result={...DEFAULT_QUALITY,...options};
  for(const key of ['minCoverage','minCategoryCoverage'])finite(result[key],key,0,1);
  for(const key of ['minMeasured','minPositive'])finite(result[key],key,1,100000);
  finite(result.maxAgeHours,'freshness hours',0.01,720);finite(result.minIntervalHours,'minimum observation interval',0.01,720);
  finite(result.maxIntervalHours,'maximum observation interval',result.minIntervalHours,8760);
  result.now=typeof result.now==='string'?Date.parse(result.now):result.now??Date.now();finite(result.now,'clock');
  return result;
}
function latestObservations(observations,provider,metric) {
  const map=new Map();
  for(const raw of observations||[]) {
    const observation=validateObservation(raw);
    if(observation.provider!==provider||observation.metric!==metric)continue;
    const previous=map.get(observation.paperId);
    if(!previous||observation.observedAt>previous.observedAt)map.set(observation.paperId,observation);
    else if(observation.observedAt===previous.observedAt&&JSON.stringify(observation)!==JSON.stringify(previous)) {
      map.set(observation.paperId,{...observation,status:'ambiguous_match',value:null,match:null,error:'Conflicting observations share the same timestamp.'});
    }
  }
  return map;
}
function fresh(observation,options) {
  if(!observation)return false;
  const time=Date.parse(observation.observedAt),updated=observation.providerUpdatedAt?Date.parse(observation.providerUpdatedAt):time;
  return time<=options.now+300000&&time>=options.now-options.maxAgeHours*3600000&&updated>=options.now-options.maxAgeHours*3600000;
}
const ratio=(numerator,denominator)=>({numerator,denominator,percentage:denominator?numerator/denominator*100:null});
function categoryList(paper){return [...new Set((paper.categories||[]).map(normalizeCategory).filter(c=>Object.hasOwn(CATEGORIES,c)))];}
function countCoverage(papers,map,options) {
  let matched=0,measured=0,positive=0,freshMeasured=0;
  const outcomes=Object.fromEntries(OUTCOMES.map(outcome=>[outcome,0]));
  for(const paper of papers){const observation=map.get(paper.id),status=observation?.status||'untested';outcomes[status]++;
    if(matchedStatuses.has(status))matched++;
    if(measuredStatuses.has(status)){measured++;if(observation.value>0)positive++;if(fresh(observation,options))freshMeasured++;}
  }
  const unresolved=outcomes.ambiguous_match+outcomes.authentication_failure+outcomes.rate_limit_failure+outcomes.network_failure+outcomes.untested;
  return {total:papers.length,matched,measured,positive,freshMeasured,unresolved,outcomes,
    indexing:ratio(matched,papers.length),metric:ratio(measured,papers.length),positiveActivity:ratio(positive,papers.length),
    conditionalMetric:ratio(measured,matched),conditionalPositive:ratio(positive,measured),freshMetric:ratio(freshMeasured,papers.length),
    // Bounds make clear that unresolved requests are not confirmed misses.
    indexingBounds:{minimum:ratio(matched,papers.length),maximum:ratio(matched+unresolved,papers.length)},
    metricBounds:{minimum:ratio(measured,papers.length),maximum:ratio(measured+unresolved,papers.length)}};
}

export function coverageReport(population,observations,options={}) {
  const config=optionsWithDefaults(options),source=normalizePopulation(population,config);
  const map=latestObservations(observations,config.provider,config.metric),papers=source.papers;
  const report=countCoverage(papers,map,config);
  report.byCategory=Object.fromEntries(Object.keys(CATEGORIES).map(category=>[category,countCoverage(papers.filter(p=>categoryList(p).includes(category)),map,config)]));
  const groupBy=fn=>{const groups=new Map();for(const paper of papers){const key=fn(paper);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(paper);}return Object.fromEntries([...groups].map(([key,rows])=>[key,countCoverage(rows,map,config)]));};
  report.byAnnouncementDate=groupBy(p=>p.announcementDate||'unknown');
  report.bySubmissionType=groupBy(p=>p.section||'unknown');
  report.byAgeDays=groupBy(p=>p.announcementDate?String(Math.floor((config.now-Date.parse(p.announcementDate+'T00:00:00Z'))/86400000)):'unknown');
  report.provider=config.provider??null;report.metricType=config.metric??null;
  report.population=source.population??'unknown';report.populationComplete=source.complete===true;
  return report;
}

function quality(source,observations,config,definition) {
  const reasons=[],coverage=coverageReport(source,observations,config),map=latestObservations(observations,config.provider,config.metric);
  if(source.population!=='recent')reasons.push('Trending and Rising require the authoritative arXiv Recent population.');
  if(source.complete!==true)reasons.push('The Recent population is incomplete; coverage denominators are not verified.');
  if(!definition)reasons.push('Choose a supported provider and observed metric.');
  const eligible=source.papers.map(p=>({paper:p,observation:map.get(p.id)})).filter(({observation:o})=>o&&measuredStatuses.has(o.status)&&fresh(o,config));
  if(coverage.freshMeasured<config.minMeasured)reasons.push(`Only ${coverage.freshMeasured} papers have recently retrieved measurements; at least ${config.minMeasured} are required. Provider update freshness is disclosed separately.`);
  if(!coverage.total||coverage.freshMeasured/coverage.total<config.minCoverage)reasons.push(`Recent-observation coverage is below the configured ${Math.round(config.minCoverage*100)}% minimum.`);
  if(eligible.filter(({observation:o})=>o.value>0).length<config.minPositive)reasons.push('Too few papers have positive observed activity.');
  if(new Set(eligible.map(({observation:o})=>o.value)).size<2)reasons.push('Available measurements do not discriminate between papers.');
  const gaps=Object.entries(coverage.byCategory).filter(([,c])=>c.total&&c.freshMeasured/c.total<config.minCategoryCoverage).map(([category])=>category);
  if(gaps.length)reasons.push(`Insufficient category coverage: ${gaps.join(', ')}.`);
  return {reasons,coverage,eligible};
}
function baseResult(definition,coverage,reasons) {
  return {available:reasons.length===0,entries:[],coverage,reasons,metricDefinition:definition??null,
    label:definition?.label??'Observed readership',
    message:reasons.length?'Insufficient readership data to establish a meaningful trending ranking.':null,
    ageDisclosure:'Raw counts are compared within the current Recent population. Older announcements may have had longer to accumulate attention; no unsupported age correction is applied.',
    freshnessDisclosure:'Observation time is shown separately from the provider update time. An unknown provider update time does not establish fresh underlying activity.'};
}

export function rankTrending(population,observations=[],options={}) {
  const config=optionsWithDefaults(options),source=normalizePopulation(population,config),definition=METRIC_DEFINITIONS[`${config.provider}:${config.metric}`];
  const {reasons,coverage,eligible}=quality(source,observations,config,definition),result=baseResult(definition,coverage,reasons);
  if(!result.available)return result;
  eligible.sort((a,b)=>b.observation.value-a.observation.value||a.paper.id.localeCompare(b.paper.id));
  let rank=0,last=null;
  result.entries=eligible.map(({paper,observation},index)=>{if(observation.value!==last){rank=index+1;last=observation.value;}
    return {paperId:paper.id,rank,value:observation.value,observation,announcementDate:paper.announcementDate??null,
      ageDays:paper.announcementDate?Math.floor((config.now-Date.parse(paper.announcementDate+'T00:00:00Z'))/86400000):null};});
  return result;
}

// This pure calculation is also available for future independently documented
// cumulative providers. The current registry intentionally admits none to Rising.
export function cumulativeGrowth(previous,current,definition,{minIntervalHours=1,maxIntervalHours=168}={}) {
  if(!definition?.cumulative||definition.windowKind!=='cumulative'||!['views','downloads','accesses','readers'].includes(definition.kind))return null;
  if(!previous||!current||previous.paperId!==current.paperId||previous.provider!==current.provider||previous.metric!==current.metric||
    previous.definitionVersion!==current.definitionVersion||previous.counterEpoch!==current.counterEpoch||previous.corrected||current.corrected||
    !measuredStatuses.has(previous.status)||!measuredStatuses.has(current.status))return null;
  if(previous.window?.kind!=='cumulative'||current.window?.kind!=='cumulative'||previous.window.start!==current.window.start||previous.window.days!==current.window.days)return null;
  const intervalHours=(Date.parse(current.observedAt)-Date.parse(previous.observedAt))/3600000;
  if(!Number.isFinite(intervalHours)||intervalHours<minIntervalHours||intervalHours>maxIntervalHours||current.value<previous.value)return null;
  return {velocity:(current.value-previous.value)/intervalHours,change:current.value-previous.value,intervalHours};
}

export function rankRising(population,observations=[],options={}) {
  const config=optionsWithDefaults(options),source=normalizePopulation(population,config),definition=METRIC_DEFINITIONS[`${config.provider}:${config.metric}`];
  const {reasons,coverage,eligible}=quality(source,observations,config,definition),result=baseResult(definition,coverage,reasons);
  if(!definition?.cumulative||definition.windowKind!=='cumulative')result.reasons.push('This provider has no independently verified cumulative readership counter; rolling windows, current saves, and unknown windows cannot establish readership growth.');
  const rows=[];
  if(definition?.cumulative)for(const {paper,observation} of eligible){
    const previous=observations.map(validateObservation).filter(o=>o.paperId===paper.id&&o.provider===observation.provider&&o.metric===observation.metric&&o.observedAt<observation.observedAt)
      .sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
    const growth=cumulativeGrowth(previous,observation,definition,config);
    if(growth)rows.push({paperId:paper.id,value:observation.value,observation,previousObservation:previous,...growth});
  }
  if(rows.length<config.minMeasured||rows.filter(row=>row.velocity>0).length<config.minPositive)result.reasons.push('Insufficient comparable historical observations for a Rising ranking.');
  if(new Set(rows.map(row=>row.velocity)).size<2)result.reasons.push('Observed growth does not discriminate between papers.');
  result.available=result.reasons.length===0;
  result.message=result.available?null:'Insufficient historical readership data to establish a meaningful rising ranking.';
  if(result.available){rows.sort((a,b)=>b.velocity-a.velocity||a.paperId.localeCompare(b.paperId));let rank=0,last=null;result.entries=rows.map((row,index)=>{if(row.velocity!==last){rank=index+1;last=row.velocity;}return {...row,rank};});}
  return result;
}

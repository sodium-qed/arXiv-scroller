// Provider response adapters use exact identifiers only; titles and prestige are
// deliberately excluded. HTTP transport and credentials belong to the CLI.
import {METRIC_DEFINITIONS,normalizeObservationId,validateObservation} from './readership.js';

export const PROVIDER_METRICS=Object.freeze({openaire:['views','downloads'],ads:['read_count'],
  mendeley:['reader_count'],'semantic-scholar':['citation_count'],arcxiv:['citation_count']});
export const PROVIDER_BATCH_SIZE=Object.freeze({openaire:50,ads:50,mendeley:1,'semantic-scholar':500,arcxiv:1});

export function providerRequest(provider,ids,{page=1,token=''}={}) {
  if(!PROVIDER_METRICS[provider]||!Array.isArray(ids)||!ids.length||ids.length>PROVIDER_BATCH_SIZE[provider]||ids.some(id=>normalizeObservationId(id)!==id))throw new Error('Invalid provider request.');
  const headers={Accept:'application/json','User-Agent':'arXiv-Discovery-research/1.3 (+https://github.com/sodium-qed/arXiv-scroller)'};
  let url,method='GET',body;
  if(provider==='openaire'){
    url=new URL('https://api.openaire.eu/graph/v4/research-products');
    url.searchParams.set('filter','ids.arxiv:'+ids.join('|'));url.searchParams.set('page_size','100');url.searchParams.set('page',String(page));
    if(token)headers.Authorization='Bearer '+token;
  } else if(provider==='ads'){
    url=new URL('https://api.adsabs.harvard.edu/v1/search/query');
    url.searchParams.set('q','identifier:('+ids.map(id=>'"arXiv:'+id+'"').join(' OR ')+')');
    url.searchParams.set('fl','bibcode,identifier,read_count');url.searchParams.set('rows','2000');
    if(token)headers.Authorization='Bearer '+token;
  } else if(provider==='mendeley'){
    if(ids.length!==1)throw new Error('Mendeley queries require one identifier.');
    url=new URL('https://api.mendeley.com/catalog');url.searchParams.set('arxiv',ids[0]);url.searchParams.set('view','stats');
    if(token)headers.Authorization='Bearer '+token;
  } else if(provider==='semantic-scholar'){
    url=new URL('https://api.semanticscholar.org/graph/v1/paper/batch');url.searchParams.set('fields','paperId,externalIds,citationCount');
    method='POST';headers['Content-Type']='application/json';body=JSON.stringify({ids:ids.map(id=>'ARXIV:'+id)});
    if(token)headers['x-api-key']=token;
  } else {
    if(ids.length!==1)throw new Error('ArcXiv queries require one identifier.');
    url=new URL('https://arcxiv.org/api/agent/papers/'+ids[0]);
  }
  return {url:url.href,method,headers,...(body?{body}:{})};
}

export function providerFailure(provider,ids,status,observedAt,error,sourceUrl=null) {
  return ids.flatMap(paperId=>(PROVIDER_METRICS[provider]||[]).map(metric=>validateObservation({paperId,provider,metric,status,
    value:null,observedAt,sourceUrl,error,match:null})));
}

function identifiers(provider,row) {
  if(provider==='openaire')return [...new Set((row.pids||[]).filter(pid=>String(pid?.scheme).toLowerCase()==='arxiv').map(pid=>normalizeObservationId(pid.value)).filter(Boolean))];
  if(provider==='ads')return [...new Set((row.identifier||[]).filter(id=>/^arxiv:/i.test(id)).map(normalizeObservationId).filter(Boolean))];
  if(provider==='mendeley')return [normalizeObservationId(row.identifiers?.arxiv)].filter(Boolean);
  if(provider==='semantic-scholar')return [normalizeObservationId(row.externalIds?.ArXiv)].filter(Boolean);
  return [normalizeObservationId(row.arxivId)].filter(Boolean);
}
function metricValue(provider,row,metric) {
  if(provider==='openaire')return row.indicators?.usageCounts?.[metric]??row.usageCounts?.[metric]??null;
  if(provider==='semantic-scholar'||provider==='arcxiv')return row.citationCount??null;
  return row[metric]??null;
}

export function normalizeProviderResponse(provider,ids,payload,{observedAt,sourceUrl,complete=true}={}) {
  const records=provider==='openaire'?payload?.results:provider==='ads'?payload?.response?.docs:
    provider==='arcxiv'?[payload]:payload;
  if(!Array.isArray(records))throw new Error('Provider response has no recognized record list.');
  const rows=records.filter(row=>row&&typeof row==='object'&&!Array.isArray(row));
  const unidentified=rows.some(row=>identifiers(provider,row).length!==1);
  const observations=[];
  for(const paperId of ids) {
    const matched=rows.filter(row=>identifiers(provider,row).includes(paperId));
    let status=!complete?'network_failure':matched.length===1&&identifiers(provider,matched[0]).length===1?'indexed':matched.length?'ambiguous_match':
      unidentified?'ambiguous_match':'not_indexed';
    const row=status==='indexed'?matched[0]:null;
    for(const metric of PROVIDER_METRICS[provider]) {
      const raw=row?metricValue(provider,row,metric):null;
      const numeric=typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):raw;
      const value=typeof numeric==='number'&&Number.isSafeInteger(numeric)&&numeric>=0?numeric:null;
      const outcome=status==='indexed'?(value===null?'metric_unavailable':value===0?'zero':'positive'):status;
      observations.push(validateObservation({paperId,provider,metric,status:outcome,value:row?value:null,
        observedAt,providerUpdatedAt:null,sourceUrl:sourceUrl?providerRequest(provider,[paperId]).url:null,match:row?'exact_identifier':null,
        providerRecordId:row?String(row.id??row.paperId??row.bibcode??row.arxivId??''):null,
        error:outcome==='ambiguous_match'?'Provider identity is missing, duplicated, or refers to multiple arXiv papers.':
          !complete&&!row?'Provider result pagination was incomplete.':null}));
    }
  }
  return observations;
}

export function classifyProviderHttp(status) {
  return status===401||status===403?'authentication_failure':status===429?'rate_limit_failure':
    status>=200&&status<300?null:'network_failure';
}

export function providerPageInfo(provider,payload) {
  if(provider==='openaire'){
    const {numFound,page,pageSize}=payload?.header||{};
    if(!Number.isSafeInteger(numFound)||numFound<0||!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1)throw new Error('Unverifiable OpenAIRE pagination.');
    if(!Array.isArray(payload.results)||payload.results.length>pageSize)throw new Error('Invalid OpenAIRE result page.');
    return {total:numFound,page,pageSize,hasNext:page*pageSize<numFound};
  }
  if(provider==='ads'){
    const total=payload?.response?.numFound,rows=payload?.response?.docs;
    if(!Number.isSafeInteger(total)||!Array.isArray(rows))throw new Error('Unverifiable ADS result count.');
    return {total,page:1,pageSize:rows.length,hasNext:rows.length<total};
  }
  return {total:Array.isArray(payload)?payload.length:1,page:1,pageSize:1,hasNext:false};
}

export function providerDefinition(provider,metric){return METRIC_DEFINITIONS[`${provider}:${metric}`]??null;}

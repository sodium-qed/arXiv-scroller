let transportQueue=Promise.resolve();
let lastArxivRequest=0;
export function backoffUntil(headers,now=Date.now()) {
  const value=String(headers||'').match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
  const delay=value&&/^\d+$/.test(value)?Number(value)*1000:value?Date.parse(value)-now:60000;
  return now+Math.max(15000,Number.isFinite(delay)?delay:60000);
}
export function gmRequest(url,options={}) {
  const u=new URL(url);
  const isArxiv=u.protocol==='https:'&&['arxiv.org','export.arxiv.org'].includes(u.hostname)&&!u.username&&!u.password;
  const isBridge=u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password;
  if(!isArxiv&&!isBridge) return Promise.reject(new Error('Connection is outside the permitted arXiv or local bridge origins.'));
  if(isBridge&&(u.pathname!=='/v1/explain'||(options.method||'GET')!=='POST'))return Promise.reject(new Error('Only the paired AI endpoint is permitted on loopback.'));
  const perform=()=>new Promise((resolve,reject)=>{
    if(typeof GM_xmlhttpRequest!=='function') return reject(new Error('Tampermonkey network permission is unavailable.'));
    const timer=setTimeout(()=>{try{handle?.abort();}catch{}reject(new Error('Network request timed out.'));},options.timeout||45000);
    let handle;
    const done=fn=>value=>{clearTimeout(timer);fn(value);};
    handle=GM_xmlhttpRequest({url:u.href,method:options.method||'GET',headers:options.headers||{},data:options.body,
      timeout:options.timeout||45000,anonymous:true,redirect:'error',
      onprogress:options.onProgress? r=>{try{options.onProgress(r.responseText);}catch{/* progress is optional */}}:undefined,
      onload:done(r=>{
        let final;try{final=new URL(r.finalUrl||u.href);}catch{return reject(new Error('Malformed response destination.'));}
        if(final.origin!==u.origin) return reject(new Error('Unexpected cross-origin redirect was rejected.'));
        if(isArxiv&&[429,503].includes(r.status)&&typeof GM_setValue==='function')GM_setValue('arxiv-discovery:network-backoff',backoffUntil(r.responseHeaders));
        resolve({status:r.status,text:r.responseText,headers:r.responseHeaders,finalUrl:r.finalUrl||u.href});
      }),onerror:done(()=>reject(new Error('Connection failed. Check the network, Tampermonkey permission, or local bridge.'))),
      ontimeout:done(()=>reject(new Error('Network request timed out.'))),onabort:done(()=>reject(new Error('Network request cancelled.')))});
  });
  // Serialize listing downloads and bridge calls across tabs. The bridge may
  // retrieve a paper, so it shares this lock even while model inference runs.
  const run=async()=>{
    const wait=async()=>{
      const interval=u.hostname==='export.arxiv.org'?3100:15100;
      let previous=lastArxivRequest;
      if(typeof GM_getValue==='function') {
        previous=Math.max(previous,Number(GM_getValue('arxiv-discovery:network-last',0))||0);
        const until=Number(GM_getValue('arxiv-discovery:network-backoff',0))||0;
        if(isArxiv&&until>Date.now())throw new Error(`arXiv requested a pause. Try again after ${new Date(until).toLocaleTimeString()}.`);
      }
      const delay=Math.max(0,previous+interval-Date.now());if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
      lastArxivRequest=Date.now();if(typeof GM_setValue==='function') GM_setValue('arxiv-discovery:network-last',lastArxivRequest);
      try{return await perform();}finally{if(isBridge){lastArxivRequest=Date.now();if(typeof GM_setValue==='function')GM_setValue('arxiv-discovery:network-last',lastArxivRequest);}}
    };
    return globalThis.navigator?.locks?.request? navigator.locks.request('arxiv-discovery-network',wait):wait();
  };
  const task=transportQueue.then(run,run);transportQueue=task.catch(()=>{});return task;
}

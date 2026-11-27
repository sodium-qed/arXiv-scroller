import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClient } from '../src/ai.js';

const paper = { id: '2401.12345', version: 2, title: 'Compact operators', abstract: 'We study compact operators.',
  announcementDate: '2024-01-31', authors: [{ name: 'Author' }], links: { html: 'https://arxiv.org/html/2401.12345v2' } };
const token = 'test-pairing-value-'.repeat(3);

function setup(options = {}) {
  const calls = [];
  const cache = new Map();
  const knowledge = { limits: { level: 'comfortable', updatedAt: '2024-01-01' } };
  const settings = { noSpoilers: true, paperSpoilers: {}, events: ['secret-history'], bookmarks: ['private'],
    ai: { enabled: true, consent: true, token, provider: 'local', model: 'fixture-model', ...options.ai } };
  function resultFor(payload) {
    const id = payload.paper.id + (payload.paper.version ? 'v' + payload.paper.version : '');
    const url = 'https://arxiv.org/html/' + id;
    return { text: 'The research question [S1].', source: { kind: 'html', url, note: 'HTML excerpt.',
      citations: [{ label: '[S1] Introduction', url: url + '#S1', quotes: ['compact operators'] }] },
      usage: { inputTokens: 28, outputTokens: 18, estimatedCostUsd: 0, dailyRequests: 1, dailyCostUsd: 0 } };
  }
  const client = new AIClient({ request: async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, init, payload });
    if (options.respond) return options.respond(payload, url);
    return { status: 200, finalUrl: url, text: JSON.stringify(resultFor(payload)) };
  }, getSettings: () => settings, getKnowledge: () => knowledge, cacheGet: k => cache.get(k),
  cacheSet: (k, v) => cache.set(k, v) });
  return { client, calls, cache, settings, knowledge, resultFor };
}

test('only deliberate requests with consent, pairing, and exact loopback origin can reach the bridge', async () => {
  for (const ai of [{ enabled: false }, { consent: false }, { token: '' }, { model: '' }, { url: 'https://example.org' },
    { url: 'http://127.0.0.1:4317/elsewhere' }, { provider: 'another-service' }]) {
    const ctx = setup({ ai });
    await assert.rejects(ctx.client.overview(paper));
    assert.equal(ctx.calls.length, 0);
  }
  const ctx = setup();
  assert.equal(ctx.calls.length, 0);
  await ctx.client.overview(paper);
  const call = ctx.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:4317/v1/explain');
  assert.equal(call.init.headers.Authorization, 'Bearer ' + token);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(Object.keys(call.payload.paper).sort(), ['id', 'version', 'title', 'abstract', 'announcementDate'].sort());
  assert.deepEqual(call.payload.knowledge, [{ topic: 'limits', level: 'comfortable' }]);
  assert.ok(!call.init.body.includes(token) && !call.init.body.includes('secret-history') && !call.init.body.includes('private'));
});

test('Gemini uses the paired bridge and requires a nonzero hosted budget', async () => {
  const ctx = setup({ ai: { provider: 'gemini', dailyBudget: 1 } });
  await ctx.client.overview(paper);
  assert.equal(ctx.calls[0].payload.provider, 'gemini');
  const blocked = setup({ ai: { provider: 'gemini', dailyBudget: 0 } });
  await assert.rejects(blocked.client.overview(paper), /allowance is zero/);
  assert.equal(blocked.calls.length, 0);
});

test('repeat requests, including simultaneous requests, use one provider generation', async () => {
  const ctx = setup();
  const pair = await Promise.all([ctx.client.overview(paper), ctx.client.overview(paper)]);
  assert.equal(ctx.calls.length, 1);
  assert.equal(pair[0].source.citations[0].url, 'https://arxiv.org/html/2401.12345v2#S1');
  const saved = await ctx.client.overview(paper);
  assert.equal(ctx.calls.length, 1);
  assert.equal(saved.cached, true);
  assert.equal(saved.usage.inputTokens, 28);
  assert.ok(![...ctx.cache.keys()][0].includes(token));
});

test('cache varies with paper version, policy, model, question, level, knowledge, limits and contextual selection', async () => {
  const ctx = setup();
  await ctx.client.overview(paper);
  ctx.settings.paperSpoilers[paper.id] = false;
  await ctx.client.overview(paper);
  assert.equal(ctx.calls.at(-1).payload.noSpoilers, false);
  ctx.settings.noSpoilers = false;
  await ctx.client.overview(paper, { noSpoilers: true });
  assert.equal(ctx.calls.length, 2); // Reuses the earlier protected answer.
  ctx.knowledge.sequences = { level: 'developing' };
  await ctx.client.overview(paper);
  ctx.settings.ai.model = 'model-2';
  await ctx.client.overview(paper);
  ctx.settings.ai.maxOutputTokens = 456;
  await ctx.client.overview(paper);
  await ctx.client.overview({ ...paper, version: 3 });
  await ctx.client.explain(paper, 'compact', { detail: 'simpler' });
  await ctx.client.explain(paper, 'compact', { detail: 'rigorous' });
  await ctx.client.explain(paper, 'compact', { detail: 'rigorous', question: 'Which topology?' });
  await ctx.client.explain(paper, 'compact', { detail: 'rigorous', question: 'Which topology?', context: 'The previous sentence.' });
  assert.equal(ctx.calls.length, 10);
  assert.equal(ctx.calls.at(-1).payload.context, 'The previous sentence.');
  assert.equal(ctx.calls.at(-1).payload.term, 'compact');
});

test('unknown paper versions are refreshed after one hour and cache keys include the announcement', async () => {
  const ctx = setup();
  const unknown = { ...paper, version: 0 };
  await ctx.client.overview(unknown);
  assert.equal((await ctx.client.overview(unknown)).cached, true);
  const cached = [...ctx.cache.values()][0];
  cached.savedAt = Date.now() - 3600001;
  assert.equal((await ctx.client.overview(unknown)).cached, false);
  await ctx.client.overview({ ...unknown, announcementDate: '2024-02-01' });
  assert.equal(ctx.calls.length, 3);
});

test('rejected provider replies, wrong-source answers, and redirects never enter the cache', async () => {
  for (const respond of [
    () => ({ status: 502, text: JSON.stringify({ error: 'Model unavailable' }) }),
    () => ({ status: 200, text: JSON.stringify({ text: 'A', source: { kind: 'html', url: 'https://example.org/paper' } }) }),
    () => ({ status: 200, text: '{}', finalUrl: 'http://127.0.0.1:4317/other' }),
    () => ({ status: 200, text: 'not valid JSON' })
  ]) {
    const ctx = setup({ respond });
    await assert.rejects(ctx.client.overview(paper));
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.cache.size, 0);
  }
});

test('no generation when allowance is zero, consent is revoked, or inputs exceed limits', async () => {
  const ctx = setup({ ai: { provider: 'openai', dailyBudget: 0 } });
  await assert.rejects(ctx.client.overview(paper), /zero/);
  ctx.settings.ai.dailyBudget = 1;
  ctx.settings.ai.dailyRequests = 0;
  await assert.rejects(ctx.client.overview(paper), /zero/);
  ctx.settings.ai.dailyRequests = 1;
  await assert.rejects(ctx.client.explain(paper, 'x'.repeat(501)));
  await assert.rejects(ctx.client.overview({ ...paper, id: 'other/paper' }));
  assert.equal(ctx.calls.length, 0);
  await ctx.client.overview(paper);
  ctx.settings.ai.consent = false;
  await assert.rejects(ctx.client.overview(paper), /authorize/);
  assert.equal(ctx.calls.length, 1);
});

test('quick local profile caps limits and separates detailed cache entries; hosted stays full', async () => {
  const ctx = setup({ ai: { maxInputChars: 18000, maxOutputTokens: 1600, timeoutSeconds: 300 } });
  await ctx.client.overview(paper);
  assert.equal(ctx.calls[0].payload.profile, 'quick');
  assert.equal(ctx.calls[0].payload.limits.maxInputChars, 4000);
  assert.equal(ctx.calls[0].payload.limits.maxOutputTokens, 768);
  assert.equal(ctx.calls[0].init.timeout, 300000);
  await ctx.client.overview(paper, { profile: 'full' });
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].payload.limits.maxInputChars, 18000);
  const hosted = setup({ ai: { provider: 'openai', profile: 'quick' } });
  await hosted.client.overview(paper);
  assert.equal(hosted.calls[0].payload.profile, 'full');
  assert.equal(hosted.calls[0].payload.progress, false);
});

test('progress events never enter cached prose and only the terminal result is accepted', async () => {
  let ctx;
  const seen = [];
  ctx = setup({ respond: (payload, url) => ({ status: 200, finalUrl: url, text:
    JSON.stringify({type:'progress',phase:'generating',chunks:3})+'\n'+
    JSON.stringify({type:'result',status:200,data:ctx.resultFor(payload)})+'\n' }) });
  const result = await ctx.client.overview(paper,{onProgress:(...p)=>seen.push(p)});
  assert.deepEqual(seen,[['generating',3]]);
  assert.equal(result.text,'The research question [S1].');
  const truncated=setup({respond:()=>({status:200,text:'{"type":"progress","phase":"generating","chunks":2}\n'})});
  await assert.rejects(truncated.client.overview(paper),/incomplete/);
  assert.equal(truncated.cache.size,0);
});

function highlightReply(payload, changes = {}) {
  const id = payload.paper.id + (payload.paper.version ? 'v' + payload.paper.version : '');
  const url = 'https://arxiv.org/html/' + id;
  const citation = {label:'[S1] Introduction',url:url+'#S1',quotes:['compact operators']};
  return {text:'A provisional assessment of the authors’ stated method.',
    source:{kind:'html',url,note:'Verified source excerpt.',citations:[citation]},
    highlight:{status:'candidate',basis:['method'],reason:'The authors describe a method for this stated problem.',citations:[citation]},
    ...changes};
}

test('highlight requests are deliberate, use the full profile and retain their decision in a separate cache', async () => {
  const ctx = setup({ai:{profile:'quick',maxInputChars:18000},respond:(payload,url) =>
    ({status:200,finalUrl:url,text:JSON.stringify(highlightReply(payload))})});
  assert.equal(ctx.calls.length,0);
  const pair = await Promise.all([ctx.client.highlight(paper,{noSpoilers:false,profile:'quick'}),
    ctx.client.highlight(paper,{noSpoilers:false,profile:'quick'})]);
  assert.equal(ctx.calls.length,1);
  assert.equal(ctx.calls[0].payload.action,'highlight');
  assert.equal(ctx.calls[0].payload.profile,'full');
  assert.equal(ctx.calls[0].payload.limits.maxInputChars,18000);
  assert.equal(pair[0].highlight.status,'candidate');
  assert.deepEqual(pair[0].highlight.basis,['method']);
  const cached = await ctx.client.highlight(paper,{noSpoilers:false});
  assert.equal(cached.cached,true);
  assert.deepEqual(cached.highlight,pair[0].highlight);
  delete [...ctx.cache.values()][0].highlight;
  await ctx.client.highlight(paper,{noSpoilers:false});
  assert.equal(ctx.calls.length,2,'legacy explanation cache cannot stand in for a highlight decision');
  await ctx.client.overview(paper,{noSpoilers:false,profile:'full'});
  assert.equal(ctx.calls.length,3,'ordinary overview has a separate cache identity');
});

test('missing, fabricated, unsupported or cross-paper highlight decisions are rejected before caching', async () => {
  const mutations = [
    data => {delete data.highlight;},
    data => {data.highlight.status='important';},
    data => {data.highlight.basis=[];},
    data => {data.highlight.basis=['prestige'];},
    data => {data.highlight.basis=['method','method'];},
    data => {data.highlight.citations=[];},
    data => {data.highlight.citations=[{label:'[S1] Introduction',url:data.source.url+'#S1',quotes:['fabricated quotation']}];},
    data => {data.highlight.citations=[{label:'[S1] Introduction',url:'https://arxiv.org/html/2401.99999v2#S1',quotes:['compact operators']}];},
    data => {data.highlight.reason='';},
    data => {data.highlight.status='not_established';}
  ];
  for (const mutate of mutations) {
    const ctx=setup({respond:(payload,url) => {const data=highlightReply(payload);mutate(data);return {status:200,finalUrl:url,text:JSON.stringify(data)};}});
    await assert.rejects(ctx.client.highlight(paper,{noSpoilers:false}),/highlight/);
    assert.equal(ctx.cache.size,0);
    assert.equal(ctx.calls.length,1);
  }
});

test('protected highlight decisions cannot display generated result prose, source notes or quotations', async () => {
  const ctx=setup({respond:(payload,url) => ({status:200,finalUrl:url,text:JSON.stringify(highlightReply(payload,{
    text:'A result that must not be displayed.',highlight:{status:'not_established',basis:[],reason:'A result-bearing reason.',citations:[]}
  }))})});
  const answer=await ctx.client.highlight(paper);
  assert.equal(answer.highlight.status,'not_established');
  assert.match(answer.text,/No Spoilers/);
  assert.equal(answer.text,answer.highlight.reason);
  assert.deepEqual(answer.source.citations,[]);
  assert.doesNotMatch(answer.text+answer.source.note,/result-bearing|must not be displayed|Verified source/);
  const incompatible=setup({respond:(payload,url)=>({status:200,finalUrl:url,text:JSON.stringify(highlightReply(payload))})});
  await assert.rejects(incompatible.client.highlight(paper),/highlight/);
  assert.equal(incompatible.cache.size,0);
});

test('highlight requests keep the existing consent, pairing and budget gates and never retry automatically', async () => {
  for (const ai of [{enabled:false},{consent:false},{token:''},{dailyRequests:0},{provider:'openai',dailyBudget:0}]) {
    const ctx=setup({ai});
    await assert.rejects(ctx.client.highlight(paper,{noSpoilers:false}));
    assert.equal(ctx.calls.length,0);
  }
  const failure=setup({respond:()=>({status:502,text:JSON.stringify({error:'Provider unavailable'})})});
  await assert.rejects(failure.client.highlight(paper,{noSpoilers:false}),/Provider unavailable/);
  assert.equal(failure.calls.length,1);
  assert.equal(failure.cache.size,0);
});

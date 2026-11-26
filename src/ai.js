// Changing the grounding protocol or response policy must invalidate old explanations.
const PROMPT_VERSION = 1;
const CACHE_VERSION = 2;
const ID_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/i;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const LEVELS = new Set(['unfamiliar', 'introduced', 'developing', 'comfortable', 'proficient', 'advanced']);
const MAX_UNKNOWN_VERSION_AGE = 60 * 60 * 1000;
const DETAIL_VALUES = new Map([
  ['standard', 'standard'], ['simple', 'simpler'], ['simpler', 'simpler'],
  ['rigorous', 'rigorous'], ['more rigorous', 'rigorous']
]);

function bridgeOrigin(value) {
  const raw = String(value || 'http://127.0.0.1:4317');
  if (!/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(raw)) {
    throw new Error('Use a local bridge address such as http://127.0.0.1:4317.');
  }
  return new URL(raw).origin;
}

function boundedText(value, maximum, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.trim().length > maximum) {
    throw new Error(label + ' exceeds the supported length.');
  }
  return value.trim();
}

function numericSetting(value, fallback, minimum, maximum, whole = false) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum || (whole && !Number.isInteger(number))) {
    throw new Error('Check the AI request, text, token, price, and daily budget limits in Settings.');
  }
  return number;
}

function requestLimits(ai) {
  return {
    dailyRequests: numericSetting(ai.dailyRequests, 10, 0, 10000, true),
    dailyBudget: numericSetting(ai.dailyBudget, 1, 0, 10000),
    maxInputChars: numericSetting(ai.maxInputChars, 100000, 256, 120000, true),
    maxOutputTokens: numericSetting(ai.maxOutputTokens, 1600, 64, 8192, true),
    inputPerMillion: numericSetting(ai.inputPerMillion, 0, 0, 10000),
    outputPerMillion: numericSetting(ai.outputPerMillion, 0, 0, 10000)
  };
}

function profileTopics(profile, context) {
  const topics = [];
  for (const [topic, entry] of Object.entries(profile || {})) {
    const name = topic.trim();
    const level = String(entry?.level ?? entry).toLowerCase();
    if (name && name.length <= 100 && LEVELS.has(level)) topics.push({ topic: name, level });
  }
  // When profiles are large, retain topics appearing in this paper or question first.
  const compare = (a, b) => a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0;
  const relevant = topic => Number(context.includes(topic.topic.toLowerCase()));
  topics.sort((a, b) => relevant(b) - relevant(a) || compare(a, b));
  return topics.slice(0, 64).sort(compare);
}

function safeSourceUrl(value, kind, paper, allowFragment) {
  const path = { html: 'html', pdf: 'pdf', abstract: 'abs' }[kind];
  if (!path || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const id = paper.id + (paper.version ? 'v' + paper.version : '');
    if (url.origin !== 'https://arxiv.org' || url.username || url.password || url.search ||
        url.pathname !== '/' + path + '/' + id || (!allowFragment && url.hash)) return null;
    if (url.hash && !/^#(?:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,120}|page=[1-9]\d{0,4})$/.test(url.hash)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function checkResult(data, paper) {
  const text = boundedText(data?.text, 64000, 'The explanation');
  const source = data?.source;
  const url = safeSourceUrl(source?.url, source?.kind, paper, false);
  if (!text || !url) throw new Error('The bridge returned an explanation without verifiable arXiv provenance.');
  const citations = [];
  for (const item of Array.isArray(source.citations) ? source.citations.slice(0, 128) : []) {
    const link = safeSourceUrl(item?.url, source.kind, paper, true);
    if (link && typeof item.label === 'string') {
      citations.push({ label: item.label.slice(0, 260), url: link,
        quotes: (Array.isArray(item.quotes) ? item.quotes : []).filter(q => typeof q === 'string').slice(0, 8).map(q => q.slice(0, 320)) });
    }
  }
  const result = { text, source: { kind: source.kind, url, note: boundedText(source.note, 2200, 'The source note'), citations } };
  if (data.usage && typeof data.usage === 'object') {
    result.usage = {};
    for (const key of ['inputTokens', 'outputTokens', 'estimatedCostUsd', 'dailyRequests', 'dailyCostUsd']) {
      const n = data.usage[key];
      if (Number.isFinite(n) && n >= 0) result.usage[key] = n;
    }
  }
  return result;
}

async function fingerprint(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class AIClient {
  constructor({ request, getSettings, getKnowledge = () => ({}), getGeneration = () => null, cacheGet = () => null, cacheSet = () => {} }) {
    this.request = request;
    this.getSettings = getSettings;
    this.getKnowledge = getKnowledge;
    this.getGeneration = getGeneration;
    this.cacheGet = cacheGet;
    this.cacheSet = cacheSet;
    this.pending = new Map();
  }

  async overview(paper, options = {}) {
    return this.generate('overview', paper, '', options);
  }

  async explain(paper, term, options = {}) {
    const selection = boundedText(term, 500, 'The selected term');
    if (!selection) throw new Error('Select a word, expression, or short mathematical phrase.');
    return this.generate('explain', paper, selection, options);
  }

  async generate(action, paper, term, options) {
    const generation = await this.getGeneration();
    const settings = await this.getSettings();
    const ai = settings?.ai || {};
    if (ai.enabled !== true || ai.consent !== true) {
      throw new Error('Enable on-demand AI and authorize the selected provider in Settings first.');
    }
    const origin = bridgeOrigin(ai.url);
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(ai.token || '')) {
      throw new Error('Pair this browser with the local bridge using its random pairing token.');
    }
    const provider = ai.provider || 'local';
    if (!['local', 'openai'].includes(provider) || !MODEL_PATTERN.test(ai.model || '')) {
      throw new Error('Choose a provider and enter the exact model name allowed by the bridge.');
    }
    if (!paper || !ID_PATTERN.test(paper.id) || !Number.isInteger(paper.version) || paper.version < 0 || paper.version > 9999) {
      throw new Error('A valid arXiv paper and version are required.');
    }
    const limits = requestLimits(ai);
    const profile = provider === "local" ? (options.profile || (options.detail === "rigorous" || options.question ? "full" : ai.profile || "quick")) : "full";
    if (!["quick", "full"].includes(profile)) throw new Error("Choose a supported AI reading profile.");
    if (profile === "quick") {
      limits.maxInputChars = Math.min(limits.maxInputChars, 4000);
      limits.maxOutputTokens = Math.min(limits.maxOutputTokens, 768);
    }
    const timeout = numericSetting(ai.timeoutSeconds, 420, 60, 600, true) * 1000;
    const detail = DETAIL_VALUES.get(String(options.detail || 'standard').toLowerCase());
    if (!detail) throw new Error('Choose a standard, simpler, or rigorous explanation.');
    const question = boundedText(options.question, 2000, 'The follow-up question');
    const readerContext = boundedText(options.context, 1600, 'The surrounding reading context');
    const override = settings.paperSpoilers?.[paper.id];
    const noSpoilers = options.noSpoilers ?? (typeof override === 'boolean' ? override : settings.noSpoilers ?? true);
    if (typeof noSpoilers !== 'boolean') throw new Error('Check the independent-research setting for this paper.');
    const metadata = {
      id: paper.id, version: paper.version,
      title: boundedText(paper.title, 4000, 'The paper title'),
      abstract: boundedText(paper.abstract, 32000, 'The paper abstract'),
      announcementDate: String(paper.announcementDate || '').slice(0, 10)
    };
    const context = [metadata.title, metadata.abstract, term, question, readerContext].join(' ').toLowerCase();
    const knowledge = profileTopics(await this.getKnowledge(), context);
    const prompt = { protocol: PROMPT_VERSION, provider, model: ai.model, profile, action, paper: metadata,
      noSpoilers, detail, term, question, context: readerContext, knowledge };
    const stamp = await fingerprint([CACHE_VERSION, origin, prompt, limits.maxInputChars, limits.maxOutputTokens]);
    const key = 'ai:' + paper.id + ':v' + paper.version + ':' + stamp;
    if (generation !== await this.getGeneration()) throw new Error('Saved data changed while preparing this request. Please request the explanation again.');
    const saved = await this.cacheGet(key);
    const age = Date.now() - saved?.savedAt;
    const cacheAgeLimit = !paper.version ? MAX_UNKNOWN_VERSION_AGE : saved?.source?.kind === 'abstract' ? 86400000 : Infinity;
    if (saved && age >= 0 && age < cacheAgeLimit) {
      try { return { ...checkResult(saved, paper), cached: true }; } catch { /* Replace invalid imported cache entries. */ }
    }
    const pendingKey = key + ':generation:' + generation;
    if (this.pending.has(pendingKey)) return this.pending.get(pendingKey);
    if (!limits.dailyRequests || (provider === 'openai' && !limits.dailyBudget)) {
      throw new Error('The configured daily AI allowance is zero.');
    }
    if (generation !== await this.getGeneration()) throw new Error('Saved data changed while preparing this request. Please request the explanation again.');
    const work = this.send(origin, ai.token, { ...prompt, limits, progress: provider === "local" }, key, generation, timeout, options.onProgress);
    this.pending.set(pendingKey, work);
    try { return await work; } finally { this.pending.delete(pendingKey); }
  }

  async send(origin, token, body, key, generation, timeout, onProgress) {
    const endpoint = origin + '/v1/explain';
    let reply;
    let consumed = 0;
    const receiveProgress = text => {
      if (typeof text !== "string" || typeof onProgress !== "function") return;
      const lines = text.split("\n");
      for (let i = consumed; i < lines.length - 1; i++) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.type === "progress" && ["retrieving", "generating", "validating"].includes(event.phase)) onProgress(event.phase, Number.isSafeInteger(event.chunks) && event.chunks >= 0 ? event.chunks : 0);
        } catch { /* Ignore incomplete/non-stream progress; final response is validated below. */ }
      }
      consumed = Math.max(consumed, lines.length - 1);
    };
    try {
      reply = await this.request(endpoint, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + token
      }, body: JSON.stringify(body), timeout, redirect: 'error', onProgress: receiveProgress });
    } catch {
      throw new Error('The local AI bridge did not respond. Check its address, pairing, and running process. Requests are never retried automatically.');
    }
    if (reply.finalUrl && reply.finalUrl !== endpoint) throw new Error('The local bridge returned a redirect.');
    let data;
    let status = reply.status;
    try {
      if (/^\s*\{\s*"type"\s*:\s*"progress"/.test(reply.text) || /^\s*\{\s*"type"\s*:\s*"result"/.test(reply.text)) {
        if (status !== 200) throw new Error('Unexpected stream status');
        const events = reply.text.trim().split('\n').map(line => JSON.parse(line));
        const final = events.at(-1);
        if (final?.type !== 'result' || events.slice(0, -1).some(e => e.type !== 'progress') || !Number.isInteger(final.status) || !final.data) throw new Error('Incomplete stream');
        receiveProgress(reply.text);
        status = final.status;
        data = final.data;
      } else data = JSON.parse(reply.text);
    } catch { throw new Error('The local bridge returned an incomplete or unreadable response.'); }
    if (status !== 200) {
      const cause = typeof data?.error === 'string' ? data.error.slice(0, 500) : 'Check the bridge configuration.';
      throw new Error('AI request failed (' + status + '). ' + cause);
    }
    const result = checkResult(data, body.paper);
    try {
      await this.cacheSet(key, { ...result, paperId: body.paper.id, version: body.paper.version, savedAt: Date.now() }, generation);
    } catch {
      result.source.note += ' This answer could not be saved to the local explanation cache.';
    }
    return { ...result, cached: false };
  }
}

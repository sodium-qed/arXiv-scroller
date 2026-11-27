// Only the fields defined here cross a backup or storage trust boundary.
import {normalizeCategory, CATEGORIES} from './categories.js';
import {listingCounts, listingUrl} from './parser.js';
import {DEFAULT_FEED_SETTINGS, checkedFeedSettings} from './feed-settings.js';

export const SCHEMA_VERSION = 1;
export const COLLECTIONS = ['events', 'papers', 'savedPapers', 'bookmarks', 'reading', 'subscriptions', 'knowledge', 'glossary', 'selections', 'explanations', 'highlights'];
export const DEFAULT_SETTINGS = {
  mode: 'random', includeCross: false, includeReplacements: false, exploration: 0.25,
  personalizedCount: 50, trainRandom: true, useSubscriptions: false,
  history: {mode: 'all', days: 30, start: '', end: ''}, resetAt: null, noSpoilers: true,
  paperSpoilers: {}, theme: 'auto', showTools: true,
  feeds: DEFAULT_FEED_SETTINGS,
  ai: {enabled: false, url: 'http://127.0.0.1:4317', provider: 'local', token: '', model: '', consent: false,
    dailyRequests: 10, maxInputChars: 100000, maxOutputTokens: 1600, dailyBudget: 1, inputPerMillion: 0, outputPerMillion: 0, profile: 'quick', timeoutSeconds: 420}
};

const MODES = ['random', 'balanced', 'personalized', 'discovery', 'subscriptions', 'original'];
const LEVELS = ['Unfamiliar', 'Introduced', 'Developing', 'Comfortable', 'Proficient', 'Advanced'];
const SECTIONS = ['new', 'cross', 'replacement'];
const PAPER_FIELDS = ['title', 'abstract', 'comments', 'journalRef'];
const MAX_RECORDS = 100000;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const ID = /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3})$/;
const RECORD_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function check(ok, label) {
  if (!ok) throw new Error('Invalid ' + label + '.');
}

function obj(value, label) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), label);
  return value;
}

function list(value, label, maximum = MAX_RECORDS) {
  check(Array.isArray(value) && value.length <= maximum, label);
  return value;
}

function str(value, label, max, required = false) {
  check(typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0), label);
  return value;
}

function number(value, label, min, max, integer = false) {
  check(Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)), label);
  return value;
}

function choice(value, options, label) {
  check(options.includes(value), label);
  return value;
}

function bool(value, label) { return choice(value, [true, false], label); }

function optional(value, validate) { return value == null ? null : validate(value); }

export function recordKey(value) {
  str(value, 'record key', 1024, true);
  if (FORBIDDEN.has(value)) throw new Error('Unsafe key in data.');
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'record key');
  return value;
}

function pid(value) {
  check(typeof value === 'string' && value.length <= 80 && ID.test(value), 'arXiv paper identifier');
  return value;
}

function uid(value) {
  check(typeof value === 'string' && RECORD_ID.test(value), 'record identifier');
  return recordKey(value);
}

function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'calendar date');
  const at = Date.parse(value);
  check(Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value, 'calendar date');
  return value;
}

function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'timestamp');
  date(value.slice(0, 10));
  check(Number.isFinite(Date.parse(value)), 'timestamp');
  return value;
}

function probability(value) { return optional(value, x => number(x, 'selection probability', 0, 1)); }

function category(value) {
  const code = normalizeCategory(value);
  check(Boolean(code), 'arXiv category');
  return code;
}

function url(value, label) {
  str(value, label, 10000, true);
  check(!/[\u0000-\u001f\\]/.test(value), label);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Invalid ' + label + '.'); }
  check(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, label);
  return parsed;
}

function paperLink(value, kind, id, version, allowFragment = false) {
  const link = url(value, 'paper source link');
  const expected = '/' + kind + '/' + id;
  const versioned = version ? expected + 'v' + version : expected;
  check(link.origin === 'https://arxiv.org' && !link.search &&
    (link.pathname === expected || link.pathname === versioned) &&
    (!link.hash || (allowFragment && /^#(?:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,120}|page=[1-9]\d{0,4})$/.test(link.hash))), 'paper source link');
  return link.href;
}

function author(value) {
  const a = obj(value, 'author');
  let href = null;
  if (a.url != null && a.url !== '') {
    const link = url(a.url, 'author link');
    const profile = link.origin === 'https://arxiv.org' && /^\/(?:search(?:\/|$)|a\/[a-z0-9_-]+_\d+(?:\.html)?\/?$)/i.test(link.pathname);
    const orcid = link.origin === 'https://orcid.org' && /^\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]\/?$/i.test(link.pathname) && !link.search;
    check(profile || orcid, 'author identity link');
    href = link.href;
  }
  const stableId = optional(a.stableId, id => {
    check(typeof id === 'string' && id.length <= 512 && /^(?:arxiv:[a-z0-9_-]+_\d+|orcid:\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i.test(id), 'author identity');
    return id;
  });
  return {name: str(a.name, 'author name', 4000, true), url: href, stableId};
}

function recordMap(value, label, read) {
  const entries = Object.entries(obj(value, label));
  check(entries.length <= MAX_RECORDS, label);
  // Object.fromEntries defines own properties and never invokes inherited setters.
  return Object.fromEntries(entries.map(([key, data]) => [recordKey(key), read(data, key)]));
}

export function checkedPaper(value, key = value?.id) {
  const p = obj(value, 'paper');
  const id = pid(p.id);
  check(key === id, 'paper key');
  const version = number(p.version ?? 0, 'paper version', 0, 9999999, true);
  const versionedId = version ? id + 'v' + version : id;
  check(p.versionedId === undefined || p.versionedId === versionedId, 'versioned paper identifier');
  const links = obj(p.links ?? {}, 'paper links');
  const result = {
    id, version, versionedId, title: str(p.title, 'paper title', 16000),
    authors: list(p.authors, 'paper authors').map(author),
    categories: list(p.categories, 'paper categories', 512).map(category),
    primaryCategory: optional(p.primaryCategory, category), abstract: str(p.abstract ?? '', 'abstract', 160000),
    comments: str(p.comments ?? '', 'paper comments', 160000), journalRef: str(p.journalRef ?? '', 'journal reference', 160000),
    announcementDate: optional(p.announcementDate, date), section: optional(p.section, s => choice(s, SECTIONS, 'submission section')),
    links: {
      abstract: paperLink(links.abstract ?? 'https://arxiv.org/abs/' + versionedId, 'abs', id, version),
      pdf: paperLink(links.pdf ?? 'https://arxiv.org/pdf/' + versionedId, 'pdf', id, version),
      html: optional(links.html, href => paperLink(href, 'html', id, version))
    }
  };
  if (p.inlineLinks !== undefined) {
    const fields = obj(p.inlineLinks, 'inline paper links');
    result.inlineLinks = {};
    for (const field of PAPER_FIELDS) {
      if (fields[field] === undefined) continue;
      let previous = 0;
      result.inlineLinks[field] = list(fields[field], 'inline links', 10000).map(item => {
        obj(item, 'inline link');
        const start = number(item.start, 'inline link start', previous, result[field].length, true);
        const end = number(item.end, 'inline link end', start + 1, result[field].length, true);
        previous = end;
        return {start, end, url: url(item.url, 'inline link URL').href};
      });
    }
  }
  return result;
}

export function mergePaperMetadata(previous, current) {
  const next = {...current};
  if (!previous || previous.id !== current.id || previous.title !== current.title || previous.version !== current.version || !current.version) return next;
  for (const field of ['abstract','comments','journalRef']) if (!next[field] && previous[field]) next[field] = previous[field];
  const links = {};
  for (const field of PAPER_FIELDS) {
    const ranges = current.inlineLinks?.[field] || (next[field] === previous[field] ? previous.inlineLinks?.[field] : null);
    if (ranges) links[field] = ranges.map(range => ({...range}));
  }
  if (Object.keys(links).length) next.inlineLinks = links;
  return next;
}

export function mergedSettings(raw = {}, portable = false) {
  const s = {...DEFAULT_SETTINGS, ...obj(raw, 'settings')};
  const h = {...DEFAULT_SETTINGS.history, ...obj(s.history, 'history settings')};
  const a = {...DEFAULT_SETTINGS.ai, ...obj(s.ai, 'AI settings')};
  const result = {
    mode: choice(s.mode, MODES, 'recommendation mode'), exploration: number(s.exploration, 'exploration', 0, 1),
    personalizedCount: number(s.personalizedCount, 'daily count', 1, 200, true),
    theme: choice(s.theme, ['auto', 'light', 'dark'], 'theme'),
    history: {mode: choice(h.mode, ['all', 'none', 'lastDays', 'ignoreLastDays', 'before', 'after', 'excludeRange'], 'history mode'),
      days: number(h.days, 'training window days', 1, 36500, true), start: h.start === '' ? '' : date(h.start), end: h.end === '' ? '' : date(h.end)},
    resetAt: optional(s.resetAt, timestamp), feeds: checkedFeedSettings(s.feeds),
    paperSpoilers: recordMap(s.paperSpoilers, 'paper protections', (v, key) => { pid(key); return bool(v, 'paper protection'); })
  };
  for (const field of ['includeCross', 'includeReplacements', 'trainRandom', 'useSubscriptions', 'noSpoilers', 'showTools']) result[field] = bool(s[field], field);
  if (s.previousMode !== undefined) result.previousMode = choice(s.previousMode, MODES.filter(mode => mode !== 'original'), 'previous recommendation mode');
  check(h.mode !== 'excludeRange' || (h.start && h.end && h.start <= h.end), 'history date range');
  check(!['before', 'after'].includes(h.mode) || h.start || h.end, 'history cutoff date');
  check(typeof a.url === 'string' && /^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(a.url), 'loopback bridge origin');
  const bridge = url(a.url, 'loopback bridge origin');
  const model = str(a.model, 'AI model', 128);
  check(!model || /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model), 'AI model');
  const token = portable ? '' : str(a.token, 'bridge pairing token', 256);
  check(!token || /^[a-zA-Z0-9_-]{32,256}$/.test(token), 'bridge pairing token');
  result.ai = {url: bridge.origin, provider: choice(a.provider, ['local', 'openai', 'gemini'], 'AI provider'), model, token,
    enabled: portable ? false : bool(a.enabled, 'AI enabled flag'), consent: portable ? false : bool(a.consent, 'AI consent'),
    profile: choice(a.profile, ['quick', 'full'], 'AI reading profile'),
    timeoutSeconds: number(a.timeoutSeconds, 'AI request timeout', 60, 600, true),
    dailyRequests: number(a.dailyRequests, 'daily request limit', 0, 10000, true),
    maxInputChars: number(a.maxInputChars, 'source character limit', 256, 120000, true),
    maxOutputTokens: number(a.maxOutputTokens, 'output token limit', 64, 8192, true),
    dailyBudget: number(a.dailyBudget, 'daily budget', 0, 10000),
    inputPerMillion: number(a.inputPerMillion, 'input price', 0, 10000), outputPerMillion: number(a.outputPerMillion, 'output price', 0, 10000)};
  return result;
}

function feedback(value, key) {
  const e = obj(value, 'feedback event');
  check(uid(e.eventId) === key, 'feedback event key');
  const paper = checkedPaper(e.paper, pid(e.paperId));
  check((e.version ?? paper.version) === paper.version, 'feedback paper version');
  const event = {eventId: key, paperId: paper.id, version: paper.version, timestamp: timestamp(e.timestamp),
    value: choice(e.value, ['like', 'dislike', 'background', 'neutral', 'removed'], 'feedback value'),
    reason: str(e.reason ?? '', 'feedback reason', 8000), mode: choice(e.mode, [...MODES,'trending','rising','for-you','highlights','recent','saved'], 'feedback mode'),
    selectionProbability: probability(e.selectionProbability), revisionOf: optional(e.revisionOf, uid),
    excluded: bool(e.excluded ?? false, 'feedback exclusion'), paper};
  if (e.features !== undefined) {
    const f = obj(e.features, 'feedback features');
    check(f.schema === 'math-content-v1', 'feature schema');
    event.features = {schema: f.schema, entries: list(f.entries, 'feature entries', 4000).map(entry => {
      check(Array.isArray(entry) && entry.length === 2, 'feature entry');
      return [str(entry[0], 'feature name', 256, true), number(entry[1], 'feature weight', 0, 8)];
    })};
  }
  return event;
}

function subscription(value, key) {
  const s = obj(value, 'author subscription');
  check(uid(s.id) === key, 'subscription key');
  return {id: key, ...author(s), createdAt: timestamp(s.createdAt), notes: str(s.notes ?? '', 'author notes', 100000),
    confirmedNameOnly: bool(s.confirmedNameOnly ?? false, 'name-only confirmation')};
}

function knowledge(value) {
  function level(item) {
    obj(item, 'knowledge level');
    return {level: choice(item.level, LEVELS, 'knowledge level'), updatedAt: timestamp(item.updatedAt)};
  }
  const entry = level(value);
  if (value.history !== undefined) entry.history = list(value.history, 'knowledge history').map(level);
  return entry;
}

function source(value, id, version) {
  const s = obj(value, 'explanation source');
  const kind = choice(s.kind, ['html', 'pdf', 'abstract'], 'source kind');
  const route = kind === 'abstract' ? 'abs' : kind;
  const href = paperLink(s.url, route, id, version);
  const result = {kind, url: href, note: str(s.note ?? '', 'source note', 3200)};
  if (s.citations !== undefined) {
    result.citations = list(s.citations, 'source citations', 128).map(c => {
      obj(c, 'citation');
      const link = paperLink(c.url, route, id, version, true);
      check(link.split('#')[0] === href, 'citation source');
      return {label: str(c.label, 'citation label', 260), url: link,
        quotes: list(c.quotes ?? [], 'citation quotes', 8).map(q => str(q, 'evidence quote', 320))};
    });
  }
  return result;
}

function highlightDecision(value, paperId, version, evidenceSource) {
  const h = obj(value,'highlight decision');
  const status = choice(h.status,['candidate','not_established'],'highlight decision status');
  const basis = [...new Set(list(h.basis,'highlight basis',6).map(b => choice(b,['open_problem','bound','method','connection','generalization','computation'],'highlight basis')))];
  const citations = source({...evidenceSource,citations:h.citations},paperId,version).citations || [];
  check(status !== 'candidate' || basis.length > 0 && citations.some(c => c.quotes.length > 0),'source-backed highlight candidate');
  check(citations.every(c => (evidenceSource.citations || []).some(s => s.label === c.label && s.url === c.url && c.quotes.every(q => s.quotes?.includes(q)))),'highlight evidence provenance');
  check(status !== 'not_established' || basis.length === 0 && citations.length === 0,'inconclusive highlight decision');
  return {status,basis,reason:str(h.reason,'highlight decision reason',2000,true),citations};
}

function glossary(value, key) {
  const g = obj(value, 'glossary entry');
  const paperId = pid(g.paperId);
  const versioned = key.split(':', 1)[0];
  const version = versioned === paperId ? 0 : Number(versioned.slice(paperId.length + 1));
  check(versioned === paperId || (Number.isSafeInteger(version) && version > 0 && versioned === paperId + 'v' + version), 'glossary paper key');
  const term = str(g.term, 'glossary term', 500, true);
  check(key.length > versioned.length + 1, 'glossary term key');
  const entry = {term, paperId, answer: str(g.answer, 'glossary answer', 64000),
    status: choice(g.status ?? 'unfamiliar', ['unfamiliar', 'partial', 'understood'], 'glossary status'),
    updatedAt: timestamp(g.updatedAt), visits: number(g.visits ?? 1, 'glossary visits', 0, Number.MAX_SAFE_INTEGER, true)};
  if (g.visitHistory !== undefined) entry.visitHistory = list(g.visitHistory, 'glossary visits').map(timestamp);
  if (g.source !== undefined) entry.source = source(g.source, paperId, version);
  return entry;
}

function explanation(value, key) {
  const v = obj(value, 'cached explanation');
  const paperId = pid(v.paperId);
  const version = number(v.version, 'source version', 0, 9999, true);
  const prefix = 'ai:' + paperId + ':v' + version + ':';
  check(key.startsWith(prefix) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length)), 'explanation cache key');
  const entry = {paperId, version, text: str(v.text, 'cached explanation', 64000, true), source: source(v.source, paperId, version),
    savedAt: number(v.savedAt, 'cache timestamp', 0, 8640000000000000, true)};
  if (v.highlight !== undefined) entry.highlight = highlightDecision(v.highlight,paperId,version,entry.source);
  if (v.usage !== undefined) {
    const usage = obj(v.usage, 'AI usage');
    entry.usage = {};
    for (const k of ['inputTokens', 'outputTokens', 'estimatedCostUsd', 'dailyRequests', 'dailyCostUsd']) {
      if (usage[k] !== undefined) entry.usage[k] = number(usage[k], 'usage quantity', 0, Number.MAX_SAFE_INTEGER);
    }
  }
  return entry;
}

function selection(value, key) {
  const r = obj(value, 'daily selection record');
  function read(v) {
    obj(v, 'selection revision');
    const mode = choice(v.mode, MODES, 'selection mode');
    const day = date(v.date);
    check(key.startsWith(day + '|' + mode + '|'), 'daily selection key');
    const seen = new Set();
    const maximum = mode === 'original' ? 0 : mode === 'discovery' ? 32 : mode === 'personalized' ? 200 : MAX_RECORDS;
    const result = {mode, date: day, seed: str(v.seed, 'selection seed', 1024),
      entries: list(v.entries, 'selected papers', maximum).map(e => {
        obj(e, 'selected paper');
        const paperId = pid(e.paperId);
        check(!seen.has(paperId), 'duplicate selected paper');
        seen.add(paperId);
        return {paperId, category: optional(e.category, category), reason: str(e.reason, 'selection reason', 64000), probability: probability(e.probability)};
      }), missing: list(v.missing, 'unrepresented categories', 32).map(m => {
        obj(m, 'unrepresented category');
        check(Object.hasOwn(CATEGORIES, m.category), 'missing mathematics category');
        return {category: m.category, reason: str(m.reason, 'missing category reason', 8000)};
      })};
    // Metadata is an optional generation-time snapshot. Old revisions retain
    // their original shape; loading or importing them never invents new quotas.
    if (v.samplingVersion !== undefined) result.samplingVersion = choice(v.samplingVersion, [2], 'sampling version');
    if (['categoryDistribution', 'targetSize', 'shortfall'].some(field => v[field] !== undefined)) {
      check(result.samplingVersion === 2 && ['random', 'balanced', 'discovery'].includes(mode), 'category quota metadata');
      const categories = new Set();
      const assigned = new Map();
      for (const entry of result.entries) {
        check(Object.hasOwn(CATEGORIES, entry.category), 'assigned mathematics category');
        assigned.set(entry.category, (assigned.get(entry.category) || 0) + 1);
      }
      result.categoryDistribution = list(v.categoryDistribution, 'category distribution', 32).map(raw => {
        const row = obj(raw, 'category distribution row');
        check(Object.hasOwn(CATEGORIES, row.category) && !categories.has(row.category), 'unique distribution category');
        categories.add(row.category);
        const eligibleCount = number(row.eligibleCount, 'eligible paper count', 0, MAX_RECORDS, true);
        const squareRootQuota = number(row.squareRootQuota, 'square-root quota', 0, MAX_RECORDS, true);
        check(squareRootQuota === Math.ceil(Math.sqrt(eligibleCount)), 'calculated square-root quota');
        const quota = number(row.quota, 'applied category quota', 0, squareRootQuota, true);
        check(quota === (mode === 'discovery' ? Number(eligibleCount > 0) : squareRootQuota), 'mode category quota');
        const selectedCount = number(row.selectedCount, 'assigned category count', 0, quota, true);
        check(selectedCount === (assigned.get(row.category) || 0), 'category count matches selected papers');
        const reason = optional(row.reason, value => str(value, 'quota reason', 8000, true));
        check(selectedCount === quota || reason !== null, 'unfulfilled quota explanation');
        return {category:row.category, eligibleCount, squareRootQuota, quota, selectedCount, reason};
      });
      check(categories.size === Object.keys(CATEGORIES).length, 'complete category distribution');
      result.targetSize = number(v.targetSize, 'calculated selection size', 0, MAX_RECORDS, true);
      check(result.targetSize === result.categoryDistribution.reduce((sum, row) => sum + row.quota, 0), 'total category quota');
      result.shortfall = number(v.shortfall, 'selection shortfall', 0, result.targetSize, true);
      check(result.shortfall === result.targetSize - result.entries.length, 'quota shortfall total');
    }
    return result;
  }
  const result = {original: read(r.original), current: read(r.current),
    revisions: list(r.revisions, 'selection revisions').map(read), createdAt: timestamp(r.createdAt)};
  if (r.paperSnapshots !== undefined) result.paperSnapshots = recordMap(r.paperSnapshots, 'daily paper snapshots', checkedPaper);
  return result;
}

export function checkedRecord(kind, key, value) {
  recordKey(key);
  switch (kind) {
    case 'papers': case 'savedPapers': return checkedPaper(value, key);
    case 'bookmarks': case 'reading': pid(key); return timestamp(value);
    case 'events': return feedback(value, key);
    case 'subscriptions': return subscription(value, key);
    case 'knowledge': return knowledge(value);
    case 'glossary': return glossary(value, key);
    case 'explanations': return explanation(value, key);
    case 'selections': return selection(value, key);
    case 'highlights': {
      const v = obj(value, 'AI highlight assessment');
      const paperId = pid(v.paperId), version = number(v.version, 'highlight paper version', 0, 9999, true);
      check(key === paperId, 'highlight key');
      const provenance = source(v.source,paperId,version);
      const decision = highlightDecision(v.highlight,paperId,version,provenance);
      check(!v.noSpoilers || decision.status === 'not_established','protected highlight decision');
      return {paperId, version, text: str(v.text, 'highlight assessment', 64000, true),
        source: provenance, highlight:decision, assessedAt: timestamp(v.assessedAt),
        noSpoilers: bool(v.noSpoilers, 'highlight spoiler protection'), announcementDate: optional(v.announcementDate,date),
        assessmentKind: choice(v.assessmentKind, ['unverified_ai_assessment'], 'highlight assessment kind')};
    }
    default: throw new Error('Unknown data collection.');
  }
}

export function checkRevisionGraph(events, allowMissing = false) {
  const byId = new Map(events.map(event => [event.eventId, event]));
  check(byId.size === events.length, 'duplicate feedback identifier');
  const visited = new Set();
  for (const event of events) {
    const path = new Set();
    let item = event;
    while (item && !visited.has(item.eventId)) {
      check(!path.has(item.eventId), 'feedback revision cycle');
      path.add(item.eventId);
      const parent = byId.get(item.revisionOf);
      check(!item.revisionOf || (parent ? parent.paperId === item.paperId : allowMissing), 'feedback revision reference');
      item = parent;
    }
    for (const id of path) visited.add(id);
  }
}

export function emptyState() {
  return {settings: mergedSettings(), events: [], papers: {}, savedPapers: {}, bookmarks: {}, reading: {},
    subscriptions: [], knowledge: {}, glossary: {}, selections: {}, explanations: {}, highlights: {}};
}

export function validateImport(data) {
  if (!data || data.format !== 'arxiv-discovery' || data.schemaVersion !== SCHEMA_VERSION) throw new Error('This is not a supported arXiv Discovery backup.');
  function inspect(value, depth) {
    check(depth <= 30, 'backup nesting depth');
    if (value && typeof value === 'object') {
      if (!Array.isArray(value)) obj(value, 'backup object');
      for (const key of Object.keys(value)) {
        if (FORBIDDEN.has(key)) throw new Error('Unsafe key in backup.');
        inspect(value[key], depth + 1);
      }
    }
  }
  inspect(data, 0);
  check(new TextEncoder().encode(JSON.stringify(data)).byteLength <= 50000000, 'backup size (50 MB limit)');
  const s = obj(data.state, 'backup state');
  const result = emptyState();
  result.settings = mergedSettings(s.settings === undefined ? {} : s.settings, true);
  for (const kind of COLLECTIONS) {
    if (s[kind] === undefined) continue;
    if (kind === 'events' || kind === 'subscriptions') {
      const seen = new Set();
      result[kind] = list(s[kind], kind).map(value => {
        const key = kind === 'events' ? value?.eventId : value?.id;
        check(!seen.has(key), 'duplicate ' + kind + ' record');
        seen.add(key);
        return checkedRecord(kind, key, value);
      });
    } else {
      result[kind] = recordMap(s[kind], kind, (v, k) => checkedRecord(kind, k, v));
    }
  }
  checkRevisionGraph(result.events, true);
  return result;
}

export function publicListingKey(key) {
  const match = typeof key === 'string' && /^listing:(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
  check(match && listingUrl(match[1], match[1]), 'public listing key');
  const canonical = new URL(listingUrl(match[1], match[1]));
  return 'listing:' + canonical.origin + canonical.pathname + ':' + date(match[2]);
}

export function checkedPublicListing(value, key) {
  const v = obj(value, 'public listing');
  const day = date(v.announcementDate);
  const baseUrl = listingUrl(v.baseUrl, v.baseUrl);
  check(baseUrl && publicListingKey('listing:' + baseUrl + ':' + day) === publicListingKey(key), 'public listing identity');
  check(v.complete === true && list(v.warnings, 'listing warnings').length === 0, 'complete listing');
  check(list(v.integrityWarnings ?? [], 'listing integrity warnings').length === 0 &&
    list(v.nextUrls ?? [], 'remaining listing pages').length === 0, 'finished listing');
  const seen = new Set();
  const papers = list(v.papers, 'listing papers').map(raw => {
    const p = checkedPaper(raw);
    check(!seen.has(p.id) && p.section && p.announcementDate === day, 'unique, dated listing paper');
    seen.add(p.id);
    return p;
  });
  const counts = listingCounts(papers);
  check(v.advertisedTotal === counts.total && Object.keys(counts).every(k => v.counts?.[k] === counts[k]), 'listing counts');
  for (const [k, n] of Object.entries(obj(v.sectionTotals ?? {}, 'advertised section counts'))) {
    check(SECTIONS.includes(k) && counts[k] === n, 'advertised section count');
  }
  return {papers, counts, announcementDate: day, advertisedTotal: counts.total, baseUrl,
    complete: true, sectionTotals: Object.fromEntries(SECTIONS.map(k => [k, counts[k]])), nextUrls: [], warnings: [], integrityWarnings: []};
}

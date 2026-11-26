import test from 'node:test';
import assert from 'node:assert/strict';
import {Store, PublicCache, emptyState, validateImport} from '../src/storage.js';
import {AIClient} from '../src/ai.js';
import {analytics, paperFeatures, trainModel} from '../src/recommender.js';
import {generateSelection} from '../src/sampling.js';
import {bookmarksBibtex, csvCell, downloadText} from '../src/exports.js';

const id = '2611.00001';
const at = '2026-11-26T09:45:00Z';
const day = at.slice(0, 10);
const skey = day + '|random|new|originals|32';
const gkey = id + 'v1:limit';
const akey = 'ai:' + id + ':v1:' + 'a'.repeat(64);
const pair = 'example-only-browser-pairing-value-0000';
const paper = {
  id, version: 1, versionedId: id + 'v1', title: 'Limits of finite sums',
  authors: [{name: 'Test Author', url: 'https://arxiv.org/a/author_t_1', stableId: 'arxiv:author_t_1'}],
  categories: ['math.CA'], primaryCategory: 'math.CA', abstract: 'Sums and limits.', comments: '', journalRef: '',
  announcementDate: day, section: 'new',
  links: {abstract: 'https://arxiv.org/abs/' + id, html: 'https://arxiv.org/html/' + id + 'v1', pdf: 'https://arxiv.org/pdf/' + id},
  inlineLinks: {abstract: [{start: 0, end: 4, url: 'https://example.org/sums'}]}
};
const src = {kind: 'html', url: paper.links.html, note: 'HTML article.',
  citations: [{label: 'Section 1', url: paper.links.html + '#S1', quotes: ['Sums and limits.']}]};
const answer = {paperId: id, version: 1, savedAt: Date.parse(at), text: 'A definition of a limit.', source: src,
  usage: {inputTokens: 120, outputTokens: 42, estimatedCostUsd: 0, dailyRequests: 1, dailyCostUsd: 0}};

function adapter() {
  const values = new Map();
  return {values, get: async (k, d) => values.has(k) ? structuredClone(values.get(k)) : d,
    set: async (k, v) => values.set(k, structuredClone(v)), remove: async k => values.delete(k), keys: async () => [...values.keys()]};
}

function completeBackup() {
  const state = emptyState();
  state.settings.paperSpoilers[id] = false;
  state.papers[id] = paper;
  state.events = [{eventId: 'event1', paperId: id, version: 1, timestamp: at, value: 'like', reason: 'Interesting technique',
    mode: 'balanced', selectionProbability: 0.5, excluded: false, revisionOf: null, paper, features: paperFeatures(paper)}];
  state.bookmarks[id] = at;
  state.reading[id] = at;
  state.knowledge.Limits = {level: 'Comfortable', updatedAt: at, history: [{level: 'Comfortable', updatedAt: at}]};
  state.subscriptions = [{id: 'author1', ...paper.authors[0], createdAt: at, notes: 'Private note.', confirmedNameOnly: false}];
  state.glossary[gkey] = {term: 'Limit', paperId: id, answer: answer.text, source: src, status: 'partial', updatedAt: at, visits: 1, visitHistory: [at]};
  state.explanations[akey] = answer;
  const result = generateSelection([paper], {date: day, seed: 'fixture', mode: 'random', settings: state.settings});
  state.selections[skey] = {original: result, current: result, revisions: [result], createdAt: at, paperSnapshots: {[id]: paper}};
  return JSON.parse(JSON.stringify({format: 'arxiv-discovery', schemaVersion: 1, state}));
}

test('all version-one collections, provenance, optional histories, and mathematical links survive a round trip', async () => {
  const store = new Store(adapter());
  await store.initialize();
  const backup = completeBackup();
  await store.import(backup);
  const portable = await store.export();
  assert.deepEqual(portable.state, backup.state);
  const fresh = new Store(adapter());
  await fresh.import(portable);
  const loaded = await fresh.load();
  assert.equal(analytics(loaded).activeCount, 1);
  assert.equal(loaded.glossary[gkey].source.citations[0].url, paper.links.html + '#S1');
  assert.deepEqual(loaded.events[0].features, paperFeatures(paper));
  assert.deepEqual(loaded.selections[skey].paperSnapshots[id].inlineLinks, paper.inlineLinks);
  assert.equal(loaded.knowledge.Limits.history[0].level, 'Comfortable');
  assert.equal(loaded.subscriptions[0].notes, 'Private note.');
});

test('malformed records from every collection and dangerous URL schemes are rejected before private storage changes', async () => {
  const cases = {
    'settings type': s => { s.settings = []; },
    'unknown mode': s => { s.settings.mode = 'elsewhere'; },
    'string privacy flag': s => { s.settings.noSpoilers = 'false'; },
    'sampling bound': s => { s.settings.personalizedCount = 1000000; },
    'bad history': s => { s.settings.history = {mode: 'lastDays', days: -1}; },
    'reversed range': s => { s.settings.history = {mode: 'excludeRange', start: '2026-02-01', end: '2026-01-01'}; },
    'remote bridge': s => { s.settings.ai.url = 'https://example.org'; },
    'credentials in URL': s => { s.settings.ai.url = 'http://sample@127.0.0.1:4317'; },
    'invalid port': s => { s.settings.ai.url = 'http://127.0.0.1:99999'; },
    'out-of-range output': s => { s.settings.ai.maxOutputTokens = 8193; },
    'out-of-range budget': s => { s.settings.ai.dailyBudget = -1; },
    'invalid per-paper protection': s => { s.settings.paperSpoilers[id] = {}; },
    'bad paper id': s => { s.papers[id].id = 'unrelated'; },
    'malformed author': s => { s.papers[id].authors = [null]; },
    'wrong identity domain': s => { s.papers[id].authors[0].url = 'https://example.org/author'; },
    'bad category': s => { s.papers[id].categories = [null]; },
    'nonexistent calendar date': s => { s.papers[id].announcementDate = '2026-02-30'; },
    'unrelated source URL': s => { s.papers[id].links.pdf = 'https://arxiv.org/pdf/2611.22222'; },
    'invalid inline link': s => { s.papers[id].inlineLinks.abstract[0].url = 'data:text/plain,read'; },
    'malformed inline list': s => { s.papers[id].inlineLinks.abstract = {}; },
    'bad offset': s => { s.papers[id].inlineLinks.abstract[0].end = 250; },
    'bad feedback snapshot': s => { s.events[0].paper.authors = [5]; },
    'feedback confidence': s => { s.events[0].selectionProbability = 2; },
    'invalid feature': s => { s.events[0].features.entries = [['word:example', 'unbounded']]; },
    'duplicate event': s => { s.events.push(s.events[0]); },
    'self revision': s => { s.events[0].revisionOf = 'event1'; },
    'dangling revision': s => { s.events[0].revisionOf = 'missing'; },
    'bad bookmark': s => { s.bookmarks[id] = []; },
    'bad time': s => { s.reading[id] = '2026-11-26'; },
    'bad subscription': s => { s.subscriptions[0].notes = {}; },
    'bad knowledge level': s => { s.knowledge.Limits.level = 'other'; },
    'bad knowledge history': s => { s.knowledge.Limits.history = {}; },
    'bad glossary': s => { s.glossary[gkey].visitHistory = 'date'; },
    'links in an answer': s => { s.glossary[gkey].source.citations[0].url = 'https://example.org/cite'; },
    'bad cached output': s => { s.explanations[akey].text = {}; },
    'bad usage estimate': s => { s.explanations[akey].usage.dailyCostUsd = -4; },
    'bad revision': s => { s.selections[skey].revisions = {}; },
    'bad selected entries': s => { s.selections[skey].current.entries = [null]; },
    'duplicate selection': s => { s.selections[skey].current.entries.push(s.selections[skey].current.entries[0]); },
    'bad selection snapshot': s => { s.selections[skey].paperSnapshots[id].links.html = 'data:text/plain,untrusted'; }
  };
  const a = adapter();
  const store = new Store(a);
  await store.initialize();
  const before = [...a.values];
  for (const [label, mutate] of Object.entries(cases)) {
    const backup = completeBackup();
    mutate(backup.state);
    await assert.rejects(store.import(backup), undefined, label);
    assert.deepEqual([...a.values], before, label);
  }
});

test('portable settings discard unrecognized fields and pairing authority in either direction', async () => {
  const a = adapter();
  const store = new Store(a);
  await store.initialize();
  await store.settings({ai: {token: pair, model: 'test-model', enabled: true, consent: true, providerKey: 'unrecognized-private-field'}});
  const backup = await store.export();
  assert.equal(JSON.stringify(backup).includes(pair), false);
  assert.equal(JSON.stringify(backup).includes('unrecognized-private-field'), false);
  const given = completeBackup();
  given.state.settings.ai = {...given.state.settings.ai, enabled: true, consent: true, token: pair, OPENAI_API_KEY: 'example-only'};
  given.state.settings.unknownToken = pair;
  given.state.events[0].credential = pair;
  given.state.selections[skey].paperSnapshots[id].extra = pair;
  await store.import(given);
  assert.equal(JSON.stringify(await store.export()).includes(pair), false);
  assert.equal((await store.load()).settings.ai.enabled, false);
  assert.equal((await store.load()).settings.ai.consent, false);
  assert.equal((await store.load()).settings.ai.token, '');
  assert.equal(given.state.settings.ai.token, pair);
});

test('magic object keys and excess nesting are rejected and do not mutate ordinary objects', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const b = completeBackup();
    Object.defineProperty(b.state.knowledge, key, {enumerable: true, value: {level: 'Advanced', updatedAt: at}});
    assert.throws(() => validateImport(b), /Unsafe key/);
  }
  const nested = completeBackup();
  let v = nested.state;
  for (let i = 0; i < 32; i++) { v.padding = {}; v = v.padding; }
  assert.throws(() => validateImport(nested), /nesting depth/);
  assert.equal(Object.hasOwn(Object.prototype, 'level'), false);
});

test('incomplete legacy revision history never resurrects an earlier positive interest example', async () => {
  const a = adapter();
  const store = new Store(a);
  await store.initialize();
  await store.import(completeBackup());
  const base = a.values.get('arxiv-discovery:v1:events:event1');
  a.values.set('arxiv-discovery:v1:events:broken', {...base, eventId: 'broken', revisionOf: 'event1', value: 'removed', paper: null});
  const state = await store.load();
  assert.equal(trainModel(state.events).sampleCount, 0);
  assert.ok(state.storageWarnings.length);
  await store.deleteFeedback([id]);
  assert.equal((await store.load()).storageWarnings, undefined);
});

function mockPublicDatabase() {
  const rows = new Map();
  const db = {transaction() {
    const tx = {};
    tx.objectStore = () => ({
      put(row, k) { rows.set(k, structuredClone(row)); queueMicrotask(() => tx.oncomplete()); },
      get(k) {
        const request = {};
        queueMicrotask(() => { request.result = structuredClone(rows.get(k)); request.onsuccess(); });
        return request;
      },
      clear() { rows.clear(); queueMicrotask(() => tx.oncomplete()); }
    });
    return tx;
  }};
  return {db, rows};
}

test('page-readable IndexedDB holds public metadata only, with private checksums that reject edited listings and expiry changes', async () => {
  const privateStore = adapter();
  const {db, rows} = mockPublicDatabase();
  const publicCache = new PublicCache(privateStore);
  publicCache.open = async () => db;
  const baseUrl = 'https://arxiv.org/list/math/new';
  const key = 'listing:' + baseUrl + ':' + day;
  const listing = {papers: [{...paper, hiddenNotes: pair}], counts: {new: 1, cross: 0, replacement: 0, total: 1}, advertisedTotal: 1,
    complete: true, warnings: [], nextUrls: [], announcementDate: day, baseUrl, settings: {ai: {token: pair}}, glossary: {private: 'not public'}};
  await publicCache.set(key, listing);
  const row = rows.get(key);
  assert.equal(JSON.stringify(row).includes(pair), false);
  assert.equal(JSON.stringify(row).includes('glossary'), false);
  assert.equal((await publicCache.get('listing:' + baseUrl + '?show=200:' + day)).papers[0].title, paper.title);
  const original = structuredClone(row);
  row.value.papers[0].title = 'Edited by a page script';
  assert.equal(await publicCache.get(key), null);
  rows.set(key, {...original, at: original.at - 1000});
  assert.equal(await publicCache.get(key), null);
  rows.set(key, original);
  assert.equal(await publicCache.get(key, 0), null);
  assert.equal(await publicCache.get('listing:' + baseUrl + ':2026-11-27'), null);
  await publicCache.clear();
  assert.equal(rows.size, 0);
  assert.equal(privateStore.values.size, 0);
});

test('an inflight explanation cannot write after deletion, even when a second identical question is sent', async () => {
  const store = new Store(adapter());
  await store.initialize();
  await store.settings({ai: {model: 'fixture-model', token: pair, enabled: true, consent: true}});
  const responses = [];
  let signalSent;
  const nextSend = () => new Promise(resolve => { signalSent = resolve; });
  const client = new AIClient({
    request: () => new Promise(resolve => { responses.push(resolve); signalSent(); }),
    getSettings: async () => (await store.load()).settings,
    getGeneration: () => store.generation(), cacheGet: key => store.get('explanations', key),
    cacheSet: async (key, data, generation) => {
      if (!await store.setIfGeneration('explanations', key, data, generation)) throw new Error('Request superseded by deletion.');
    }
  });
  const firstSent = nextSend();
  const first = client.overview(paper);
  await firstSent;
  await store.clearCollection('explanations');
  const secondSent = nextSend();
  const second = client.overview(paper);
  await secondSent;
  const reply = text => ({status: 200, text: JSON.stringify({text, source: src})});
  responses[1](reply('Current answer.'));
  await second;
  responses[0](reply('Answer from before deletion.'));
  await first;
  const cached = Object.values((await store.load()).explanations);
  assert.deepEqual(cached.map(x => x.text), ['Current answer.']);
  assert.deepEqual((await client.overview(paper)).text, 'Current answer.');
});

test('downloads use a detached anchor and text exports quote spreadsheet and bibliographic metacharacters', t => {
  const clicks = [];
  const anchor = {click() { clicks.push([this.href, this.download]); }};
  const previous = globalThis.document;
  globalThis.document = {createElement: tag => { assert.equal(tag, 'a'); return anchor; }};
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  t.mock.method(URL, 'createObjectURL', () => 'blob:fixture');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  downloadText('backup.json', '{"private":"entry"}', 'application/json');
  assert.deepEqual(clicks, [['blob:fixture', 'backup.json']]);
  assert.equal(csvCell('   = harmless'), '"\'   = harmless"');
  const state = completeBackup().state;
  state.papers[id].title = 'A \\TeX term & a 5% change';
  const bib = bookmarksBibtex(state);
  assert.match(bib, /\\textbackslash\{\}TeX/);
  assert.ok(bib.includes('\\&') && bib.includes('5\\%'));
});

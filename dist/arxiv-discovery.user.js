// ==UserScript==
// @name         arXiv Discovery
// @namespace    https://github.com/sodium-qed/arXiv-scroller
// @version      1.0.0
// @description  A finite daily mathematics selection, reversible local recommendations, and optional paper explanations. Adds to arXiv without replacing its interface.
// @author       sodium-qed
// @homepageURL  https://github.com/sodium-qed/arXiv-scroller
// @supportURL   https://github.com/sodium-qed/arXiv-scroller/issues
// @downloadURL  https://raw.githubusercontent.com/sodium-qed/arXiv-scroller/main/dist/arxiv-discovery.user.js
// @updateURL    https://raw.githubusercontent.com/sodium-qed/arXiv-scroller/main/dist/arxiv-discovery.user.js
// @match        https://arxiv.org/list/math/*
// @match        https://arxiv.org/list/math.*/*
// @match        https://arxiv.org/list/math-ph/*
// @match        https://arxiv.org/list/cs.IT/*
// @match        https://arxiv.org/list/cs.NA/*
// @match        https://arxiv.org/list/stat.TH/*
// @match        https://arxiv.org/abs/*
// @match        https://arxiv.org/html/*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      arxiv.org
// @connect      127.0.0.1
// ==/UserScript==

(() => {
'use strict';
const __factories = {
"src/main.js": (__require) => {
const {Store,createGMAdapter} = __require("src/storage.js");
const {DiscoveryApp} = __require("src/app.js");

// No globals or credentials are exposed to the page. All DOM additions are removable.
if (window.top===window.self) {
  const store=new Store(createGMAdapter());
  const app=new DiscoveryApp(store);
  app.initialize().catch(error=>{
    console.error('[arXiv Discovery]',error);
    if(typeof GM_registerMenuCommand==='function')GM_registerMenuCommand('arXiv Discovery startup error',()=>alert(`arXiv Discovery could not start: ${error.message}`));
  });
}

return {};
},
"src/storage.js": (__require) => {
const {activeFeedback, paperFeatures} = __require("src/recommender.js");
const {SCHEMA_VERSION, DEFAULT_SETTINGS, COLLECTIONS, checkedRecord, recordKey, checkedPaper, checkRevisionGraph,
  mergedSettings, emptyState, validateImport, checkedPublicListing, publicListingKey} = __require("src/schema.js");



const PREFIX = 'arxiv-discovery:v1:';
const JOURNAL = PREFIX + 'transaction';
const GENERATION = PREFIX + 'generation';
const REVISION = PREFIX + 'revision';
const SETTINGS = PREFIX + 'settings';
const SCHEMA = PREFIX + 'schema';
const DIGEST = PREFIX + 'listing-digest:';
const LOCAL_QUEUES = new WeakMap();

function makeId() {
  return globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
}

function createGMAdapter() {
  if (typeof GM_getValue !== 'function') throw new Error('Install this script in Tampermonkey to enable private persistent storage.');
  return {
    get: async (key, fallback) => GM_getValue(key, fallback), set: async (key, value) => GM_setValue(key, value),
    remove: async key => GM_deleteValue(key), keys: async () => GM_listValues(),
    listen: (key, callback) => typeof GM_addValueChangeListener === 'function' ? GM_addValueChangeListener(key, callback) : null
  };
}

function serialized(adapter, fn) {
  // Chrome's shared lock covers distinct userscript instances in different tabs.
  if (globalThis.navigator?.locks?.request) return navigator.locks.request('arxiv-discovery-private-storage-v1', fn);
  const previous = LOCAL_QUEUES.get(adapter) || Promise.resolve();
  const task = previous.then(fn);
  LOCAL_QUEUES.set(adapter, task.catch(() => {}));
  return task;
}

function recordPath(kind, id) {
  if (!COLLECTIONS.includes(kind)) throw new Error('Unknown data collection.');
  return PREFIX + kind + ':' + recordKey(id);
}

function withinNamespace(key) {
  return typeof key === 'string' && key.startsWith(PREFIX) && key !== JOURNAL && key !== GENERATION && key !== REVISION;
}

function entriesOf(state, kind) {
  return Array.isArray(state[kind])
    ? state[kind].map(record => [kind === 'events' ? record.eventId : record.id, record])
    : Object.entries(state[kind]);
}

class Store {
  constructor(adapter) { this.adapter = adapter; }

  async finishTransaction(tx) {
    // Only this private namespace can be changed during crash recovery.
    if (tx?.kind === 'remove' && Array.isArray(tx.keys) && tx.keys.every(withinNamespace)) {
      for (const key of tx.keys) await this.adapter.remove(key);
    } else if (tx?.kind === 'restore' && Array.isArray(tx.before) &&
        tx.before.every(pair => Array.isArray(pair) && pair.length === 2 && withinNamespace(pair[0]))) {
      // Free space occupied by previously absent records before restoring replaced records.
      for (const [key, previous] of tx.before) if (previous === null) await this.adapter.remove(key);
      for (const [key, previous] of tx.before) if (previous !== null) await this.adapter.set(key, previous);
    } else {
      throw new Error('The private recovery record is unreadable. Private records were preserved.');
    }
    await this.changed(true);
    await this.adapter.remove(JOURNAL);
  }

  queue(fn) {
    return serialized(this.adapter, async () => {
      const version = await this.adapter.get(SCHEMA, 0);
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error('Stored data requires a newer script version or an unreadable schema. Private records were preserved.');
      const interrupted = await this.adapter.get(JOURNAL, null);
      if (interrupted) await this.finishTransaction(interrupted);
      return fn();
    });
  }

  async changed(invalidate = false) {
    const revision = makeId();
    if (invalidate) await this.adapter.set(GENERATION, revision);
    await this.adapter.set(REVISION, revision);
  }

  async initialize() {
    return this.queue(async () => {
      const version = await this.adapter.get(SCHEMA, 0);
      if (!version) await this.adapter.set(SCHEMA, SCHEMA_VERSION);
      return this.readState();
    });
  }

  async readSettings(warnings) {
    const raw = await this.adapter.get(SETTINGS, {});
    try { return mergedSettings(raw); }
    catch {
      warnings?.push('Invalid saved settings were skipped. The add-on is using its default settings.');
      return mergedSettings();
    }
  }

  async records(kinds, warnings) {
    const allowed = new Set(kinds);
    const all = await this.adapter.keys();
    const rows = [];
    const eventGroups = new Map();
    const invalidHistories = new Set();
    let skipped = 0;
    for (const key of all) {
      if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue;
      const at = key.indexOf(':', PREFIX.length);
      const kind = at < 0 ? '' : key.slice(PREFIX.length, at);
      if (!allowed.has(kind)) continue;
      const id = key.slice(at + 1);
      const value = await this.adapter.get(key, null);
      if (value === null) continue;
      try {
        const item = checkedRecord(kind, id, value);
        rows.push([kind, id, item]);
        if (kind === 'events') {
          if (!eventGroups.has(item.paperId)) eventGroups.set(item.paperId, []);
          eventGroups.get(item.paperId).push(item);
        }
      } catch {
        skipped++;
        if (kind === 'events' && typeof value.paperId === 'string') invalidHistories.add(value.paperId);
      }
    }
    // If an old correction or tombstone is damaged, keeping its previous like
    // would silently reactivate a superseded preference.
    for (const [paperId, history] of eventGroups) {
      try { checkRevisionGraph(history); } catch { invalidHistories.add(paperId); }
    }
    if (skipped) warnings?.push(skipped + ' invalid private record(s) were skipped and remain in storage.');
    if (invalidHistories.size) warnings?.push(invalidHistories.size + ' incomplete feedback history/histories were excluded to preserve prior corrections.');
    return invalidHistories.size ? rows.filter(([kind, , item]) => kind !== 'events' || !invalidHistories.has(item.paperId)) : rows;
  }

  async readState() {
    const state = emptyState();
    const warnings = [];
    state.settings = await this.readSettings(warnings);
    for (const [kind, id, value] of await this.records(COLLECTIONS, warnings)) {
      if (Array.isArray(state[kind])) state[kind].push(value);
      else Object.defineProperty(state[kind], id, {value, enumerable: true, configurable: true, writable: true});
    }
    state.events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.eventId.localeCompare(b.eventId));
    if (warnings.length) state.storageWarnings = warnings;
    return state;
  }

  load() { return this.queue(() => this.readState()); }

  async get(kind, id, fallback = null) {
    const key = recordPath(kind, id);
    return this.queue(async () => {
      const value = await this.adapter.get(key, null);
      if (value === null) return fallback;
      try { return checkedRecord(kind, id, value); } catch { return fallback; }
    });
  }

  generation() { return this.queue(() => this.adapter.get(GENERATION, 'initial')); }

  async writeRecord(kind, id, value) {
    const key = recordPath(kind, id);
    let data = checkedRecord(kind, id, value);
    if (kind === 'events') {
      // An exclusion checkbox may refer to an event another tab has permanently deleted.
      // Rating changes and additions must go through feedback() to append a revision.
      const existing = await this.adapter.get(key, null);
      if (existing === null) throw new Error('This feedback event was deleted. Reload the interest history.');
      data = {...checkedRecord(kind, id, existing), excluded: data.excluded};
    }
    await this.adapter.set(key, data);
    await this.changed();
  }

  set(kind, id, value) { return this.queue(() => this.writeRecord(kind, id, value)); }

  setIfGeneration(kind, id, value, expected) {
    return this.queue(async () => {
      if (expected !== await this.adapter.get(GENERATION, 'initial')) return false;
      await this.writeRecord(kind, id, value);
      return true;
    });
  }

  async removeMany(keys) {
    const tx = {kind: 'remove', keys};
    await this.adapter.set(JOURNAL, tx);
    await this.finishTransaction(tx);
  }

  remove(kind, id) {
    const key = recordPath(kind, id);
    if (kind === 'events') throw new Error('Delete all revisions for a paper using the feedback history.');
    return this.queue(() => this.removeMany([key]));
  }

  settings(patch) {
    return this.queue(async () => {
      const current = await this.readSettings();
      const value = mergedSettings({...current, ...patch, history: {...current.history, ...patch.history},
        ai: {...current.ai, ...patch.ai}, paperSpoilers: {...current.paperSpoilers, ...patch.paperSpoilers}});
      await this.adapter.set(SETTINGS, value);
      await this.changed();
      return value;
    });
  }

  cachePapers(papers) {
    const checked = papers.map(paper => checkedPaper(paper));
    return this.queue(async () => {
      for (const p of checked) await this.adapter.set(recordPath('papers', p.id), p);
    });
  }

  feedback(raw, value, reason, mode, probability = null) {
    const paper = checkedPaper(raw);
    return this.queue(async () => {
      const history = (await this.records(['events'])).map(([, , e]) => e).filter(e => e.paperId === paper.id);
      history.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.eventId.localeCompare(b.eventId));
      const previous = activeFeedback(history).latest[0];
      const id = makeId();
      const event = checkedRecord('events', id, {eventId: id, paperId: paper.id, version: paper.version,
        timestamp: new Date().toISOString(), value, reason: reason || '', mode, selectionProbability: probability,
        revisionOf: previous?.eventId || null, excluded: false, paper, features: paperFeatures(paper)});
      await this.adapter.set(recordPath('events', id), event);
      await this.changed();
      return event;
    });
  }

  deleteFeedback(paperIds) {
    const ids = new Set(paperIds);
    return this.queue(async () => {
      // Also erase malformed legacy revisions for an identifiable paper.
      const keys = [];
      for (const key of await this.adapter.keys()) {
        if (key.startsWith(PREFIX + 'events:') && ids.has((await this.adapter.get(key, null))?.paperId)) keys.push(key);
      }
      await this.removeMany(keys);
    });
  }

  clearCollection(kind) {
    if (!COLLECTIONS.includes(kind)) throw new Error('Unknown data collection.');
    return this.queue(async () => this.removeMany((await this.adapter.keys()).filter(key => key.startsWith(PREFIX + kind + ':'))));
  }

  clearAll() {
    return this.queue(async () => this.removeMany((await this.adapter.keys()).filter(withinNamespace)));
  }

  subscribe(callback) {
    return this.adapter.listen?.(REVISION, (_key, _old, _next, remote) => { if (remote) callback(); });
  }

  async export() {
    const state = await this.load();
    state.settings = mergedSettings(state.settings, true);
    return {format: 'arxiv-discovery', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), state};
  }

  async import(data) {
    const state = validateImport(data);
    return this.queue(async () => {
      const oldEvents = (await this.records(['events'])).map(([, , e]) => e);
      const merged = new Map(oldEvents.map(e => [e.eventId, e]));
      for (const e of state.events) {
        const original = merged.get(e.eventId);
        if (original && original.paperId !== e.paperId) throw new Error('A feedback identifier belongs to another paper.');
        merged.set(e.eventId, e);
      }
      checkRevisionGraph([...merged.values()]);
      const writes = [];
      for (const kind of COLLECTIONS) for (const [id, value] of entriesOf(state, kind)) writes.push([recordPath(kind, id), value]);
      writes.push([SETTINGS, state.settings], [SCHEMA, SCHEMA_VERSION]);
      const before = [];
      for (const [key] of writes) before.push([key, await this.adapter.get(key, null)]);
      const rollback = {kind: 'restore', before};
      await this.adapter.set(JOURNAL, rollback);
      try {
        for (const [key, value] of writes) await this.adapter.set(key, value);
        await this.changed(true);
        await this.adapter.remove(JOURNAL);
      } catch (error) {
        await this.finishTransaction(rollback);
        throw error;
      }
    });
  }
}

async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// IndexedDB is readable and writable by the host site. Store only public, projected
// metadata there. Its checksum is kept separately in userscript-manager storage.
class PublicCache {
  constructor(adapter = typeof GM_getValue === 'function' ? createGMAdapter() : null) {
    this.adapter = adapter;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (typeof indexedDB === 'undefined') return null;
    this.db = await new Promise(resolve => {
      try {
        const request = indexedDB.open('arxiv-discovery-public', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('cache');
        request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); this.db = null; }; resolve(db); };
        request.onerror = request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.db;
  }

  async get(key, maxAge = 86400000) {
    try {
      const id = publicListingKey(key);
      const expected = await this.adapter?.get(DIGEST + id, null);
      if (!expected) return null;
      const db = await this.open();
      if (!db) return null;
      const row = await new Promise(resolve => {
        const request = db.transaction('cache', 'readonly').objectStore('cache').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      const age = Date.now() - row?.at;
      if (!Number.isFinite(age) || age < 0 || age >= maxAge) return null;
      const value = checkedPublicListing(row.value, id);
      return await fingerprint([row.at, value]) === expected ? value : null;
    } catch { return null; }
  }

  async set(key, listing) {
    const id = publicListingKey(key);
    const value = checkedPublicListing(listing, id);
    if (!this.adapter) return;
    try {
      const db = await this.open();
      if (!db) return;
      const at = Date.now();
      const checksum = await fingerprint([at, value]);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('cache', 'readwrite');
        tx.objectStore('cache').put({at, value}, id);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = reject;
      });
      await this.adapter.set(DIGEST + id, checksum);
    } catch { /* Caching is optional. The verified listing is already in memory. */ }
  }

  async clear() {
    if (this.adapter) for (const key of await this.adapter.keys()) if (key.startsWith(DIGEST)) await this.adapter.remove(key);
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('cache', 'readwrite');
        tx.objectStore('cache').clear();
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = reject;
      });
    } catch { /* Old public entries are unusable after the private checksums are gone. */ }
  }
}

return {makeId,createGMAdapter,Store,PublicCache,SCHEMA_VERSION,DEFAULT_SETTINGS,mergedSettings,emptyState,validateImport};
},
"src/recommender.js": (__require) => {
const { CATEGORIES, normalizeCategory } = __require("src/categories.js");

// Coordinates shared by synonymous mathematical expressions. Other topics still
// receive their own token and phrase coordinates, learned directly from ratings.
const SEMANTIC_CONCEPTS = [
  ['elementary inequalities', /\b(?:elementary|algebraic|symmetric) inequalit(?:y|ies)\b|\b(?:am gm|arithmetic geometric mean|cauchy schwarz|schwarz inequality|holder inequality|jensen.{0,3} inequality)\b/],
  ['arithmetic–geometric mean inequality', /\bam gm\b|\barithmetic (?:mean )?geometric mean\b/],
  ['Cauchy–Schwarz inequality', /\bcauchy schwarz\b|\bschwarz inequality\b/],
  ['convexity', /\bconvex(?:ity|ification| sets?| functions?| bodies| geometry| optimization| analysis)\b|\bjensen.{0,3} inequality\b/],
  ['fixed-point methods', /\bfixed points?\b|\bcontraction (?:mapping|principle)\b/],
  ['ordinary differential equations', /\bordinary differential equations?\b|\bodes?\b/],
  ['partial differential equations', /\bpartial differential equations?\b|\bpdes?\b/],
  ['Fourier analysis', /\bfourier\b|\bharmonic analysis\b|\btrigonometric (?:series|polynomial)/],
  ['wavelets', /\bwavelets?\b|\bmultiresolution analysis\b/],
  ['Sobolev spaces', /\bsobolev\b|\bweak derivatives?\b/],
  ['fluid equations', /\bnavier stokes\b|\beuler equations?\b|\bfluid (?:dynamics|mechanics|equations?)\b/],
  ['optimal transport', /\boptimal (?:mass )?transport(?:ation)?\b|\bwasserstein\b|\bmonge kantorovich\b/],
  ['calculus of variations', /\bcalculus of variations\b|\bvariational (?:method|principle|problem)|\beuler lagrange\b/],
  ['finite element methods', /\bfinite elements?\b|\bgalerkin\b/],
  ['spectral methods', /\bspectral (?:methods?|collocation|approximation)\b|\bpseudospectral\b/],
  ['iterative linear solvers', /\bkrylov\b|\bconjugate gradient\b|\bgmres\b|\biterative linear solvers?\b/],
  ['gradient optimization', /\bgradient (?:descent|flows?|methods?)\b|\bsteepest descent\b/],
  ['integer optimization', /\binteger (?:linear )?(?:programming|optimization)\b|\bmixed integer\b/],
  ['elliptic curves', /\belliptic curves?\b|\bmordell weil\b|\bweierstrass equations?\b/],
  ['modular forms', /\b(?:modular|automorphic|cusp) forms?\b|\bhecke (?:operator|algebra)/],
  ['prime numbers', /\bprime (?:numbers?|gaps?|tuples?|distribution)\b|\bprimes\b|\briemann hypothesis\b/],
  ['Diophantine equations', /\bdiophantine\b|\binteger solutions?\b/],
  ['Galois theory', /\bgalois\b|\bfield extensions?\b/],
  ['lattice point counting', /\blattice points?\b|\behrhart\b/],
  ['algebraic varieties', /\balgebraic variet(?:y|ies)\b|\bprojective variet(?:y|ies)\b|\baffine variet(?:y|ies)\b/],
  ['Gröbner bases', /\bgro(?:e)?bner\b|\bbuchberger\b/],
  ['commutative ideals', /\bmonomial ideals?\b|\bprime ideals?\b|\bprimary decomposition\b/],
  ['derived categories', /\bderived (?:categor|functor)|\btriangulated categor/],
  ['homological algebra', /\b(?:co)?homolog(?:y|ical)\b|\bexact sequences?\b|\bext (?:group|functor)/],
  ['sheaf theory', /\bshea(?:f|ves)\b|\bpreshea(?:f|ves)\b/],
  ['category theory', /\bfunctor(?:s|ial)?\b|\bnatural transformations?\b|\bmonoidal categor|\bcategory theory\b/],
  ['K-theory', /\bk theory\b|\bgrothendieck groups?\b/],
  ['homotopy theory', /\bhomotop(?:y|ic|ical)\b|\bfundamental groups?\b/],
  ['knot theory', /\bknots?\b|\bkhovanov\b|\bjones polynomials?\b/],
  ['symplectic geometry', /\bsymplectic\b|\blagrangian (?:submanifold|fibration)|\bfloer\b/],
  ['Riemannian geometry', /\briemannian\b|\bricci\b|\bgeodesics?\b|\bsectional curvature\b/],
  ['metric geometry', /\bmetric spaces?\b|\bgromov hausdorff\b|\bgeodesic metric\b/],
  ['complex analysis', /\bholomorphic\b|\bmeromorphic\b|\bcomplex analys(?:is|tic)\b/],
  ['dynamical systems', /\bdynamical systems?\b|\bergodic\b|\bsymbolic dynamics\b/],
  ['graph coloring', /\b(?:vertex|edge|graph|list) colou?ring\b|\bchromatic (?:number|polynomial|index)\b/],
  ['graph matchings', /\b(?:perfect|bipartite|maximum|graph) matchings?\b|\bhall.{0,3} (?:theorem|condition)\b/],
  ['graphs and networks', /\bgraphs?\b|\bnetwork theory\b|\bgraphon/],
  ['extremal combinatorics', /\bextremal (?:graphs?|combinatorics)\b|\bturan\b|\bramsey\b/],
  ['generating functions', /\bgenerating (?:functions?|series)\b|\bformal power series\b/],
  ['combinatorial designs', /\b(?:block|combinatorial) designs?\b|\bsteiner systems?\b/],
  ['group representations', /\brepresentation(?:s| theory) of (?:a |the )?(?:finite |lie )?groups?\b|\bgroup representations?\b|\bcharacters? of (?:a |the )?groups?\b/],
  ['Lie algebras', /\blie (?:algebras?|brackets?|groups?)\b|\broot systems?\b/],
  ['quantum groups', /\bquantum groups?\b|\bhopf algebras?\b/],
  ['operator algebras', /\boperator algebras?\b|\bvon neumann algebras?\b|\bc (?:star )?algebras?\b/],
  ['spectral theory', /\bspectral theor(?:y|em)\b|\beigen(?:values?|functions?|vectors?)\b|\bspectra of\b/],
  ['Banach spaces', /\bbanach\b|\bnormed (?:linear |vector )?spaces?\b/],
  ['Hilbert spaces', /\bhilbert spaces?\b|\binner product spaces?\b/],
  ['probabilistic methods', /\bprobabilistic methods?\b|\bsecond moment methods?\b|\bfirst moment methods?\b/],
  ['random matrices', /\brandom matri(?:x|ces)\b|\bwigner (?:matrix|matrices|ensemble)\b/],
  ['stochastic processes', /\bstochastic processes?\b|\bbrownian\b|\bwiener process|\bmartingales?\b/],
  ['Markov chains', /\bmarkov (?:chains?|process(?:es)?)\b|\brandom walks?\b/],
  ['concentration inequalities', /\bconcentration (?:of measure|inequalit(?:y|ies))\b|\bchernoff\b|\bhoeffding\b/],
  ['Bayesian inference', /\bbayes(?:ian)?\b|\bposterior (?:distribution|inference)/],
  ['statistical estimation', /\b(?:maximum likelihood|minimax estimation|statistical estimat(?:ion|ors?))\b/],
  ['information and coding', /\bmutual information\b|\bchannel capacity\b|\bshannon\b|\berror correct(?:ing|ion) codes?\b/],
  ['set theory', /\bset theory\b|\bforcing (?:axiom|extension)|\blarge cardinals?\b/],
  ['model theory', /\bmodel theor(?:y|etic)\b|\bo minimal\b|\belementary equivalence\b/],
  ['proof theory', /\bproof theory\b|\bsequent calculus\b|\bcut elimination\b/],
  ['quantum mechanics', /\bquantum mechanics\b|\bschrodinger\b|\bhamiltonian (?:operator|systems?)\b/],
  ['persistent homology', /\bpersistent homology\b|\btopological data analysis\b/],
  ['machine learning', /\bmachine learning\b|\bneural networks?\b|\bdeep learning\b/],
];

const STOP = new Set(('a an and are as at be been being by can could did do does for from had has have ' +
  'he if in into is it its may more most new no not of on one or other our over paper previous prove ' +
  'proved proves proving provide provides recent result results show shown shows some such than that ' +
  'the their them then there these they this those through to two under upon us use used using various ' +
  'was we were when where which while will with within without work works also consider establish ' +
  'established obtain obtained study studying investigate introduce give given let mathrm mathbf mathcal ' +
  'mathbb operatorname left right frac begin end quad qquad text label ref cite').split(/\s+/));
const DAY = 86400000;
const EMBEDDING_SCHEMA = 'math-content-v1';
const cache = new WeakMap();

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function paperCategories(paper) {
  const raw = [paper?.primaryCategory, ...(Array.isArray(paper?.categories) ? paper.categories : [])];
  return [...new Set(raw.filter(code => typeof code === 'string').map(normalizeCategory)
    .filter(code => Object.hasOwn(CATEGORIES, code)))];
}

function plainMath(text) {
  return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\\(?:text|mathrm|mathbf|mathcal|mathbb|operatorname)\s*\{([^{}]*)\}/g, ' $1 ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(text) {
  return text.split(/\s+/).filter(word => word.length >= 2 && word.length <= 45 &&
    /\p{L}/u.test(word) && !STOP.has(word));
}

function bump(map, key, by) {
  map.set(key, (map.get(key) || 0) + by);
}

function collectText(words, weight, singles, pairs) {
  for (let i = 0; i < words.length; i++) {
    bump(singles, words[i], weight);
    if (i > 0) bump(pairs, words[i - 1] + ' ' + words[i], weight);
  }
}

function addGroup(entries, prefix, counts, strength) {
  const features = [...counts].map(([key, value]) => [prefix + key, Math.log1p(value)]);
  const norm = Math.sqrt(features.reduce((sum, [, value]) => sum + value * value, 0));
  if (norm) for (const [key, value] of features) entries.push([key, strength * value / norm]);
}

function embedding(paper) {
  const title = String(paper?.title || '').slice(0, 2000);
  const abstract = String(paper?.abstract || '').slice(0, 16000);
  const categories = paperCategories(paper);
  const cached = paper && cache.get(paper);
  if (cached && cached.title === title && cached.abstract === abstract &&
      cached.categoryKey === categories.join('|')) return cached;

  const heading = plainMath(title);
  const body = plainMath(abstract);
  const titleWords = tokens(heading).slice(0, 96);
  const bodyWords = tokens(body).slice(0, 576);
  const singles = new Map();
  const pairs = new Map();
  const concepts = new Map();
  collectText(titleWords, 3, singles, pairs);
  collectText(bodyWords, 1, singles, pairs);
  for (const [term, pattern] of SEMANTIC_CONCEPTS) {
    const strength = (pattern.test(heading) ? 3 : 0) + (pattern.test(body) ? 1 : 0);
    if (strength) concepts.set(term, strength);
  }
  const terms = [...concepts.keys()];
  // Unknown mathematics stays discoverable through precise title phrases.
  if (!terms.length) {
    const titlePhrases = new Map();
    for (let i = 1; i < titleWords.length; i++) {
      const phrase = titleWords[i - 1] + ' ' + titleWords[i];
      if (!titlePhrases.has(phrase)) titlePhrases.set(phrase, pairs.get(phrase));
    }
    terms.push(...[...titlePhrases].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([term]) => term));
    if (!terms.length && titleWords.length) terms.push(titleWords[0]);
  }
  const entries = [];
  addGroup(entries, 'word:', singles, 1.35);
  addGroup(entries, 'phrase:', pairs, 0.95);
  addGroup(entries, 'concept:', concepts, 1.85);
  addGroup(entries, 'subject:', new Map(categories.map(code => [code, 1])), 0.45);
  const result = {title, abstract, categoryKey: categories.join('|'), terms, entries};
  if (paper && typeof paper === 'object') cache.set(paper, result);
  return result;
}

function paperFeatures(paper) {
  return {schema: EMBEDDING_SCHEMA, entries: embedding(paper).entries.map(entry => [...entry])};
}

function conceptTerms(paper) {
  return [...embedding(paper).terms];
}

function epoch(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function dayOf(value) {
  const ms = epoch(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function isoDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    dayOf(value) === value ? value : '';
}

function inRange(day, start, end) {
  return Boolean(day) && (!start || day >= start) && (!end || day <= end);
}

function latestFeedback(events) {
  const papers = new Map();
  for (const event of events || []) {
    if (typeof event?.paperId !== 'string' || !event.paperId) continue;
    if (!papers.has(event.paperId)) papers.set(event.paperId, []);
    papers.get(event.paperId).push(event);
  }
  const latest = [];
  for (const history of papers.values()) {
    const superseded = new Set(history.map(event => event.revisionOf).filter(Boolean));
    const tips = history.filter(event => !superseded.has(event.eventId));
    let chosen;
    let chosenTime = -Infinity;
    // For independent branches, choose the newest timestamp and break ties by
    // append order. A valid explicit revision also wins after a clock rollback.
    for (const event of tips.length ? tips : history) {
      const timestamp = epoch(event.timestamp);
      const time = Number.isFinite(timestamp) ? timestamp : -Infinity;
      if (time >= chosenTime) {
        chosen = event;
        chosenTime = time;
      }
    }
    latest.push(chosen);
  }
  return latest.sort((a, b) => (epoch(a.timestamp) || 0) - (epoch(b.timestamp) || 0));
}

function trainingEligible(event, settings, now) {
  const time = epoch(event.timestamp);
  if (!Number.isFinite(time) || !event.paper || typeof event.paper !== 'object' || event.excluded) return false;
  if (settings.trainRandom === false && event.mode === 'random') return false;
  if (time <= epoch(settings.resetAt)) return false;
  const history = settings.history || {};
  const day = dayOf(time);
  const start = isoDay(history.start);
  const end = isoDay(history.end);
  const days = Number.isFinite(Number(history.days)) ? Math.max(0, Number(history.days)) : 30;
  const cutoff = now - days * DAY;
  switch (history.mode) {
    case 'none': return false;
    case 'lastDays': return time >= cutoff && time <= now;
    case 'ignoreLastDays': return time < cutoff;
    case 'before': return !(start || end) || day >= (start || end);
    case 'after': return !(end || start) || day <= (end || start);
    case 'excludeRange': return !start || !end || !inRange(day, start < end ? start : end, start < end ? end : start);
    default: return true;
  }
}

function activeFeedback(events, settings = {}, now = Date.now()) {
  const latest = latestFeedback(events);
  const active = [];
  const excluded = [];
  const clock = epoch(now);
  for (const event of latest) {
    if (event.value !== 'like' && event.value !== 'dislike') continue;
    (trainingEligible(event, settings, clock) ? active : excluded).push(event);
  }
  return {latest, active, excluded};
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));
}

function fit(examples) {
  const index = new Map();
  let maxSquaredNorm = 1;
  const rows = examples.map(event => {
    const entries = embedding(event.paper).entries;
    const indices = new Uint32Array(entries.length);
    const values = new Float64Array(entries.length);
    let squaredNorm = 1;
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      if (!index.has(key)) index.set(key, index.size);
      indices[i] = index.get(key);
      values[i] = value;
      squaredNorm += value * value;
    }
    maxSquaredNorm = Math.max(maxSquaredNorm, squaredNorm);
    return {indices, values, outcome: Number(event.value === 'like')};
  });
  const coefficients = new Float64Array(index.size);
  const gradient = new Float64Array(index.size);
  const weightPenalty = 0.22;
  const biasPenalty = 1.25;
  const step = 1 / (0.25 * maxSquaredNorm + biasPenalty);
  let bias = 0;
  for (let iteration = 0; iteration < 72; iteration++) {
    gradient.fill(0);
    let biasGradient = 0;
    for (const {indices, values, outcome} of rows) {
      let logit = bias;
      for (let i = 0; i < indices.length; i++) logit += coefficients[indices[i]] * values[i];
      const error = sigmoid(logit) - outcome;
      biasGradient += error;
      for (let i = 0; i < indices.length; i++) gradient[indices[i]] += error * values[i];
    }
    biasGradient = biasGradient / rows.length + biasPenalty * bias;
    bias -= step * biasGradient;
    let greatest = Math.abs(biasGradient);
    for (let i = 0; i < coefficients.length; i++) {
      const derivative = gradient[i] / rows.length + weightPenalty * coefficients[i];
      coefficients[i] -= step * derivative;
      greatest = Math.max(greatest, Math.abs(derivative));
    }
    if (greatest < 0.0001) break;
  }
  return {bias, weights: new Map([...index].map(([term, i]) => [term, coefficients[i]]))};
}

function trainModel(events, settings = {}, now = Date.now()) {
  const {active} = activeFeedback(events, settings, now);
  const examples = [...active].sort((a, b) => compareText(a.paperId, b.paperId));
  const positiveCount = examples.filter(event => event.value === 'like').length;
  return {
    schema: EMBEDDING_SCHEMA,
    sampleCount: examples.length,
    positiveCount,
    negativeCount: examples.length - positiveCount,
    encounterPapers: examples.map(event => event.paper),
    ...(examples.length ? fit(examples) : {weights: new Map(), bias: 0}),
  };
}

function predict(model, paper) {
  if (!model?.sampleCount || !(model.weights instanceof Map)) return null;
  let score = model.bias;
  for (const [feature, value] of embedding(paper).entries) score += (model.weights.get(feature) || 0) * value;
  return sigmoid(score);
}

function interestEvidence(model, paper) {
  if (!model?.sampleCount) return null;
  let strongest = 0;
  let term = null;
  for (const [key, value] of embedding(paper).entries) {
    const contribution = (model.weights.get(key) || 0) * value;
    if (contribution > strongest && !key.startsWith('subject:')) {
      strongest = contribution;
      term = key.slice(key.indexOf(':') + 1);
    }
  }
  return term;
}

function authorName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function stableAuthorId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  const orcid = /^(?:(?:https?:\/\/(?:www\.)?orcid\.org\/|orcid:)\s*)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?$/i.exec(id);
  if (orcid) return 'orcid:' + orcid[1].toUpperCase();
  const arxiv = /^(?:https?:\/\/(?:www\.)?arxiv\.org\/a\/|arxiv:)([a-zA-Z0-9_-]+)\/?$/.exec(id);
  if (arxiv) return 'arxiv:' + arxiv[1];
  return id;
}

function authorIdentity(author) {
  const id = stableAuthorId(author?.stableId);
  const name = authorName(author?.name);
  return id ? 'id:' + id : name ? 'name:' + name : '';
}

function subscriptionMatches(author, subscription) {
  if (!author || !subscription) return false;
  const authorId = stableAuthorId(author.stableId);
  const subscriptionId = stableAuthorId(subscription.stableId);
  if (authorId && subscriptionId) return authorId === subscriptionId;
  const name = authorName(subscription.name);
  return Boolean(subscription.confirmedNameOnly === true && name && name === authorName(author.name));
}

function observedInterval(positive, negative) {
  const n = positive + negative;
  if (n < 3) return {estimate: null, interval: null};
  const z = 1.95996398454;
  const share = positive / n;
  const denominator = 1 + z * z / n;
  const center = (share + z * z / (2 * n)) / denominator;
  const radius = z * Math.sqrt(share * (1 - share) / n + z * z / (4 * n * n)) / denominator;
  return {estimate: share, interval: [Math.max(0, center - radius), Math.min(1, center + radius)]};
}

function countedTerms(counts) {
  return [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([term, count]) => ({term, count}));
}

function glossaryCounts(glossary, start, end) {
  const terms = new Map();
  const names = new Map();
  for (const item of Object.values(glossary || {})) {
    if (!item?.term || typeof item.term !== 'string') continue;
    const key = item.term.normalize('NFKC').trim().toLowerCase();
    if (!key) continue;
    let count;
    if (!start && !end) {
      count = Math.max(0, Number(item.visits) || 0, item.visitHistory?.length || 0);
    } else if (Array.isArray(item.visitHistory)) {
      count = item.visitHistory.filter(value => inRange(dayOf(value), start, end)).length;
    } else {
      count = Number(item.visits > 0 && inRange(dayOf(item.lastVisitedAt || item.updatedAt), start, end));
    }
    if (count > 0) {
      bump(terms, key, count);
      if (!names.has(key)) names.set(key, item.term.trim());
    }
  }
  return countedTerms(terms).map(row => ({term: names.get(row.term), count: row.count}));
}

function knowledgeRows(profile, start, end) {
  const rows = [];
  for (const [term, item] of Object.entries(profile || {})) {
    if (!item?.level) continue;
    const changes = [...(Array.isArray(item.history) ? item.history : [])];
    if (!changes.some(change => change?.level === item.level && change.updatedAt === item.updatedAt)) {
      changes.push({level: item.level, updatedAt: item.updatedAt});
    }
    const history = changes.filter(change => change?.level && inRange(dayOf(change.updatedAt), start, end))
      .sort((a, b) => epoch(a.updatedAt) - epoch(b.updatedAt));
    if (history.length) rows.push({term, ...history.at(-1), history});
  }
  return rows.sort((a, b) => compareText(a.term, b.term));
}

function analytics(state, {start: from = '', end: to = '', now = Date.now(), model: suppliedModel} = {}) {
  const start = isoDay(from);
  const end = isoDay(to);
  const {latest, active, excluded} = activeFeedback(state.events, state.settings, now);
  const within = timestamp => inRange(dayOf(timestamp), start, end);
  const model = suppliedModel || trainModel(state.events, state.settings, now);
  const papers = new Map(Object.entries(state.papers || {}));
  for (const event of latest) if (!papers.has(event.paperId) && event.paper) papers.set(event.paperId, event.paper);
  const categories = new Map(Object.entries(CATEGORIES).map(([code, name]) =>
    [code, {code, name, reviewed: 0, positive: 0, negative: 0, background: 0, predictionTotal: 0,
      predictionSamples: 0, activeSamples: 0}]));
  const reviewed = new Set();
  const months = new Map();
  const liked = new Map();
  const totals = {positive: 0, negative: 0, background: 0};

  function record(id, paper, timestamp, signal) {
    const month = dayOf(timestamp).slice(0, 7);
    if (!months.has(month)) months.set(month, {period: month, positive: 0, negative: 0, background: 0,
      ids: new Set(), categories: {}});
    const row = months.get(month);
    const codes = paperCategories(paper);
    if (signal) {
      totals[signal]++;
      row[signal]++;
    }
    for (const code of codes) {
      const category = categories.get(code);
      if (!reviewed.has(id)) category.reviewed++;
      if (!Object.hasOwn(row.categories, code)) row.categories[code] = {reviewed: 0, positive: 0, negative: 0, background: 0};
      if (!row.ids.has(id)) row.categories[code].reviewed++;
      if (signal) {
        category[signal]++;
        row.categories[code][signal]++;
      }
    }
    reviewed.add(id);
    row.ids.add(id);
  }

  for (const event of latest) {
    if (!within(event.timestamp) || !['like', 'dislike', 'neutral', 'background'].includes(event.value)) continue;
    const paper = event.paper || papers.get(event.paperId);
    const signal = {like: 'positive', dislike: 'negative', background: 'background'}[event.value];
    record(event.paperId, paper, event.timestamp, signal);
    if (event.value === 'like') for (const term of conceptTerms(paper)) bump(liked, term, 1);
  }
  for (const event of active) {
    if (within(event.timestamp)) for (const code of paperCategories(event.paper)) categories.get(code).activeSamples++;
  }
  const readingHistory = [];
  for (const [paperId, timestamp] of Object.entries(state.reading || {})) {
    if (!within(timestamp)) continue;
    const paper = papers.get(paperId) || null;
    readingHistory.push({paperId, timestamp, paper});
    record(paperId, paper, timestamp);
  }
  readingHistory.sort((a, b) => epoch(b.timestamp) - epoch(a.timestamp) || compareText(a.paperId, b.paperId));
  const datedPapers = [...papers.values()].filter(p => inRange(isoDay(p?.announcementDate), start, end));
  if (model.sampleCount >= 3 && model.positiveCount && model.negativeCount) {
    for (const paper of datedPapers) {
      const estimate = predict(model, paper);
      for (const code of paperCategories(paper)) {
        const row = categories.get(code);
        row.predictionTotal += estimate;
        row.predictionSamples++;
      }
    }
  }
  const followedResearchers = (state.subscriptions || []).map(subscription => {
    const recent = datedPapers.filter(paper => paper.authors?.some(author => subscriptionMatches(author, subscription)))
      .sort((a, b) => compareText(b.announcementDate, a.announcementDate) || compareText(a.id, b.id));
    return {...subscription, recent, unread: recent.filter(paper => !Object.hasOwn(state.reading || {}, paper.id))};
  });
  return {
    activeCount: active.filter(event => within(event.timestamp)).length,
    excludedCount: excluded.filter(event => within(event.timestamp)).length,
    modelSamples: model.sampleCount,
    reviewedCount: reviewed.size,
    positiveCount: totals.positive,
    negativeCount: totals.negative,
    backgroundCount: totals.background,
    categories: [...categories.values()].map(({predictionTotal, ...row}) => ({...row,
      ...observedInterval(row.positive, row.negative),
      prediction: row.predictionSamples ? predictionTotal / row.predictionSamples : null})),
    likedConcepts: countedTerms(liked),
    unfamiliarTerms: glossaryCounts(state.glossary, start, end),
    timeline: [...months.values()].sort((a, b) => compareText(a.period, b.period))
      .map(({ids, ...row}) => ({...row, reviewed: ids.size})),
    followedResearchers,
    readingHistory,
    knowledge: knowledgeRows(state.knowledge, start, end),
  };
}

return {paperCategories,paperFeatures,conceptTerms,activeFeedback,trainModel,predict,interestEvidence,authorIdentity,subscriptionMatches,analytics};
},
"src/categories.js": (__require) => {
// Mathematics-facing codes for the cross-archive equivalents in arXiv's taxonomy.
const CATEGORIES = Object.freeze({
  'math.AC': 'Commutative Algebra',
  'math.AG': 'Algebraic Geometry',
  'math.AP': 'Analysis of PDEs',
  'math.AT': 'Algebraic Topology',
  'math.CA': 'Classical Analysis and ODEs',
  'math.CO': 'Combinatorics',
  'math.CT': 'Category Theory',
  'math.CV': 'Complex Variables',
  'math.DG': 'Differential Geometry',
  'math.DS': 'Dynamical Systems',
  'math.FA': 'Functional Analysis',
  'math.GM': 'General Mathematics',
  'math.GN': 'General Topology',
  'math.GR': 'Group Theory',
  'math.GT': 'Geometric Topology',
  'math.HO': 'History and Overview',
  'math.IT': 'Information Theory',
  'math.KT': 'K-Theory and Homology',
  'math.LO': 'Logic',
  'math.MG': 'Metric Geometry',
  'math.MP': 'Mathematical Physics',
  'math.NA': 'Numerical Analysis',
  'math.NT': 'Number Theory',
  'math.OA': 'Operator Algebras',
  'math.OC': 'Optimization and Control',
  'math.PR': 'Probability',
  'math.QA': 'Quantum Algebra',
  'math.RA': 'Rings and Algebras',
  'math.RT': 'Representation Theory',
  'math.SG': 'Symplectic Geometry',
  'math.SP': 'Spectral Theory',
  'math.ST': 'Statistics Theory',
});

const aliases = new Map([
  ['math-ph', 'math.MP'], ['cs.it', 'math.IT'],
  ['cs.na', 'math.NA'], ['stat.th', 'math.ST'],
]);
const archives = new Set((
  'acc-phys adap-org alg-geom ao-sci astro-ph atom-ph bayes-an chao-dyn chem-ph clus-dyn ' +
  'cmp-lg comp-gas cond-mat cs dg-ga econ eess funct-an gr-qc hep-ex hep-lat hep-ph hep-th ' +
  'math math-ph mtrl-th nlin nucl-ex nucl-th patt-sol physics plasm-ph q-alg q-bio q-fin ' +
  'quant-ph solv-int stat supr-con'
).split(' '));

function normalizeCategory(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  if (aliases.has(code)) return aliases.get(code);
  const match = /^([a-z]+(?:-[a-z]+)?)(?:\.([a-z]+(?:-[a-z]+)*))?$/.exec(code);
  if (!match || !archives.has(match[1])) return null;
  const [, archive, subject] = match;
  if (!subject) return archive;
  const suffix = archive === 'physics' || archive === 'cond-mat' ? subject : subject.toUpperCase();
  return archive + '.' + suffix;
}

return {CATEGORIES,normalizeCategory};
},
"src/schema.js": (__require) => {
// Only the fields defined here cross a backup or storage trust boundary.
const {normalizeCategory, CATEGORIES} = __require("src/categories.js");
const {listingCounts, listingUrl} = __require("src/parser.js");

const SCHEMA_VERSION = 1;
const COLLECTIONS = ['events', 'papers', 'bookmarks', 'reading', 'subscriptions', 'knowledge', 'glossary', 'selections', 'explanations'];
const DEFAULT_SETTINGS = {
  mode: 'random', includeCross: false, includeReplacements: false, exploration: 0.25,
  personalizedCount: 32, trainRandom: true, useSubscriptions: false,
  history: {mode: 'all', days: 30, start: '', end: ''}, resetAt: null, noSpoilers: true,
  paperSpoilers: {}, theme: 'auto', showTools: true,
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

function recordKey(value) {
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

function checkedPaper(value, key = value?.id) {
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

function mergedSettings(raw = {}, portable = false) {
  const s = {...DEFAULT_SETTINGS, ...obj(raw, 'settings')};
  const h = {...DEFAULT_SETTINGS.history, ...obj(s.history, 'history settings')};
  const a = {...DEFAULT_SETTINGS.ai, ...obj(s.ai, 'AI settings')};
  const result = {
    mode: choice(s.mode, MODES, 'recommendation mode'), exploration: number(s.exploration, 'exploration', 0, 1),
    personalizedCount: number(s.personalizedCount, 'daily count', 1, 32, true),
    theme: choice(s.theme, ['auto', 'light', 'dark'], 'theme'),
    history: {mode: choice(h.mode, ['all', 'none', 'lastDays', 'ignoreLastDays', 'before', 'after', 'excludeRange'], 'history mode'),
      days: number(h.days, 'training window days', 1, 36500, true), start: h.start === '' ? '' : date(h.start), end: h.end === '' ? '' : date(h.end)},
    resetAt: optional(s.resetAt, timestamp),
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
  result.ai = {url: bridge.origin, provider: choice(a.provider, ['local', 'openai'], 'AI provider'), model, token,
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
    reason: str(e.reason ?? '', 'feedback reason', 8000), mode: choice(e.mode, MODES, 'feedback mode'),
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
    const maximum = mode === 'subscriptions' ? MAX_RECORDS : mode === 'original' ? 0 : 32;
    return {mode, date: day, seed: str(v.seed, 'selection seed', 1024),
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
  }
  const result = {original: read(r.original), current: read(r.current),
    revisions: list(r.revisions, 'selection revisions').map(read), createdAt: timestamp(r.createdAt)};
  if (r.paperSnapshots !== undefined) result.paperSnapshots = recordMap(r.paperSnapshots, 'daily paper snapshots', checkedPaper);
  return result;
}

function checkedRecord(kind, key, value) {
  recordKey(key);
  switch (kind) {
    case 'papers': return checkedPaper(value, key);
    case 'bookmarks': case 'reading': pid(key); return timestamp(value);
    case 'events': return feedback(value, key);
    case 'subscriptions': return subscription(value, key);
    case 'knowledge': return knowledge(value);
    case 'glossary': return glossary(value, key);
    case 'explanations': return explanation(value, key);
    case 'selections': return selection(value, key);
    default: throw new Error('Unknown data collection.');
  }
}

function checkRevisionGraph(events, allowMissing = false) {
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

function emptyState() {
  return {settings: mergedSettings(), events: [], papers: {}, bookmarks: {}, reading: {},
    subscriptions: [], knowledge: {}, glossary: {}, selections: {}, explanations: {}};
}

function validateImport(data) {
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

function publicListingKey(key) {
  const match = typeof key === 'string' && /^listing:(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
  check(match && listingUrl(match[1], match[1]), 'public listing key');
  const canonical = new URL(listingUrl(match[1], match[1]));
  return 'listing:' + canonical.origin + canonical.pathname + ':' + date(match[2]);
}

function checkedPublicListing(value, key) {
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

return {SCHEMA_VERSION,COLLECTIONS,DEFAULT_SETTINGS,recordKey,checkedPaper,mergedSettings,checkedRecord,checkRevisionGraph,emptyState,validateImport,publicListingKey,checkedPublicListing};
},
"src/parser.js": (__require) => {
const { normalizeCategory } = __require("src/categories.js");

const LISTS = 'dl[id="articles"], dl.articles';
const SECTIONS = ['new', 'cross', 'replacement'];
const MONTHS = 'january february march april may june july august september october november december'.split(' ');
const ORIGIN = 'https://arxiv.org';
const DEFAULT_LIST = ORIGIN + '/list/math/new';

function webUrl(raw, base) {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw, base);
    return /^(?:http|https):$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function arxivUrl(raw, base) {
  const url = webUrl(raw, base);
  if (!url || !/^(?:www\.)?arxiv\.org$/.test(url.hostname) || url.port) return null;
  url.protocol = 'https:';
  url.hostname = 'arxiv.org';
  return url;
}

// Ignore a fetched document's <base>. Only follow the same arXiv daily listing.
function listingUrl(raw, base = DEFAULT_LIST) {
  const url = arxivUrl(raw, base);
  const current = arxivUrl(base, DEFAULT_LIST);
  if (!url || !current || !/^\/list\/[a-z][a-z.-]*\/new\/?$/i.test(url.pathname)) return null;
  if (url.pathname.replace(/\/$/, '') !== current.pathname.replace(/\/$/, '')) return null;
  for (const [key, value] of url.searchParams) {
    if (!['skip', 'show'].includes(key) || url.searchParams.getAll(key).length !== 1) return null;
    if (!/^\d{1,9}$/.test(value) || (key === 'show' && Number(value) === 0)) return null;
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.searchParams.sort();
  url.hash = '';
  return url.href;
}

function paperId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^arXiv:\s*/i, '');
  const match = /^((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3}))(?:v([1-9]\d{0,6}))?$/i.exec(value);
  if (!match) return null;
  // Pre-2007 subject-class suffixes are optional in the printed identifier.
  const id = match[1].replace(/\.[a-z]{2}(?=\/)/i, '').toLowerCase();
  const version = Number(match[2] || 0);
  return { id, version, versionedId: version ? id + 'v' + version : id };
}

function paperRoute(raw, base) {
  const url = arxivUrl(raw, base);
  if (!url) return null;
  const match = /^\/(abs|pdf|html)\/(.+?)\/?$/.exec(url.pathname);
  if (!match) return null;
  const [, format, path] = match;
  const token = format === 'pdf' ? path.replace(/\.pdf$/i, '') : path.replace(/\/index\.html$/i, '');
  const identity = paperId(token);
  return identity && { ...identity, format, url: ORIGIN + '/' + format + '/' + identity.versionedId };
}

function orcidId(raw) {
  if (!raw) return null;
  const match = /^(?:https?:\/\/(?:www\.)?orcid\.org\/|orcid:\s*)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?$/i.exec(raw.trim());
  if (!match) return null;
  const code = match[1].toUpperCase();
  const digits = code.replace(/-/g, '');
  let sum = 0;
  for (const digit of digits.slice(0, -1)) sum = 2 * (sum + Number(digit));
  const check = (12 - (sum % 11)) % 11;
  return digits.at(-1) === (check === 10 ? 'X' : String(check)) ? 'orcid:' + code : null;
}

function authorIdentity(anchor, base) {
  const href = anchor.getAttribute('href');
  const url = webUrl(href, base);
  let stableId = orcidId(anchor.getAttribute('data-orcid'));
  let authorUrl = null;
  if (url && /^(?:www\.)?orcid\.org$/.test(url.hostname) && !url.port) {
    const orcid = orcidId('https://orcid.org' + url.pathname);
    if (orcid) {
      stableId = orcid;
      authorUrl = 'https://orcid.org/' + orcid.slice(6);
    }
  }
  const arxiv = arxivUrl(href, base);
  if (arxiv) {
    const profile = /^\/a\/([a-z0-9_-]+_\d+)(?:\.html)?\/?$/i.exec(arxiv.pathname);
    if (profile) stableId ||= 'arxiv:' + profile[1].toLowerCase();
    if (/^\/search(?:\/|$)/.test(arxiv.pathname)) {
      if (arxiv.searchParams.get('searchtype') === 'orcid') {
        stableId ||= orcidId(arxiv.searchParams.get('query'));
      }
      authorUrl = arxiv.href;
    } else if (profile) {
      authorUrl = arxiv.href;
    }
  }
  return { url: authorUrl, stableId };
}

function readAuthors(container, base) {
  if (!container) return [];
  const authors = [];
  let precedingAuthor = null;
  for (const anchor of container.querySelectorAll('a')) {
    const name = readField(anchor, base).text;
    const identity = authorIdentity(anchor, base);
    const badge = !name || /^(?:ORCID(?: iD)?|arXiv ID|ID|icon)$/i.test(name) || orcidId(name);
    if (badge) {
      // An identifier icon is often the immediate sibling of the person's name.
      if (precedingAuthor && identity.stableId && precedingAuthor.anchor.nextElementSibling === anchor) {
        precedingAuthor.record.stableId ||= identity.stableId;
      }
      continue;
    }
    const record = { name, ...identity };
    authors.push(record);
    precedingAuthor = { anchor, record };
  }
  return authors;
}

function readField(root, base) {
  let text = '';
  let pendingSpace = false;
  const links = [];
  function append(value) {
    const normalized = value.replace(/[ \n\r\t\f]+/g, ' ');
    if (!normalized) return;
    const core = normalized.replace(/^ | $/g, '');
    if (core) {
      if (text && !text.endsWith('\n') && (pendingSpace || normalized.startsWith(' '))) text += ' ';
      text += core;
    }
    pendingSpace = normalized.endsWith(' ');
  }
  function lineBreak() {
    pendingSpace = false;
    if (text && !text.endsWith('\n')) text += '\n';
  }
  function mathText(node) {
    const annotation = node.querySelector('annotation[encoding*="tex" i]');
    const tex = node.getAttribute('alttext') || annotation?.textContent;
    if (tex) {
      const block = node.getAttribute('display') === 'block';
      append(block ? '\\[' + tex + '\\]' : '\\(' + tex + '\\)');
    } else {
      append(node.getAttribute('aria-label') || node.querySelector('semantics > :first-child')?.textContent || node.textContent);
    }
  }
  function walk(node) {
    if (node.nodeType === 3) { append(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    if (node.matches('script[type^="math/tex" i]')) {
      const display = /mode\s*=\s*display/i.test(node.type);
      append(display ? '\\[' + node.textContent + '\\]' : '\\(' + node.textContent + '\\)');
      return;
    }
    // Class selectors become ASCII case-insensitive in quirks-mode fragments.
    // arXiv's ordinary .mathjax source must not be mistaken for generated .MathJax.
    if (node.matches('script,style,template,noscript,iframe,object,embed,svg,canvas,.descriptor,.ltx_title_abstract,[hidden]') ||
        ['MathJax_Preview','MathJax','MathJax_Display','MathJax_CHTML','MathJax_SVG','MJX_Assistive_MathML'].some(name => node.classList.contains(name))) return;
    if (node.matches('mjx-container')) {
      const source = node.querySelector('math');
      if (source) mathText(source);
      else if (node.getAttribute('aria-label')) append(node.getAttribute('aria-label'));
      return;
    }
    if (node.localName === 'math') { mathText(node); return; }
    if (node.localName === 'br') { lineBreak(); return; }
    const block = node !== root && node.matches('p,div.ltx_para');
    if (block) lineBreak();
    const start = text.length;
    for (const child of node.childNodes) walk(child);
    if (node.localName === 'a' && text.length > start) {
      const url = webUrl(node.getAttribute('href'), base);
      const offset = text.slice(start).search(/\S/);
      if (url && offset >= 0) links.push({ start: start + offset, end: text.length, url: url.href });
    }
    if (block) lineBreak();
  }
  if (root) walk(root);
  return { text: text.trimEnd(), links };
}

function readSubjects(node) {
  const categories = [];
  function extract(raw) {
    const tokens = [...raw.matchAll(/\(([\w.-]+)\)/g)].map(match => match[1]);
    if (!tokens.length) tokens.push(...raw.trim().split(/[;,\s]+/));
    return tokens.map(normalizeCategory).filter(Boolean);
  }
  const primary = extract(node?.querySelector('.primary-subject, .primary-subjects')?.textContent || '')[0];
  if (primary) categories.push(primary);
  for (const code of extract(node?.textContent || '')) if (!categories.includes(code)) categories.push(code);
  return { categories, primaryCategory: primary || categories[0] || null };
}

function readFields(paper, nodes, base) {
  for (const [field, node] of Object.entries(nodes)) {
    const { text, links } = readField(node, base);
    paper[field] = text;
    if (links.length) {
      paper.inlineLinks ||= {};
      paper.inlineLinks[field] = links;
    }
  }
}

function formats(abstractRoute, candidates, fallbackVersion = 0) {
  let html = null;
  let pdf = null;
  let version = abstractRoute.version;
  // A version-specific abstract always wins. Ignore a mismatched full-text version.
  for (const route of candidates) {
    if (!route || route.id !== abstractRoute.id || (version && route.version && route.version !== version)) continue;
    if (route.format === 'html') html ||= route;
    if (route.format === 'pdf') pdf ||= route;
    version ||= route.version;
  }
  version ||= fallbackVersion;
  const id = abstractRoute.id;
  const versionedId = version ? id + 'v' + version : id;
  return {
    id, version, versionedId,
    links: {
      abstract: ORIGIN + '/abs/' + abstractRoute.versionedId,
      pdf: pdf?.url || ORIGIN + '/pdf/' + versionedId,
      html: html?.url || null,
    },
  };
}

function rowIdentity(dt, base) {
  const anchor = dt.querySelector('a[title="Abstract" i], a[href^="/abs/"]');
  const route = paperRoute(anchor?.getAttribute('href'), base);
  return route?.format === 'abs' ? route : null;
}

function parseRow(dt, dd, route, section, date, base) {
  const candidates = [...dt.querySelectorAll('a[href]')].map(a => paperRoute(a.getAttribute('href'), base));
  const paper = {
    ...formats(route, candidates, section === 'new' ? 1 : 0),
    authors: readAuthors(dd.querySelector('.list-authors'), base),
    ...readSubjects(dd.querySelector('.list-subjects')),
    announcementDate: date, section,
  };
  readFields(paper, {
    title: dd.querySelector('.list-title'),
    abstract: dd.querySelector('p.mathjax, .list-abstract'),
    comments: dd.querySelector('.list-comments'),
    journalRef: dd.querySelector('.list-journal-ref, .list-jref'),
  }, base);
  return paper;
}

function parseDateHeading(value) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const heading = normalized.replace(/^(?:(?:showing\s+)?(?:new\s+)?(?:listings?|submissions?|announcements?)\s+(?:for|on)\s+|(?:cross|replacement)\s+submissions?\s+for\s+)/i, '')
    .replace(/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s+/i, '')
    .replace(/\s+\((?:showing|total)\b.*$/i, '');
  let year, month, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(heading);
  const dmy = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(heading);
  const mdy = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(heading);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (dmy || mdy) {
    const parts = dmy || mdy;
    year = Number(parts[3]);
    day = Number(parts[dmy ? 1 : 2]);
    const spelled = parts[dmy ? 2 : 1].toLowerCase();
    month = MONTHS.findIndex(name => name === spelled || name.slice(0, 3) === spelled ||
      (name === 'september' && spelled === 'sept')) + 1;
  } else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1991 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function sectionHeading(text) {
  if (/^new\s+(?:submissions?|articles?|papers?)\b/i.test(text)) return 'new';
  if (/^cross[- ]?(?:submissions?|list(?:ed|ings?|s)?)\b/i.test(text)) return 'cross';
  if (/^replacements?\b/i.test(text)) return 'replacement';
  return null;
}

function countClaim(text) {
  const match = /\bshowing\s+(?:items\s+)?([\d,]+)(?:\s*[-–—]\s*([\d,]+))?\s+(?:of|out of)\s+([\d,]+)\s+(?:entr(?:y|ies)|items?|articles?)/i.exec(text);
  if (!match) return null;
  const first = Number(match[1].replace(/,/g, ''));
  const shown = match[2] ? Number(match[2].replace(/,/g, '')) - first + 1 : first;
  return { shown, total: Number(match[3].replace(/,/g, '')) };
}

function navigation(page, base) {
  const links = new Map();
  for (const anchor of page.querySelectorAll('.paging a[href], .morefewer a[href], .pagination a[href], a[rel~="next"], a[rel~="prev"]')) {
    const label = anchor.textContent.trim().toLowerCase();
    const url = listingUrl(anchor.getAttribute('href'), base);
    if (!url || /^(?:fewer|less)$/.test(label) || url === listingUrl(base, base)) continue;
    const rank = label === 'all' ? 0 : label === 'more' ? 1 : 2;
    if (!links.has(url) || links.get(url) > rank) links.set(url, rank);
  }
  return [...links].sort((a, b) => a[1] - b[1]).map(([url]) => url);
}

function listingCounts(papers) {
  const counts = { new: 0, cross: 0, replacement: 0, total: papers.length };
  for (const paper of papers) if (SECTIONS.includes(paper.section)) counts[paper.section]++;
  return counts;
}

function parseListing(doc, baseUrl = doc.URL || DEFAULT_LIST) {
  const page = doc.querySelector('#dlpage') || doc;
  const sourceUrl = arxivUrl(baseUrl, DEFAULT_LIST);
  const base = sourceUrl ? sourceUrl.href : DEFAULT_LIST;
  const sectionsByList = new WeakMap();
  const sectionTotals = {};
  const integrity = new Set();
  const records = new Map();
  const claims = [];
  let externalSection = null;
  let date = null;
  let currentDate = null;
  let brokenPairs = 0;
  let unclassified = 0;
  let malformed = 0;
  let duplicates = 0;
  let missingSubjects = 0;
  for (const node of page.querySelectorAll('h2,h3,h4,dt,dd')) {
    const list = node.closest(LISTS);
    if (/^H[234]$/.test(node.tagName)) {
      if (node.closest('dt,dd')) continue;
      const label = node.textContent.trim();
      const announced = parseDateHeading(label);
      if (announced) {
        currentDate = announced;
        date ||= announced;
        if (currentDate !== date) integrity.add('This page contains multiple announcement dates. Only the first publication cycle was read.');
      }
      if (currentDate !== date) continue;
      const section = sectionHeading(label);
      const claim = section ? { section, ...countClaim(label), rows: 0 } : null;
      if (claim) {
        claims.push(claim);
        if (Number.isFinite(claim.total)) {
          if (section in sectionTotals && sectionTotals[section] !== claim.total) {
            integrity.add('The listing contains conflicting totals for ' + section + ' submissions.');
          }
          sectionTotals[section] = claim.total;
        }
      }
      if (list) sectionsByList.set(list, claim);
      else externalSection = claim;
      continue;
    }
    if (!list || node.parentElement !== list || currentDate !== date) continue;
    if (node.localName === 'dd') {
      if (node.previousElementSibling?.localName !== 'dt') brokenPairs++;
      continue;
    }
    const claim = sectionsByList.has(list) ? sectionsByList.get(list) : externalSection;
    if (claim) claim.rows++;
    const dd = node.nextElementSibling;
    if (dd?.localName !== 'dd') { brokenPairs++; continue; }
    if (!claim) { unclassified++; continue; }
    const identity = rowIdentity(node, base);
    if (!identity) { malformed++; continue; }
    const paper = parseRow(node, dd, identity, claim.section, currentDate, base);
    if (!paper.title) { malformed++; continue; }
    if (records.has(paper.id)) { duplicates++; continue; }
    if (!paper.categories.length) missingSubjects++;
    records.set(paper.id, paper);
  }

  if (!date) integrity.add('The listing does not identify a valid announcement date.');
  if (!page.querySelector(LISTS) && !page.querySelector('.paging')) integrity.add('No arXiv article list or pagination summary was found.');
  if (brokenPairs) integrity.add('Unpaired paper headers or descriptions: ' + brokenPairs + '.');
  if (unclassified) integrity.add('Entries without a recognized submission section: ' + unclassified + '.');
  if (malformed) integrity.add('Entries without a valid arXiv identifier and title: ' + malformed + '.');
  if (duplicates) integrity.add('Repeated paper identifiers on this page: ' + duplicates + '.');
  if (missingSubjects) integrity.add('Entries without readable subject classifications: ' + missingSubjects + '.');
  for (const claim of claims) {
    if (Number.isFinite(claim.shown) && (claim.shown !== claim.rows || claim.shown > claim.total)) {
      integrity.add('The displayed row count disagrees with the ' + claim.section + ' section heading.');
    }
  }

  const totals = new Set();
  for (const box of page.querySelectorAll('.paging, .pagination')) {
    const match = /\btotal\s+(?:of\s+)?([\d,]+)\s+(?:entr(?:y|ies)|articles?|items?)\b/i.exec(box.textContent);
    if (match) totals.add(Number(match[1].replace(/,/g, '')));
  }
  if (totals.size > 1) integrity.add('The pagination controls report conflicting entry totals.');
  const fullBreakdown = SECTIONS.every(section => section in sectionTotals);
  const sectionSum = Object.values(sectionTotals).reduce((a, b) => a + b, 0);
  const advertisedTotal = [...totals][0] ?? (fullBreakdown ? sectionSum : null);
  if (fullBreakdown && advertisedTotal !== sectionSum) integrity.add('Section totals disagree with the advertised daily total.');
  const papers = [...records.values()];
  const counts = listingCounts(papers);
  const warnings = [...integrity];
  if (advertisedTotal === null) warnings.push('The daily total could not be verified.');
  else if (counts.total !== advertisedTotal) warnings.push('This page contains ' + counts.total + ' of ' + advertisedTotal + ' announced entries.');
  for (const [section, total] of Object.entries(sectionTotals)) {
    if (counts[section] !== total) warnings.push('The ' + section + ' section contains ' + counts[section] + ' of ' + total + ' entries.');
  }
  const complete = warnings.length === 0;
  return {
    papers, counts, announcementDate: date, advertisedTotal, complete, warnings,
    nextUrls: complete ? [] : navigation(page, base), baseUrl: base,
    sectionTotals, integrityWarnings: [...integrity],
  };
}

function findPaperNodes(doc, baseUrl = doc.URL || DEFAULT_LIST) {
  const page = doc.querySelector('#dlpage') || doc;
  const base = arxivUrl(baseUrl, DEFAULT_LIST)?.href || DEFAULT_LIST;
  const result = new Map();
  for (const list of page.querySelectorAll(LISTS)) {
    for (const dt of list.querySelectorAll(':scope > dt')) {
      const identity = rowIdentity(dt, base);
      const dd = dt.nextElementSibling;
      if (identity && dd?.localName === 'dd' && !result.has(identity.id)) result.set(identity.id, { dt, dd });
    }
  }
  return result;
}

function metaValues(doc, name) {
  return [...doc.querySelectorAll('meta[name="' + name + '"]')]
    .map(meta => meta.getAttribute('content')?.trim()).filter(Boolean);
}

function parseAbstract(doc, baseUrl = doc.URL) {
  const route = paperRoute(baseUrl, ORIGIN);
  if (!route || !['abs', 'html'].includes(route.format)) return null;
  const full = route.format === 'html';
  const root = full ? doc.querySelector('.ltx_document') : (doc.querySelector('#abs') || doc);
  if (!root) return null;
  const title = root.querySelector(full ? '.ltx_title_document, h1.ltx_title' : 'h1.title');
  const abstract = root.querySelector(full ? '.ltx_abstract' : 'blockquote.abstract, .abstract.mathjax');
  if (!title && !metaValues(doc, 'citation_title').length) return null;

  const candidates = [];
  if (full) candidates.push(route);
  // Cited articles in an abstract or bibliography never establish this paper's version.
  if (!full) {
    for (const anchor of doc.querySelectorAll('.arxivid a[href], .download-pdf, .full-text a[href], .full-text-links a[href], a[href*="/html/"]')) {
      if (anchor.closest('blockquote.abstract,.comments,.jref,.submission-history')) continue;
      candidates.push(paperRoute(anchor.getAttribute('href'), baseUrl));
    }
  }
  for (const url of metaValues(doc, 'citation_pdf_url')) candidates.push(paperRoute(url, baseUrl));
  const metadataId = paperId(metaValues(doc, 'citation_arxiv_id')[0]);
  const paper = {
    ...formats(route, candidates, metadataId?.id === route.id ? metadataId.version : 0),
    authors: full ? [] : readAuthors(root.querySelector('.authors'), baseUrl),
    ...readSubjects(root.querySelector('.tablecell.subjects, td.subjects, .list-subjects')),
    announcementDate: null, section: null,
  };
  readFields(paper, {
    title, abstract, comments: root.querySelector('td.comments, .list-comments'),
    journalRef: root.querySelector('td.jref, .list-journal-ref, .list-jref'),
  }, baseUrl);
  paper.title ||= metaValues(doc, 'citation_title')[0] || '';
  paper.abstract ||= metaValues(doc, 'citation_abstract')[0] || '';
  if (!paper.authors.length) {
    paper.authors = metaValues(doc, 'citation_author').map(name => ({ name, url: null, stableId: null }));
  }
  if (full && !paper.authors.length) {
    for (const person of root.querySelectorAll('.ltx_authors .ltx_personname, .ltx_creator.ltx_role_author .ltx_personname')) {
      const name = readField(person, baseUrl).text;
      const anchor = person.querySelector('a[href]') || person;
      if (name) paper.authors.push({ name, ...authorIdentity(anchor, baseUrl) });
    }
  }
  return paper.title ? paper : null;
}

function readerTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element || element.closest('nav,form,button,input,textarea,select,[contenteditable="true"],.ltx_page_navbar')) return null;
  return element.closest(
    '#dlpage dd .list-title, #dlpage dd p.mathjax, #dlpage dd .list-abstract, ' +
    '#abs h1.title, #abs blockquote.abstract, .ltx_document'
  );
}

return {listingUrl,listingCounts,parseListing,findPaperNodes,parseAbstract,readerTarget};
},
"src/app.js": (__require) => {
const {CATEGORIES} = __require("src/categories.js");
const {parseListing,parseAbstract,findPaperNodes,readerTarget} = __require("src/parser.js");
const {loadCompleteListing} = __require("src/network.js");
const {trainModel,activeFeedback,analytics,subscriptionMatches} = __require("src/recommender.js");
const {generateSelection,replaceSelectionPaper} = __require("src/sampling.js");
const {makeId,PublicCache} = __require("src/storage.js");
const {AIClient} = __require("src/ai.js");
const {element,link,field,select,checkbox,richText,STYLES,safeURL} = __require("src/dom.js");
const {feedbackCSV,readingCSV,bookmarksBibtex,downloadText} = __require("src/exports.js");
const {gmRequest} = __require("src/transport.js");
const {mathFragment} = __require("src/math.js");

const MODES=[['random','Pure Random'],['balanced','Balanced Exploration'],['personalized','Personalized'],['discovery','Discovery'],['subscriptions','Subscriptions']];
const LEVELS=['Unfamiliar','Introduced','Developing','Comfortable','Proficient','Advanced'];
const REASONS=['','Interesting mathematical problem','Interesting mathematical technique','Interesting application','Interesting author','Uninteresting topic','Excessively technical presentation','Insufficient mathematical background'];
const isoNow=()=>new Date().toISOString();
const fmtDate=value=>value?String(value).slice(0,10):'Unknown date';
const percent=n=>Number.isFinite(n)?`${Math.round(n*100)}%`:'—';

class DiscoveryApp {
  constructor(store) {
    this.store=store;this.state=null;this.hosts=[];this.roots=[];this.cache=new PublicCache();this.currentPanel=null;
    this.listing=null;this.article=null;this.paperNodes=new Map();this.currentPaper=null;this.activeSelection=null;
    this.selectionHandler=e=>this.handleSelection(e);this.keyHandler=e=>this.handleKeys(e);
  }
  async initialize() {
    this.state=await this.store.initialize();
    this.listing=document.querySelector('#dlpage')?parseListing(document,location.href):null;
    this.article=this.listing?null:parseAbstract(document,location.href);
    this.paperNodes=findPaperNodes(document,location.href);
    const papers=this.listing?.papers||[this.article].filter(Boolean);
    for(const paper of papers) {
      // Standalone metadata must not overwrite the known announcement cycle.
      const previous=this.state.papers[paper.id];
      if(previous&&!paper.announcementDate) paper.announcementDate=previous.announcementDate;
      if(previous&&!paper.section) paper.section=previous.section;
      this.state.papers[paper.id]={...previous,...paper};
    }
    try{await this.store.cachePapers(papers.map(p=>this.state.papers[p.id]));}
    catch{this.state.storageWarnings=[...(this.state.storageWarnings||[]),'Some public paper metadata could not be cached. The original page is unchanged; saving an unusually large or malformed record may fail.'];}
    this.retrain();
    this.ai=new AIClient({request:gmRequest,getSettings:()=>this.state.settings,getKnowledge:()=>this.state.knowledge,getGeneration:()=>this.store.generation(),
      cacheGet:key=>this.store.get('explanations',key),
      cacheSet:async(key,value,generation)=>{if(!await this.store.setIfGeneration('explanations',key,value,generation))throw new Error('Personal data changed during generation; the answer was not saved.');this.state.explanations[key]=value;}});
    this.store.subscribe(()=>this.refreshExternal());
    if(typeof GM_registerMenuCommand==='function') {
      GM_registerMenuCommand('Show arXiv Discovery',()=>this.show().catch(e=>console.error(e)));
      GM_registerMenuCommand('Pair local AI bridge',()=>this.pairBridge().catch(e=>console.error(e)));
    }
    if(this.state.settings.mode!=='original') await this.mount();
  }
  retrain() {this.model=trainModel(this.state.events,this.state.settings);}
  async reload() {
    this.state=await this.store.load();
    // Current-page public metadata stays usable after erasure, without silently
    // recreating a deleted persistent collection. A later explicit save records it.
    for(const paper of this.listing?.papers||[this.article].filter(Boolean))if(!this.state.papers[paper.id])this.state.papers[paper.id]=paper;
    this.retrain();this.updateStatus();
    for(const root of this.roots)for(const row of root.querySelectorAll('.actions[data-paper-id]')){const paper=this.state.papers[row.dataset.paperId];if(paper)row.replaceWith(this.paperActions(paper,row._entry));else row.remove();}
  }
  async rememberPaper(paper) {await this.store.cachePapers([paper]);this.state.papers[paper.id]=paper;}
  async refreshExternal() {
    this.closePanel();this.activeSelection=null;await this.reload();
    if(this.toolbar)this.notify('Changes from another arXiv tab have been loaded. Reopen a panel to view current data.');
  }
  rootHost(id,parent,before=null) {
    const host=element('div',{id,'data-arxiv-discovery':'true','data-theme':this.state.settings.theme});
    const root=host.attachShadow({mode:'closed'});root.append(element('style',{},STYLES));
    parent.insertBefore(host,before);this.hosts.push(host);this.roots.push(root);
    root.addEventListener('mouseup',e=>this.handleSelection(e));return {host,root};
  }
  async mount() {
    if(this.toolbar) return;
    const target=document.querySelector('#dlpage')||document.querySelector('#content-inner')||document.querySelector('main')||document.body;
    const after=target.querySelector('h1');
    const {host,root}=this.rootHost('arxiv-discovery-toolbar',target,after?.parentNode===target?after.nextSibling:target.firstChild);
    this.toolbar=host;this.root=root;
    this.status=element('div',{class:'status',role:'status','aria-live':'polite'});
    const bar=element('nav',{class:'toolbar','aria-label':'arXiv Discovery'},element('span',{class:'brand'},'arXiv Discovery'),
      this.button('Daily selection',()=>this.openDaily()),this.button('Bookmarks',()=>this.openBookmarks()),
      this.button('Authors',()=>this.openAuthors()),this.button('Interests',()=>this.openInterests()),
      this.button('Knowledge',()=>this.openKnowledge()),this.button('Settings',()=>this.openSettings()),
      this.button('Original arXiv',()=>this.hide()),this.status);
    root.append(bar);
    if(this.state.settings.showTools) this.attachPaperTools();
    document.addEventListener('mouseup',this.selectionHandler);
    document.addEventListener('keydown',this.keyHandler);
    this.updateStatus();
  }
  async show() {if(this.state.settings.mode==='original'){this.state.settings=await this.store.settings({mode:this.state.settings.previousMode||'random'});}await this.mount();}
  async hide() {
    this.state.settings=await this.store.settings({previousMode:this.state.settings.mode,mode:'original'});
    this.closePanel();for(const host of this.hosts) host.remove();this.hosts=[];this.roots=[];this.toolbar=null;
    document.removeEventListener('mouseup',this.selectionHandler);document.removeEventListener('keydown',this.keyHandler);
    // The Tampermonkey menu restores the add-on without leaving any controls in arXiv's interface.
  }
  updateStatus(message='') {
    if(!this.status) return;
    const f=activeFeedback(this.state.events,this.state.settings);
    this.status.textContent=message||`${this.listing?.announcementDate?`Publication: ${this.listing.announcementDate} · `:''}${this.listing?`${this.listing.papers.length} papers ${this.listing.complete?'loaded':'in a partial listing'} · `:''}${f.active.length} active / ${f.excluded.length} excluded interest examples · Local-first; AI runs only on request.`;
    for(const host of this.hosts) host.setAttribute('data-theme',this.state.settings.theme);
  }
  notify(text) {this.updateStatus(text);if(this.panelNotice){this.panelNotice.textContent=text;this.panelNotice.hidden=false;}}
  button(text,callback,attrs={}) {
    return element('button',{type:'button',...attrs,onclick:async e=>{if(!e.isTrusted)return;const b=e.currentTarget;b.disabled=true;try{await callback(e);}catch(error){this.notify(error.message||String(error));}finally{if(b.isConnected)b.disabled=false;}}},text);
  }
  closePanel() {this.currentPanel=null;this.progress=null;this.selectionBubble?.remove();this.selectionBubble=null;if(this.dialog){if(this.dialog.open)this.dialog.close();this.dialog.remove();this.dialog=null;this.body=null;this.panelNotice=null;}}
  panel(title,name) {
    this.closePanel();this.currentPanel=name;
    const dialog=element('dialog',{'aria-label':title});
    const close=this.button('Close',()=>this.closePanel(),{'aria-label':`Close ${title}`});
    const body=element('div',{class:'dialog-body'});this.panelNotice=element('p',{role:'status','aria-live':'polite',class:'notice',hidden:true});
    body.append(this.panelNotice);dialog.append(element('header',{class:'dialog-header'},element('h2',{},title),close),body);
    this.root.append(dialog);this.dialog=dialog;this.body=body;
    dialog.addEventListener('cancel',()=>{this.currentPanel=null;});
    dialog.showModal();return body;
  }
  attachPaperTools() {
    for(const [id,nodes] of this.paperNodes) {
      if(!this.state.papers[id]||nodes.dd.querySelector('[data-arxiv-discovery]')) continue;
      const {root}=this.rootHost(`ad-paper-${id.replace(/[^\w-]/g,'-')}`,nodes.dd);
      const detail=element('details',{class:'tools'},element('summary',{},'Discovery tools'));
      detail.addEventListener('toggle',()=>{if(detail.open&&detail.childElementCount===1){const p=this.state.papers[id];detail.append(this.paperActions(p),this.authorControls(p),this.paperProtection(p));}});
      root.append(detail);
    }
    if(this.article&&!this.paperNodes.size) {
      const container=document.querySelector('blockquote.abstract')||document.querySelector('article')||document.querySelector('h1.title');
      if(container){const {root}=this.rootHost('ad-article-tools',container.parentNode,container.nextSibling);root.append(this.paperActions(this.article),this.authorControls(this.article),this.paperProtection(this.article));}
    }
  }
  currentFeedback(paper) {return activeFeedback(this.state.events,this.state.settings).latest.find(e=>e.paperId===paper.id);}
  paperActions(paper,entry=null) {
    const row=element('div',{class:'actions','data-paper-id':paper.id});
    const latest=this.currentFeedback(paper);
    const reason=select(REASONS.map(r=>[r,r||'Optional feedback reason']),latest?.reason||'');reason.className='feedback-reason';reason.setAttribute('aria-label','Feedback reason');
    const rate=async value=>{
      if(reason.value==='Insufficient mathematical background') value='background';
      const e=await this.store.feedback(paper,value,reason.value,this.state.settings.mode,entry?.probability??null);
      this.state.events.push(e);this.retrain();this.refreshActionRows(paper);this.updateStatus();
      if(this.progress) this.updateProgress();
    };
    row.append(this.button('Like',()=>rate('like'),{'aria-pressed':latest?.value==='like'}),
      this.button('Dislike',()=>rate('dislike'),{'aria-pressed':latest?.value==='dislike'}),
      this.button('Need background',()=>rate('background'),{'aria-pressed':latest?.value==='background'}),
      this.button('Skip',()=>rate('neutral')),this.button('Clear feedback',()=>rate('removed')),reason,
      this.button(this.state.bookmarks[paper.id]?'Bookmarked':'Bookmark',async()=>{
        if(this.state.bookmarks[paper.id]){await this.store.remove('bookmarks',paper.id);delete this.state.bookmarks[paper.id];}
        else {await this.rememberPaper(paper);this.state.bookmarks[paper.id]=isoNow();await this.store.set('bookmarks',paper.id,this.state.bookmarks[paper.id]);}
        this.refreshActionRows(paper);
      },{'aria-pressed':!!this.state.bookmarks[paper.id]}),
      this.button(this.state.reading[paper.id]?'Read':'Mark as read',async()=>{
        if(this.state.reading[paper.id]){await this.store.remove('reading',paper.id);delete this.state.reading[paper.id];}
        else {await this.rememberPaper(paper);this.state.reading[paper.id]=isoNow();await this.store.set('reading',paper.id,this.state.reading[paper.id]);}
        this.refreshActionRows(paper);this.updateProgress();
      },{'aria-pressed':!!this.state.reading[paper.id]}),this.button('AI overview',()=>this.openAI(paper)));
    row._paper=paper;row._entry=entry;
    reason.addEventListener('change',async()=>{const f=this.currentFeedback(paper);if(f&&!['removed','neutral'].includes(f.value)){try{await rate(f.value);}catch(e){this.notify(e.message);}}});
    return row;
  }
  refreshActionRows(paper) {
    for(const root of this.roots) for(const row of root.querySelectorAll('.actions[data-paper-id]')) if(row.dataset.paperId===paper.id) row.replaceWith(this.paperActions(paper,row._entry));
  }
  authorControls(paper) {
    const row=element('div',{class:'authors'},'Authors: ');
    paper.authors.forEach((author,index)=>{
      const subscribed=this.state.subscriptions.find(s=>subscriptionMatches(author,s));
      row.append(link(author.name,author.url||paper.links.abstract),' ',this.button(subscribed?'Following':'Follow',()=>this.follow(author),{'aria-label':`${subscribed?'Manage':'Follow'} ${author.name}`}));
      if(index<paper.authors.length-1) row.append(' · ');
    });return row;
  }
  async follow(author) {
    const existing=this.state.subscriptions.find(s=>subscriptionMatches(author,s));if(existing){this.openAuthors();return;}
    if(!author.stableId&&!confirm(`No stable author identifier is available for ${author.name}. A name-only subscription may include different researchers with the same name. Follow these as possible matches and verify each author's page?`)) return;
    const sub={id:makeId(),name:author.name,url:author.url||'',stableId:author.stableId||null,createdAt:isoNow(),notes:'',confirmedNameOnly:!author.stableId};
    await this.store.set('subscriptions',sub.id,sub);this.state.subscriptions.push(sub);this.notify(`Following ${author.name}${sub.stableId?'':' as a name-only match; verify identity'}.`);
  }
  noSpoilers(paper) {return this.state.settings.paperSpoilers[paper.id]??this.state.settings.noSpoilers;}
  paperProtection(paper) {
    return checkbox('No Spoilers for this paper',this.noSpoilers(paper),async e=>{
      this.state.settings=await this.store.settings({paperSpoilers:{[paper.id]:e.target.checked}});
    });
  }
  paperCard(paper,entry=null,{replace=false}={}) {
    const card=element('article',{class:'card','data-paper-id':paper.id,tabindex:'-1'});
    card.append(element('div',{class:'muted'},entry?.category?`${entry.category} · ${CATEGORIES[entry.category]}`:paper.primaryCategory||'Paper'),
      element('h3',{},link(mathFragment(document,paper.title),paper.links.abstract)),this.authorControls(paper),
      element('p',{class:'muted'},`${paper.id}${paper.version?`v${paper.version}`:''} · ${fmtDate(paper.announcementDate)} · ${paper.section||'arXiv preprint'}`),
      element('div',{},paper.categories.map(c=>element('span',{class:'pill'},c))),
      element('div',{class:'row'},link('Abstract page',paper.links.abstract),link('PDF',paper.links.pdf),paper.links.html?link('HTML',paper.links.html):element('small',{},'No HTML link supplied')));
    const details=element('details',{},element('summary',{},'Original abstract'),element('p',{class:'abstract'},richText(paper,'abstract')));card.append(details);
    if(entry?.reason) card.append(element('p',{class:'muted'},`Selected because: ${entry.reason}`));
    card.append(this.paperActions(paper,entry),this.paperProtection(paper));
    if(this.paperNodes.has(paper.id)) card.append(this.button('Jump to original entry',()=>{this.closePanel();const {dt}=this.paperNodes.get(paper.id);dt.scrollIntoView({block:'center',behavior:'instant'});dt.querySelector('a')?.focus();this.currentPaper=paper;}));
    if(replace) card.append(this.button('Replace this paper',async()=>{
      const next=replaceSelectionPaper(this.activeSelection.current,paper.id,this.listing.papers,{...this.selectionOptions(),seed:makeId()});
      if(!next){this.notify('There is no unused eligible replacement for this category.');return;}
      this.activeSelection.revisions.push(this.activeSelection.current);this.activeSelection.current=next;this.snapshotSelection(this.activeSelection);
      await this.store.set('selections',this.selectionKey(),this.activeSelection);this.state.selections[this.selectionKey()]=this.activeSelection;await this.openDaily();
    }));
    return card;
  }
  selectionKey() {const s=this.state.settings;return `${this.listing.announcementDate}|${s.mode}|${s.includeCross?'cross':'new'}|${s.includeReplacements?'replacements':'originals'}|${s.personalizedCount}`;}
  selectionOptions() {const s=this.state.settings;return {mode:s.mode,seed:makeId(),date:this.listing?.announcementDate,complete:this.listing?.complete,settings:s,model:this.model,subscriptions:this.state.subscriptions,reading:this.state.reading,knownPapers:this.state.papers};}
  snapshotSelection(record) {record.paperSnapshots=record.paperSnapshots||{};for(const e of record.current.entries) if(this.state.papers[e.paperId]) record.paperSnapshots[e.paperId]=this.state.papers[e.paperId];}
  async ensureSelection(regenerate=false) {
    const key=this.selectionKey();let record=await this.store.get('selections',key);
    if(!record||regenerate) {
      const selection=generateSelection(this.listing.papers,this.selectionOptions());
      record=record?{...record,current:selection,revisions:[...record.revisions,record.current]}:{original:selection,current:selection,revisions:[],createdAt:isoNow()};
      this.snapshotSelection(record);await this.store.set('selections',key,record);this.state.selections[key]=record;
    }
    this.activeSelection=record;return record;
  }
  updateProgress() {
    if(!this.progress||!this.activeSelection) return;
    const entries=this.activeSelection.current.entries;const latest=activeFeedback(this.state.events,{...this.state.settings,history:{mode:'all'},resetAt:null}).latest;
    const reviewed=new Set(latest.filter(e=>e.value!=='removed').map(e=>e.paperId));
    const count=entries.filter(e=>this.state.reading[e.paperId]||reviewed.has(e.paperId)).length;
    this.progress.textContent=`${count} / ${entries.length} papers reviewed. This selection ends here; no papers load automatically.`;
  }
  async openDaily() {
    const body=this.panel('Daily discovery','daily');this.progress=null;
    body.append(element('div',{class:'row'},field('Recommendation mode',select(MODES,this.state.settings.mode,async e=>{this.state.settings=await this.store.settings({mode:e.target.value});this.retrain();await this.openDaily();})),this.button('Previous selections',()=>this.openPrevious()),this.button('All papers in a category',()=>this.openCategory())));
    if(!this.listing||!this.listing.announcementDate) {
      body.append(element('p',{class:'notice'},'A daily selection needs a dated arXiv mathematics listing.'),link('Open the new mathematics listing','https://arxiv.org/list/math/new'));return;
    }
    body.append(element('p',{},`Announcement cycle: ${this.listing.announcementDate}. Eligibility: new submissions${this.state.settings.includeCross?', cross-submissions':''}${this.state.settings.includeReplacements?', replacements':''}.`));
    if(!this.listing.complete) {
      body.append(element('p',{class:'notice'},`Only ${this.listing.papers.length} of ${this.listing.advertisedTotal??'an unknown number of'} entries are loaded. Complete the listing before sampling so missing pages cannot bias the selection.`),
        this.button('Load complete publication',async()=>{
          this.notify('Loading the remaining listing pages. Requests are paced and cached.');
          const cached=await this.cache.get(`listing:${this.listing.baseUrl}:${this.listing.announcementDate}`,3600000);
          const result=cached?.complete?cached:await loadCompleteListing(this.listing,{request:gmRequest,onProgress:p=>this.notify(`Loaded ${p.papers} papers across ${p.pages} pages…`)});
          this.listing=result;await this.store.cachePapers(result.papers);for(const p of result.papers)this.state.papers[p.id]=p;
          if(result.complete)await this.cache.set(`listing:${result.baseUrl}:${result.announcementDate}`,result);
          await this.openDaily();
        }),element('ul',{},this.listing.warnings.map(w=>element('li',{},w))));return;
    }
    const record=await this.ensureSelection();if(this.currentPanel!=='daily')return;
    this.progress=element('p',{class:'notice'});body.append(this.progress);this.updateProgress();
    body.append(element('div',{class:'row'},this.button('Regenerate daily selection',async()=>{await this.ensureSelection(true);await this.openDaily();}),
      this.button('Restore original selection',async()=>{record.revisions.push(record.current);record.current=record.original;await this.store.set('selections',this.selectionKey(),record);this.state.selections[this.selectionKey()]=record;await this.openDaily();})),
      element('p',{class:'muted'},'Daily choices stay pinned across refreshes. Feedback and history changes affect the next generation. Random mode ignores learned interests. Under overlapping categories, matching maximizes coverage without duplicate papers.'));
    if(!record.current.entries.length) body.append(element('p',{class:'notice'},this.state.settings.mode==='subscriptions'?'No eligible papers match the followed authors in this publication cycle.':'No eligible papers can be selected from this publication cycle.'));
    for(const entry of record.current.entries) {const paper=record.paperSnapshots?.[entry.paperId]||this.state.papers[entry.paperId];if(paper)body.append(this.paperCard(paper,entry,{replace:true}));}
    if(record.current.missing.length)body.append(element('details',{},element('summary',{},`${record.current.missing.length} categories not represented`),element('ul',{},record.current.missing.map(m=>element('li',{},`${m.category}: ${m.reason}`)))));
    body.append(element('p',{class:'end'},'End of this daily selection.'),element('p',{class:'muted'},'Keyboard: Alt+J / Alt+K next / previous · Alt+L like · Alt+D dislike · Alt+B bookmark · Alt+R read.'));
  }
  openPrevious() {
    const body=this.panel('Previous daily selections','previous');const keys=Object.keys(this.state.selections).sort().reverse();
    if(!keys.length){body.append(element('p',{},'No selections have been saved yet.'));return;}
    let content=element('div');
    const render=key=>{content.replaceChildren();const r=this.state.selections[key];content.append(element('p',{class:'muted'},`${r.current.date} · ${r.current.mode} · ${r.revisions.length} saved revisions`));
      const revisions=[['current','Current selection'],['original','First selection'],...r.revisions.map((_,i)=>[String(i),`Revision ${i+1}`])];
      const cards=element('div');const draw=value=>{const selection=value==='current'?r.current:value==='original'?r.original:r.revisions[Number(value)];cards.replaceChildren(...selection.entries.map(e=>{const p=r.paperSnapshots?.[e.paperId]||this.state.papers[e.paperId];return p?this.paperCard(p,e):element('p',{},`${e.paperId}: metadata unavailable`);}));};
      content.append(field('Saved version',select(revisions,'current',e=>draw(e.target.value))),cards);draw('current');};
    body.append(field('Publication and mode',select(keys.map(k=>[k,k.replaceAll('|',' · ')]),keys[0],e=>render(e.target.value))),content);render(keys[0]);
  }
  openCategory() {
    const body=this.panel('Explore a category','category');
    const list=element('div');let start=0;let current=Object.keys(CATEGORIES)[0];
    const draw=()=>{list.replaceChildren();const papers=(this.listing?.papers||Object.values(this.state.papers)).filter(p=>p.categories.includes(current));
      list.append(element('p',{class:'notice'},`${papers.length} ${this.listing?.complete?'loaded':'locally known'} papers in ${current}. This view includes all loaded submission sections.`));
      for(const paper of papers.slice(start,start+40))list.append(this.paperCard(paper));
      list.append(element('div',{class:'row'},this.button('Previous page',()=>{start=Math.max(0,start-40);draw();},{disabled:start===0}),this.button('Next page',()=>{start+=40;draw();},{disabled:start+40>=papers.length})));};
    body.append(field('Category',select(Object.entries(CATEGORIES).map(([c,n])=>[c,`${c} — ${n}`]),current,e=>{current=e.target.value;start=0;draw();})),list);draw();
  }
  openBookmarks() {
    const body=this.panel('Bookmarks and reading','bookmarks');
    body.append(element('div',{class:'row'},this.button('Export bookmarks (BibTeX)',()=>downloadText('arxiv-bookmarks.bib',bookmarksBibtex(this.state),'application/x-bibtex')),this.button('Export reading history (CSV)',()=>downloadText('arxiv-reading.csv',readingCSV(this.state),'text/csv'))));
    const ids=Object.keys(this.state.bookmarks).sort((a,b)=>this.state.bookmarks[b].localeCompare(this.state.bookmarks[a]));
    body.append(element('h3',{},`${ids.length} bookmarked papers`));if(!ids.length)body.append(element('p',{},'Use Bookmark on any paper to save it here.'));
    this.pagedPapers(body,ids.map(id=>this.state.papers[id]).filter(Boolean));
    const history=element('details',{},element('summary',{},`Reading history (${Object.keys(this.state.reading).length})`));
    history.append(element('ul',{},Object.entries(this.state.reading).sort((a,b)=>String(b[1]).localeCompare(String(a[1]))).map(([id,date])=>element('li',{},`${fmtDate(date)} · `,link(this.state.papers[id]?.title||id,`https://arxiv.org/abs/${id}`)))));body.append(history);
  }
  pagedPapers(body,papers) {
    let page=0;const cards=element('div');body.append(cards);
    const draw=()=>{cards.replaceChildren(...papers.slice(page*40,(page+1)*40).map(p=>this.paperCard(p)));if(papers.length>40)cards.append(element('div',{class:'row'},this.button('Previous page',()=>{page--;draw();},{disabled:page===0}),element('span',{},`Page ${page+1} / ${Math.ceil(papers.length/40)}`),this.button('Next page',()=>{page++;draw();},{disabled:(page+1)*40>=papers.length})));};draw();
  }
  openAuthors() {
    const body=this.panel('Followed researchers','authors');
    body.append(element('p',{class:'notice'},'These subscriptions match locally loaded publication metadata. Name-only matches are possible identities, not verified researchers. Open the linked author page to check. No background scraping runs.'));
    if(!this.state.subscriptions.length)body.append(element('p',{},'Use Follow next to an author on a paper.'));
    for(const sub of this.state.subscriptions) {
      const matches=Object.values(this.state.papers).filter(p=>p.authors.some(a=>subscriptionMatches(a,sub))).sort((a,b)=>String(b.announcementDate).localeCompare(String(a.announcementDate)));
      const notes=element('textarea',{maxlength:2000},sub.notes||'');
      const section=element('section',{class:'card'},element('h3',{},sub.name),element('p',{class:'muted'},`${sub.stableId?`Stable identifier: ${sub.stableId}`:'Name-only subscription: verify identity'} · Followed ${fmtDate(sub.createdAt)} · ${matches.filter(p=>!this.state.reading[p.id]).length} unread`),
        sub.url?link('Check author identity and publications',sub.url):null,field('Private notes',notes),this.button('Save notes',async()=>{sub.notes=notes.value;await this.store.set('subscriptions',sub.id,sub);this.notify('Author notes saved.');}),
        this.button('Unfollow',async()=>{await this.store.remove('subscriptions',sub.id);this.state.subscriptions=this.state.subscriptions.filter(s=>s.id!==sub.id);this.openAuthors();}),
        element('details',{},element('summary',{},`${matches.length} locally known publications`),element('ul',{},matches.map(p=>element('li',{},`${this.state.reading[p.id]?'Read':'Unread'} · ${fmtDate(p.announcementDate)} · `,link(p.title,p.links.abstract))))));
      body.append(section);
    }
  }
  openInterests() {
    const body=this.panel('Interests and training history','interests');
    const f=activeFeedback(this.state.events,this.state.settings);
    body.append(element('p',{class:'notice'},`${f.active.length} active interest examples; ${f.excluded.length} excluded. Only Like and Dislike train the interest model. Need background is tracked separately.`));
    const h=this.state.settings.history;
    const hMode=select([['all','Use all history'],['none','Ignore all history'],['lastDays','Use last X days'],['ignoreLastDays','Ignore last X days'],['before','Ignore before date'],['after','Ignore after date'],['excludeRange','Exclude date range']],h.mode);
    const days=element('input',{type:'number',min:1,max:36500,value:h.days});
    const start=element('input',{type:'date',value:h.start});const end=element('input',{type:'date',value:h.end});
    body.append(element('div',{class:'columns'},field('Training history window',hMode),field('X days',days),field('Date / range start',start),field('Range end',end)),
      this.button('Apply training window',async()=>{
        if(['before','after','excludeRange'].includes(hMode.value)&&!start.value)throw new Error('Choose a date.');
        if(hMode.value==='excludeRange'&&(!end.value||end.value<start.value))throw new Error('Choose an end date on or after the start.');
        const n=Number(days.value);if(['lastDays','ignoreLastDays'].includes(hMode.value)&&(!Number.isFinite(n)||n<1))throw new Error('Enter a positive number of days.');
        this.state.settings=await this.store.settings({history:{mode:hMode.value,days:n,start:start.value,end:hMode.value==='excludeRange'?end.value:''}});this.retrain();this.openInterests();
      }),element('div',{class:'actions'},
      this.button('Reset interests',async()=>{if(!confirm('Start a new active interest profile? Earlier feedback will be retained but excluded. Bookmarks, reading, subscriptions, glossary and knowledge stay saved.'))return;this.state.settings=await this.store.settings({resetAt:isoNow()});this.retrain();this.openInterests();}),
      this.button('Restore all historical interests',async()=>{for(const event of this.state.events)if(event.excluded){event.excluded=false;await this.store.set('events',event.eventId,event);}this.state.settings=await this.store.settings({resetAt:null,history:{mode:'all'}});this.retrain();this.openInterests();}),
      this.button('Analytics',()=>this.openAnalytics()),this.button('Export feedback (CSV)',()=>downloadText('arxiv-feedback.csv',feedbackCSV(this.state),'text/csv'))));
    body.append(element('h3',{},'Current feedback'),element('p',{class:'muted'},'Changing a rating creates a revision. Excluding the current event never brings an older rating back. Delete permanently removes all revisions for that paper.'));
    const events=[...f.latest].reverse();let page=0;const holder=element('div');body.append(holder);
    const draw=()=>{holder.replaceChildren();const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},['Paper','Date','Feedback / reason','Training','Controls'].map(x=>element('th',{},x)))));const rows=element('tbody');
      for(const e of events.slice(page*40,(page+1)*40))rows.append(element('tr',{},element('td',{},link(e.paper?.title||e.paperId,`https://arxiv.org/abs/${e.paperId}`)),element('td',{},fmtDate(e.timestamp)),element('td',{},`${e.value}${e.reason?` · ${e.reason}`:''}`),element('td',{},f.active.some(a=>a.eventId===e.eventId)?'Active':e.excluded?'Individually excluded':'Inactive / non-interest'),element('td',{},
        this.button(e.excluded?'Include event':'Exclude event',async()=>{e.excluded=!e.excluded;await this.store.set('events',e.eventId,e);await this.reload();this.openInterests();}),
        this.button('Delete permanently',async()=>{if(!confirm('Permanently delete every feedback revision for this paper? This cannot be restored without a backup.'))return;await this.store.deleteFeedback([e.paperId]);await this.reload();this.openInterests();},{class:'danger'}))));
      table.append(rows);holder.append(element('div',{class:'table-wrap'},table));if(!events.length)holder.append(element('p',{},'No feedback yet.'));
      if(events.length>40)holder.append(element('div',{class:'row'},this.button('Previous page',()=>{page--;draw();},{disabled:page===0}),this.button('Next page',()=>{page++;draw();},{disabled:(page+1)*40>=events.length})));};draw();
  }
  openAnalytics(startDate='',endDate='') {
    const body=this.panel('Interest analytics','analytics');
    const start=element('input',{type:'date',value:startDate});const end=element('input',{type:'date',value:endDate});
    body.append(element('div',{class:'row'},field('From',start),field('Through',end),this.button('Apply date range',()=>{if(start.value&&end.value&&start.value>end.value)throw new Error('The end date must not precede the start date.');this.openAnalytics(start.value,end.value);})),
      element('p',{class:'notice'},'Observed likes and dislikes describe recorded feedback. Model scores are predictions, not calibrated probabilities. Estimates are withheld when there are fewer than three examples; intervals show sampling uncertainty, not a measurement of identity.'));
    const a=analytics(this.state,{start:startDate,end:endDate,model:this.model});
    body.append(element('p',{},`${a.reviewedCount} reviewed · ${a.positiveCount} likes · ${a.negativeCount} dislikes · ${a.backgroundCount} background requests · ${a.activeCount} active / ${a.excludedCount} excluded training examples`));
    const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},['Category','Reviewed','Likes / dislikes','Background','Observed like share (95% interval)','Model score'].map(x=>element('th',{},x)))),element('tbody',{},a.categories.map(c=>element('tr',{},element('td',{},`${c.code} ${c.name}`),element('td',{},c.reviewed),element('td',{},`${c.positive} / ${c.negative}`),element('td',{},c.background),element('td',{},c.estimate==null?'Insufficient feedback':`${percent(c.estimate)} (${percent(c.interval?.[0]??c.interval?.low)}–${percent(c.interval?.[1]??c.interval?.high)}) · n=${c.positive+c.negative}`),element('td',{},c.prediction==null?'Insufficient feedback':`${Number(c.prediction).toFixed(2)} · ${c.predictionSamples} papers`)))));
    body.append(element('div',{class:'table-wrap'},table));
    const ranked=(title,items)=>element('section',{},element('h3',{},title),items.length?element('ol',{},items.slice(0,30).map(x=>element('li',{},`${x.term} (${x.count})`))):element('p',{class:'muted'},'No data in this range.'));
    body.append(element('div',{class:'columns'},ranked('Frequently liked concepts',a.likedConcepts),ranked('Frequently investigated terms',a.unfamiliarTerms)));
    body.append(element('h3',{},'Feedback over time'),element('table',{class:'tabular'},element('thead',{},element('tr',{},['Period','Likes','Dislikes','Background','Reviewed'].map(x=>element('th',{},x)))),element('tbody',{},a.timeline.map(t=>element('tr',{},[t.period,t.positive,t.negative,t.background,t.reviewed].map(v=>element('td',{},v)))))));
    const trends=element('details',{},element('summary',{},'Changes by mathematical category'),element('p',{class:'muted'},'Counts can overlap because a paper may have several classifications.'));
    for(const t of a.timeline) {
      const cats=Array.isArray(t.categories)?t.categories:Object.entries(t.categories||{}).map(([code,value])=>({code,...value}));
      trends.append(element('h3',{},t.period),element('ul',{},cats.filter(c=>c.reviewed||c.positive||c.negative||c.background).map(c=>element('li',{},`${c.code}: ${c.positive||0} likes, ${c.negative||0} dislikes, ${c.background||0} background requests, ${c.reviewed||0} reviewed`))));
    }
    body.append(trends);
    const readings=Array.isArray(a.readingHistory)?a.readingHistory:[];
    body.append(element('details',{},element('summary',{},`Reading history in this range (${readings.length})`),element('ul',{},readings.map(r=>{const id=r.paperId||r.id;return element('li',{},`${fmtDate(r.timestamp||r.readAt||r.date)} · `,link(r.title||this.state.papers[id]?.title||id,`https://arxiv.org/abs/${id}`));}))));
    body.append(element('details',{},element('summary',{},'Knowledge changes in this range'),element('ul',{},(a.knowledge||[]).map(k=>element('li',{},`${k.term}: ${k.level} (${fmtDate(k.updatedAt)})`,element('ul',{},k.history.map(h=>element('li',{},`${fmtDate(h.updatedAt)}: ${h.level}`))))))));
    body.append(element('details',{},element('summary',{},'Followed researchers in this publication range'),element('ul',{},(a.followedResearchers||[]).map(s=>element('li',{},`${s.name}: ${s.recent.length} locally known publications; ${s.unread.length} unread`)))));
    body.append(element('p',{class:'muted'},`${this.state.subscriptions.length} followed researchers · ${Object.keys(this.state.knowledge).length} explicitly rated knowledge topics. Category counts can overlap for cross-classified papers.`),
      this.button('Reading and bookmarks',()=>this.openBookmarks()),this.button('Knowledge development',()=>this.openKnowledge()),this.button('Followed researchers',()=>this.openAuthors()));
  }
  openKnowledge() {
    const body=this.panel('Mathematical knowledge and glossary','knowledge');
    body.append(element('p',{class:'notice'},'Knowledge is separate from interests. Enter concepts you know, at your own level. Only these explicit levels are sent with an AI request; age and grades are not used.'));
    const topic=element('input',{type:'text',maxlength:100,placeholder:'For example, sequences or linear algebra'});const level=select(LEVELS.map(l=>[l,l]),'Comfortable');
    const saveTopic=async()=>{const name=topic.value.trim();if(!name)throw new Error('Enter a mathematical topic.');const old=this.state.knowledge[name];const at=isoNow();const value={level:level.value,updatedAt:at,history:[...(old?.history||[]),{level:level.value,updatedAt:at}]};await this.store.set('knowledge',name,value);this.state.knowledge[name]=value;this.openKnowledge();};
    body.append(element('div',{class:'row'},field('Topic',topic),field('Knowledge level',level),this.button('Add or update topic',saveTopic)));
    const table=element('table',{class:'tabular'},element('thead',{},element('tr',{},['Topic','Level','History','Remove'].map(x=>element('th',{},x)))),element('tbody',{},Object.entries(this.state.knowledge).map(([name,k])=>element('tr',{},element('td',{},name),element('td',{},select(LEVELS.map(l=>[l,l]),k.level,async e=>{const at=isoNow();k={...k,level:e.target.value,updatedAt:at,history:[...(k.history||[]),{level:e.target.value,updatedAt:at}]};await this.store.set('knowledge',name,k);this.state.knowledge[name]=k;})),element('td',{},element('details',{},element('summary',{},`${k.history?.length||1} recorded level(s)`),element('ul',{},(k.history||[k]).map(h=>element('li',{},`${fmtDate(h.updatedAt)}: ${h.level}`))))),element('td',{},this.button('Remove',async()=>{await this.store.remove('knowledge',name);delete this.state.knowledge[name];this.openKnowledge();}))))));body.append(table);
    body.append(element('h3',{},'Saved glossary'));
    const entries=Object.entries(this.state.glossary).sort((a,b)=>String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
    if(!entries.length)body.append(element('p',{},'Highlight a term in a title, abstract, full HTML paper, or explanation, then choose Explain selection.'));
    for(const [key,g] of entries)body.append(element('details',{class:'card'},element('summary',{},`${g.term} · ${g.status||'unfamiliar'} · ${g.visits||1} visit(s)`),element('p',{class:'answer','data-paper-id':g.paperId},mathFragment(document,g.answer)),field('Understanding',select([['unfamiliar','Unfamiliar'],['partial','Partially understood'],['understood','Understood']],g.status||'unfamiliar',async e=>{g.status=e.target.value;g.updatedAt=isoNow();await this.store.set('glossary',key,g);})),this.button('Delete term',async()=>{await this.store.remove('glossary',key);delete this.state.glossary[key];this.openKnowledge();})));
  }
  async pairBridge() {
    const token=prompt('Paste the pairing token printed by your local AI bridge. This is not a hosted-provider API key. The token is stored only in Tampermonkey private storage.');
    if(token===null)return;if(token.trim().length<32)throw new Error('Use the complete random pairing token (at least 32 characters).');
    this.state.settings=await this.store.settings({ai:{token:token.trim()}});if(this.toolbar)this.notify('Local bridge paired. Configure a model and explicitly enable AI in Settings.');
  }
  openSettings() {
    const body=this.panel('Discovery settings','settings');const s=this.state.settings;
    if(this.state.storageWarnings?.length)body.append(element('div',{class:'notice'},'Some saved records could not be loaded:',element('ul',{},this.state.storageWarnings.map(w=>element('li',{},w)))));
    body.append(element('h3',{},'Discovery'),checkbox('Include cross-submissions',s.includeCross,async e=>{this.state.settings=await this.store.settings({includeCross:e.target.checked});}),
      checkbox('Include replacement submissions',s.includeReplacements,async e=>{this.state.settings=await this.store.settings({includeReplacements:e.target.checked});}),
      checkbox('Allow feedback collected in Pure Random mode to train future recommendations',s.trainRandom,async e=>{this.state.settings=await this.store.settings({trainRandom:e.target.checked});this.retrain();this.updateStatus();}),
      checkbox('Use explicit author subscriptions as recommendation signals',s.useSubscriptions,async e=>{this.state.settings=await this.store.settings({useSubscriptions:e.target.checked});}),
      checkbox('Show expandable discovery tools below each paper',s.showTools,async e=>{this.state.settings=await this.store.settings({showTools:e.target.checked});if(e.target.checked)this.attachPaperTools();else{for(const host of this.hosts.filter(h=>h!==this.toolbar))host.remove();this.hosts=this.hosts.filter(h=>h===this.toolbar);this.roots=[this.root];}}),
      checkbox('No Spoilers by default',s.noSpoilers,async e=>{this.state.settings=await this.store.settings({noSpoilers:e.target.checked});}),
      field('Add-on color theme',select([['auto','System'],['light','Light'],['dark','Dark']],s.theme,async e=>{this.state.settings=await this.store.settings({theme:e.target.value});this.updateStatus();}),'Applies only to added controls and panels.'));
    const explore=element('input',{type:'number',min:0,max:100,step:5,value:Math.round(s.exploration*100)});const count=element('input',{type:'number',min:1,max:32,value:s.personalizedCount});
    body.append(element('div',{class:'row'},field('Balanced-mode random exploration (%)',explore),field('Personalized selection size',count),this.button('Save sampling settings',async()=>{const x=Number(explore.value),n=Number(count.value);if(!Number.isFinite(x)||x<0||x>100||!Number.isInteger(n)||n<1||n>32)throw new Error('Use 0–100% exploration and 1–32 papers.');this.state.settings=await this.store.settings({exploration:x/100,personalizedCount:n});this.notify('Sampling settings saved. Existing daily selections remain pinned.');})));
    this.aiSettings(body);
    body.append(element('h3',{},'Backup and data controls'),element('p',{class:'muted'},'JSON backups include personal data and explanations but exclude the pairing token and AI consent. Import validates then merges; it does not delete unrelated records.'),
      element('div',{class:'row'},this.button('Export all data (JSON)',async()=>downloadText('arxiv-discovery-backup.json',JSON.stringify(await this.store.export(),null,2),'application/json')),
      this.button('Export feedback (CSV)',()=>downloadText('arxiv-feedback.csv',feedbackCSV(this.state),'text/csv')),this.button('Export bookmarks (BibTeX)',()=>downloadText('arxiv-bookmarks.bib',bookmarksBibtex(this.state),'application/x-bibtex'))));
    const input=element('input',{type:'file',accept:'.json,application/json','aria-label':'Import a JSON backup'});
    body.append(field('Import a backup',input),this.button('Import selected JSON',async()=>{
      const file=input.files?.[0];if(!file)throw new Error('Choose a JSON backup first.');if(file.size>50000000)throw new Error('The backup exceeds 50 MB.');
      const data=JSON.parse(await file.text());await this.store.import(data);await this.reload();this.openSettings();this.notify('Backup imported. The AI bridge must be paired and enabled again.');
    }));
    const groups=[['events','Feedback'],['bookmarks','Bookmarks'],['reading','Reading history'],['subscriptions','Author subscriptions'],['knowledge','Knowledge profile'],['glossary','Glossary'],['explanations','Cached AI explanations'],['selections','Saved daily selections']];
    const category=select(groups,'events');body.append(field('Selective deletion',category),this.button('Delete selected data',async()=>{if(!confirm(`Permanently delete ${groups.find(g=>g[0]===category.value)[1].toLowerCase()}?`))return;await this.store.clearCollection(category.value);await this.reload();this.openSettings();}),
      this.button('Delete all local data',async()=>{if(!confirm('Permanently delete all arXiv Discovery data, settings, pairing and cached explanations on this browser? Export a backup first if needed.'))return;await this.store.clearAll();await this.cache.clear();await this.reload();this.activeSelection=null;this.openSettings();this.notify('All saved Discovery data has been deleted.');},{class:'danger'}),
      element('p',{class:'version'},'arXiv Discovery 1.0.0 · Independent userscript · Thank you to arXiv for use of its open access interoperability.'),
      link('Source, documentation and issues','https://github.com/sodium-qed/arXiv-scroller'));
  }
  aiSettings(body) {
    const a=this.state.settings.ai;
    body.append(element('h3',{},'Optional AI explanations'),element('p',{class:'notice'},'AI runs only when requested. The paired local bridge retrieves this paper and sends source text, your explicit knowledge profile, the selected term or follow-up, and its surrounding explanation context to the chosen provider. Interest feedback, bookmarks, subscriptions, and browsing history are not sent. Provider keys belong in the bridge environment, never here.'));
    const provider=select([['local','Local OpenAI-compatible model'],['openai','Hosted OpenAI API']],a.provider||'local');
    const url=element('input',{type:'url',value:a.url});const model=element('input',{type:'text',value:a.model,placeholder:'Model allowed by your bridge'});
    const profile=select([['quick','Quick (local; abstract first)'],['full','Detailed (full-paper excerpts)']],a.profile||'quick');
    const timeout=element('input',{type:'number',min:60,max:600,value:a.timeoutSeconds||420});
    const requests=element('input',{type:'number',min:1,max:500,value:a.dailyRequests});const budget=element('input',{type:'number',min:0,max:1000,step:.1,value:a.dailyBudget});
    const chars=element('input',{type:'number',min:1000,max:120000,value:a.maxInputChars});const output=element('input',{type:'number',min:128,max:8192,value:a.maxOutputTokens});
    const inputRate=element('input',{type:'number',min:0,step:.01,value:a.inputPerMillion});const outputRate=element('input',{type:'number',min:0,step:.01,value:a.outputPerMillion});
    const enabled=element('input',{type:'checkbox',checked:a.enabled});const consent=element('input',{type:'checkbox',checked:a.consent});
    for(const input of [provider,url,model])input.addEventListener('input',()=>{consent.checked=false;enabled.checked=false;});
    body.append(element('div',{class:'columns'},field('Provider',provider),field('Local bridge URL',url,'Only http://127.0.0.1 with an optional port is allowed.'),field('Model',model),field('Local reading profile',profile,'Quick caps source at 4,000 characters and output at 768 tokens; protected readings still use the protection filter. Hosted AI uses Detailed.'),field('Request timeout (seconds)',timeout),field('Daily request limit',requests),field('Daily estimated budget (USD)',budget),field('Maximum source characters',chars),field('Maximum output tokens',output),field('Input USD per million tokens (estimate)',inputRate),field('Output USD per million tokens (estimate)',outputRate)),
      element('p',{class:'muted'},`Bridge pairing: ${a.token?'token stored privately':'not paired'}. The server enforces its own provider rates and ceilings; zero browser rates never bypass server budgets.`),this.button('Pair / replace bridge token',()=>this.pairBridge()),
      element('label',{class:'check'},enabled,'Enable on-demand AI'),element('label',{class:'check'},consent,'I authorize this selected provider to receive requested paper text and my explicit knowledge profile.'));
    const estimate=element('p',{class:'muted'});
    const estimateCost=()=>{const value=((4*Number(chars.value)+16000)*Number(inputRate.value)+Number(output.value)*Number(outputRate.value))/1e6;estimate.textContent=`Conservative configured request estimate: up to $${Number.isFinite(value)?value.toFixed(4):'—'} before server ceilings. Actual usage is shown with responses. A ChatGPT subscription is not API credit.`;};
    for(const input of [chars,output,inputRate,outputRate])input.addEventListener('input',estimateCost);estimateCost();body.append(estimate);
    body.append(this.button('Save AI settings',async()=>{
      const u=new URL(url.value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||!['','/'].includes(u.pathname)||u.search||u.hash)throw new Error('Use http://127.0.0.1:PORT without a path or credentials.');
      const n=Number(requests.value),b=Number(budget.value),c=Number(chars.value),o=Number(output.value),ir=Number(inputRate.value),or=Number(outputRate.value),t=Number(timeout.value);
      if(!Number.isInteger(t)||t<60||t>600||!Number.isInteger(n)||n<1||n>500||!Number.isFinite(b)||b<0||!Number.isInteger(c)||c<1000||c>120000||!Number.isInteger(o)||o<128||o>8192||!Number.isFinite(ir)||ir<0||!Number.isFinite(or)||or<0)throw new Error('Use valid positive limits and nonnegative rates.');
      if(enabled.checked&&(!consent.checked||!model.value.trim()||!this.state.settings.ai.token))throw new Error('Pair the bridge, specify a model, and authorize the provider before enabling AI.');
      const changed=provider.value!==(a.provider||'local')||u.origin!==a.url||model.value.trim()!==a.model;
      this.state.settings=await this.store.settings({ai:{provider:provider.value,url:u.origin,model:model.value.trim(),enabled:enabled.checked,consent:consent.checked,dailyRequests:n,dailyBudget:b,maxInputChars:c,maxOutputTokens:o,inputPerMillion:ir,outputPerMillion:or,profile:profile.value,timeoutSeconds:t}});
      this.notify(changed?'AI configuration saved with the selected provider authorization.':'AI settings saved.');
    }));
  }
  async openAI(paper,term='',options={}) {
    const generation=await this.store.generation();
    this.currentPaper=paper;const body=this.panel(term?`Explain: ${term}`:'AI paper overview','ai');body.dataset.paperId=paper.id;
    body.append(element('p',{},link(mathFragment(document,paper.title),paper.links.abstract)),this.paperProtection(paper));
    if(!this.state.settings.ai.enabled||!this.state.settings.ai.consent||!this.state.settings.ai.token) {
      body.append(element('p',{class:'notice'},'AI is optional and is not connected yet. Configure and pair a local bridge in Settings. Discovery, feedback, subscriptions, and bookmarks work without it.'),this.button('Open AI settings',()=>this.openSettings()));return;
    }
    const loading=element('p',{role:'status'},'Retrieving the source and preparing a grounded explanation…');body.append(loading);
    try {
      const config={...options,noSpoilers:this.noSpoilers(paper),onProgress:(phase,chunks)=>{
        if(!loading.isConnected)return;
        loading.textContent=phase==='retrieving'?'Selecting source evidence…':phase==='validating'?'Verifying source quotations…':`Generating explanation locally${chunks?` (${chunks} response chunks received)`:''}…`;
      }};
      const result=term?await this.ai.explain(paper,term,config):await this.ai.overview(paper,config);
      if(!body.isConnected)return;if(generation!==await this.store.generation()){loading.textContent='Saved data changed while this request was running. The answer was not added to the glossary.';return;}loading.remove();
      const source=element('div',{class:'source'},`${result.cached?'Cached · ':''}Source analyzed: ${result.source.kind.toUpperCase()} · `,link('Open analyzed source',result.source.url),element('p',{},result.source.note||''));
      if(result.source.citations?.length) source.append(element('div',{class:'row'},result.source.citations.map(c=>link(c.label,c.url))));
      body.append(source,element('p',{class:'answer','data-paper-id':paper.id},mathFragment(document,result.text)));
      if(result.usage)body.append(element('p',{class:'muted'},`Reported usage: ${result.usage.inputTokens??'unknown'} input / ${result.usage.outputTokens??'unknown'} output tokens · estimated $${Number(result.usage.estimatedCostUsd||0).toFixed(4)}. Verify important mathematical claims against the linked source.`));
      if(term) {
        const key=`${paper.versionedId||paper.id}:${term.toLocaleLowerCase()}`;const old=this.state.glossary[key];const at=isoNow();
        const entry={term,paperId:paper.id,answer:result.text,source:result.source,status:old?.status||'unfamiliar',updatedAt:at,visits:(old?.visits||0)+1,visitHistory:[...(old?.visitHistory||[]),at]};
        if(!await this.store.setIfGeneration('glossary',key,entry,generation))return;this.state.glossary[key]=entry;await this.rememberPaper(paper);
        body.append(field('My understanding',select([['unfamiliar','Unfamiliar'],['partial','Partially understood'],['understood','Understood']],entry.status,async e=>{entry.status=e.target.value;entry.updatedAt=isoNow();await this.store.set('glossary',key,entry);})));
      }
      if(!term&&this.state.settings.ai.provider==='local'&&(this.state.settings.ai.profile||'quick')==='quick'&&options.profile!=='full'&&!options.question&&options.detail!=='rigorous')body.append(this.button('Detailed paper overview',()=>this.openAI(paper,'',{...options,profile:'full'})));
      const question=element('textarea',{maxlength:2000,placeholder:'Ask a follow-up about this paper or term.'});
      body.append(element('div',{class:'actions'},this.button('Simpler explanation',()=>this.openAI(paper,term,{detail:'simpler',context:result.text.slice(0,1600)})),this.button('More rigorous explanation',()=>this.openAI(paper,term,{detail:'rigorous',context:result.text.slice(0,1600)}))),field('Follow-up question',question),this.button('Ask follow-up',()=>{if(!question.value.trim())throw new Error('Enter a follow-up question.');return this.openAI(paper,term,{question:question.value.trim(),context:result.text.slice(0,1600)});}),element('p',{class:'muted'},'Highlight unfamiliar terms inside this explanation to explain them recursively. No Spoilers limits responses to definitions, established background, and research-question context.'));
    } catch(error) {loading.textContent=error.message||String(error);loading.className='notice error';body.append(this.button('Check AI settings',()=>this.openSettings()));}
  }
  handleSelection(event) {
    if(!event.isTrusted||!this.toolbar||event.target?.closest?.('button,input,textarea,select,summary'))return;
    if(event.currentTarget===document&&event.target?.closest?.('[data-arxiv-discovery]'))return;
    const selection=event.currentTarget?.getSelection?.()||window.getSelection();const term=selection?.toString().trim();
    if(!term||term.length>250){this.selectionBubble?.remove();this.selectionBubble=null;return;}
    const range=selection.rangeCount?selection.getRangeAt(0):null;let node=range?.commonAncestorContainer;if(node?.nodeType===3)node=node.parentElement;
    let paper=null;
    const paperId=node?.closest?.('[data-paper-id]')?.dataset.paperId;if(paperId)paper=this.state.papers[paperId];
    if(!paper&&readerTarget(node)) {
      for(const [id,nodes] of this.paperNodes)if(nodes.dd.contains(node)||nodes.dt.contains(node)){paper=this.state.papers[id];break;}
      paper=paper||this.article;
    }
    // Closed shadow selection can be retargeted; only use the current paper inside our answer panel.
    if(!paper&&event.currentTarget===this.root&&this.currentPanel==='ai')paper=this.currentPaper;
    if(!paper)return;
    this.selectionBubble?.remove();const rect=range?.getBoundingClientRect();
    const bubble=element('div',{class:'dictionary-select'});bubble.style.left=`${Math.max(8,Math.min((rect?.left||event.clientX),window.innerWidth-250))}px`;bubble.style.top=`${Math.max(8,Math.min((rect?.bottom||event.clientY)+6,window.innerHeight-60))}px`;
    const context=String(node?.textContent||'').slice(0,1600);
    bubble.append(this.button('Explain selection',()=>{bubble.remove();return this.openAI(paper,term,{context});}));(this.dialog?.open?this.dialog:this.root).append(bubble);this.selectionBubble=bubble;
  }
  handleKeys(event) {
    if(!event.isTrusted||!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(this.dialog?.open&&this.currentPanel!=='daily')return;
    // Retargeting hides focused controls in a closed shadow from document events.
    const active=[document.activeElement,...this.roots.map(root=>root.activeElement)].filter(Boolean);
    const path=[...event.composedPath(),...active];
    if(path.some(n=>n?.tagName&&(['INPUT','TEXTAREA','SELECT'].includes(n.tagName)||n.isContentEditable)))return;
    const key=event.key.toLowerCase();if(!['j','k','l','d','b','r'].includes(key))return;
    let focusedPaper=null;
    for(const node of active) {
      const id=node.closest?.('[data-paper-id]')?.dataset.paperId;if(id&&this.state.papers[id])focusedPaper=this.state.papers[id];
      if(!focusedPaper)for(const [paperId,nodes] of this.paperNodes)if(nodes.dt.contains(node)||nodes.dd.contains(node)){focusedPaper=this.state.papers[paperId];break;}
    }
    if(focusedPaper)this.currentPaper=focusedPaper;
    let papers=this.activeSelection?.current.entries.map(e=>this.state.papers[e.paperId]).filter(Boolean)||this.listing?.papers||[this.article].filter(Boolean);if(!papers.length)return;
    event.preventDefault();let index=papers.findIndex(p=>p.id===this.currentPaper?.id);
    if(key==='j'||key==='k') {
      index=Math.max(0,Math.min(papers.length-1,index+(key==='j'?1:-1)));const paper=papers[index];this.currentPaper=paper;
      const card=this.body?.querySelector(`[data-paper-id="${CSS.escape(paper.id)}"].card`);if(card){card.focus();card.scrollIntoView({block:'center'});}else{const node=this.paperNodes.get(paper.id)?.dt;node?.scrollIntoView({block:'center'});node?.querySelector('a')?.focus();}return;
    }
    const paper=focusedPaper||papers[Math.max(0,index)];this.currentPaper=paper;
    const run=async()=>{if(key==='l'||key==='d'){const e=await this.store.feedback(paper,key==='l'?'like':'dislike','',this.state.settings.mode);this.state.events.push(e);this.retrain();}
      if(key==='b'){if(this.state.bookmarks[paper.id]){await this.store.remove('bookmarks',paper.id);delete this.state.bookmarks[paper.id];}else{await this.rememberPaper(paper);this.state.bookmarks[paper.id]=isoNow();await this.store.set('bookmarks',paper.id,this.state.bookmarks[paper.id]);}}
      if(key==='r'){if(this.state.reading[paper.id]){await this.store.remove('reading',paper.id);delete this.state.reading[paper.id];}else{await this.rememberPaper(paper);this.state.reading[paper.id]=isoNow();await this.store.set('reading',paper.id,this.state.reading[paper.id]);}}this.refreshActionRows(paper);this.updateProgress();this.updateStatus();};run().catch(e=>this.notify(e.message));
  }
}

return {DiscoveryApp};
},
"src/network.js": (__require) => {
const { listingCounts, listingUrl, parseListing } = __require("src/parser.js");

const STATUS_BLOCKS_MORE_REQUESTS = new Set([401, 403, 429, 503]);

// The contents of a template belong to an inert document, including its images,
// frames and scripts. Only strings extracted by parseListing leave the template.
function inertDocument(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function mergeListingPages(pages) {
  if (!pages.length) throw new Error('A starting listing is required.');
  const first = pages[0];
  const papers = new Map();
  const totals = new Set();
  const sectionTotals = {};
  const integrity = new Set();
  const next = new Set();
  const visited = new Set();
  for (const page of pages) {
    if (!first.announcementDate || page.announcementDate !== first.announcementDate) {
      integrity.add('Pagination could not verify a single announcement date.');
      if (page !== first) continue;
    }
    if (!listingUrl(page.baseUrl, first.baseUrl)) {
      integrity.add('A pagination URL did not belong to the same arXiv daily listing.');
      continue;
    }
    visited.add(listingUrl(page.baseUrl, first.baseUrl));
    for (const warning of page.integrityWarnings || []) integrity.add(warning);
    if (Number.isSafeInteger(page.advertisedTotal)) totals.add(page.advertisedTotal);
    for (const [section, count] of Object.entries(page.sectionTotals || {})) {
      if (section in sectionTotals && sectionTotals[section] !== count) {
        integrity.add('The advertised size of the ' + section + ' section changed between pages.');
      }
      sectionTotals[section] = count;
    }
    for (const paper of page.papers) {
      const previous = papers.get(paper.id);
      if (previous && (previous.section !== paper.section || previous.title !== paper.title ||
          (previous.version && paper.version && previous.version !== paper.version))) {
        integrity.add('Different records were returned for arXiv:' + paper.id + '.');
      } else if (!previous || (!previous.version && paper.version)) {
        papers.set(paper.id, paper);
      }
    }
    for (const raw of page.nextUrls) {
      const url = listingUrl(raw, first.baseUrl);
      if (url) next.add(url);
    }
  }
  const advertisedTotal = [...totals][0] ?? null;
  if (totals.size > 1) integrity.add('The advertised daily total changed between pages.');
  const records = [...papers.values()];
  const counts = listingCounts(records);
  const warnings = [...integrity];
  if (advertisedTotal === null) warnings.push('The daily total could not be verified.');
  else if (counts.total !== advertisedTotal) warnings.push('Retrieved ' + counts.total + ' of ' + advertisedTotal + ' announced entries.');
  for (const [section, total] of Object.entries(sectionTotals)) {
    if (counts[section] !== total) warnings.push('Retrieved ' + counts[section] + ' of ' + total + ' entries in the ' + section + ' section.');
  }
  const complete = warnings.length === 0;
  return {
    papers: records, counts, advertisedTotal, sectionTotals, complete, warnings,
    announcementDate: first.announcementDate, baseUrl: first.baseUrl, integrityWarnings: [...integrity],
    nextUrls: complete ? [] : [...next].filter(url => !visited.has(url)),
  };
}

async function loadCompleteListing(initial, {
  request, parseDocument = inertDocument, baseUrl = initial.baseUrl, onProgress, maxPages = 80,
} = {}) {
  if (initial.complete) return initial;
  const start = listingUrl(baseUrl, baseUrl);
  if (!initial.announcementDate || !start) {
    return { ...initial, complete: false, warnings: [...new Set([...initial.warnings, 'A dated arXiv daily listing is needed to retrieve additional pages.'])] };
  }
  const pages = [{ ...initial, baseUrl: start }];
  const attempted = new Set([start]);
  const errors = [];
  const retry = new Set();
  let combined = mergeListingPages(pages);
  let received = 0;
  while (!combined.complete && received < maxPages) {
    const next = combined.nextUrls.find(url => !attempted.has(url));
    if (!next) break;
    attempted.add(next);
    received++;
    let status = 0;
    try {
      const response = await request(next, { method: 'GET', timeout: 30000 });
      status = response?.status || 0;
      if (status < 200 || status >= 300) throw new Error('arXiv returned HTTP ' + status + '.');
      const finalUrl = listingUrl(response.finalUrl || next, start);
      if (!finalUrl) throw new Error('A redirect left the requested arXiv daily listing.');
      if (typeof response.text !== 'string' || response.text.length > 32 * 1024 * 1024) {
        throw new Error('The response was missing or exceeded the 32 MiB page limit.');
      }
      const page = parseListing(parseDocument(response.text, finalUrl), finalUrl);
      if (!page.announcementDate || page.announcementDate !== initial.announcementDate) {
        errors.push('The announcement date changed or disappeared during pagination. Open the latest listing to start a new cycle.');
        break;
      }
      if (initial.advertisedTotal !== null && page.advertisedTotal !== null && page.advertisedTotal !== initial.advertisedTotal) {
        errors.push('The advertised daily total changed during pagination. Reload the listing to verify the new total.');
        break;
      }
      attempted.add(finalUrl);
      // A verified complete rendering can replace a truncated or malformed first
      // page. Never mix its metadata with a different publication cycle.
      if (page.complete) {
        onProgress?.({ pages: pages.length + 1, papers: page.counts.total, advertisedTotal: page.advertisedTotal });
        return page;
      }
      pages.push(page);
      combined = mergeListingPages(pages);
      onProgress?.({ pages: pages.length, papers: combined.counts.total, advertisedTotal: combined.advertisedTotal });
    } catch (error) {
      retry.add(next);
      errors.push('Could not read a pagination page. ' + (error?.message || 'The request failed.'));
      if (STATUS_BLOCKS_MORE_REQUESTS.has(status)) break;
    }
  }
  if (combined.complete) return combined;
  if (received >= maxPages && combined.nextUrls.some(url => !attempted.has(url))) {
    errors.push('Stopped after ' + received + ' additional pages. A complete listing could not be verified.');
  }
  if (!combined.nextUrls.length && !errors.length) errors.push('No further same-list pagination links were available.');
  return {
    ...combined, warnings: [...new Set([...combined.warnings, ...errors])],
    nextUrls: [...new Set([...combined.nextUrls.filter(url => !attempted.has(url)), ...retry])],
  };
}

return {mergeListingPages,loadCompleteListing};
},
"src/sampling.js": (__require) => {
const { CATEGORIES } = __require("src/categories.js");
const { authorIdentity, conceptTerms, interestEvidence, paperCategories, predict, subscriptionMatches } = __require("src/recommender.js");

const MODES = new Set(['random', 'balanced', 'personalized', 'discovery', 'subscriptions', 'original']);
const CODES = Object.keys(CATEGORIES).sort();

function compareIds(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function randomSource(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.codePointAt(0), 16777619) >>> 0;
  function uint32() {
    state = (state + 0x6D2B79F5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return (bits ^ (bits >>> 14)) >>> 0;
  }
  return {
    // Rejection avoids modulo bias in bounded integer draws for Fisher–Yates.
    index(bound) {
      const limit = Math.floor(4294967296 / bound) * bound;
      let value;
      do { value = uint32(); } while (value >= limit);
      return value % bound;
    },
    unit() { return (uint32() + 0.5) / 4294967296; },
  };
}

function shuffled(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random.index(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function eligibleSection(section, settings) {
  return section === 'new' || (section === 'cross' && settings.includeCross === true) ||
    (section === 'replacement' && settings.includeReplacements === true);
}

function optionsFor(papers, options) {
  const settings = options.settings || {};
  const requested = options.mode || settings.mode;
  const mode = MODES.has(requested) ? requested : 'random';
  const date = options.date || '';
  const seed = options.seed ?? (date + '|' + mode);
  const byId = new Map();
  const availableSections = new Map(CODES.map(code => [code, new Set()]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) for (const paper of papers || []) {
    if (!paper || typeof paper.id !== 'string' || !paper.id || paper.announcementDate !== date) continue;
    const codes = paperCategories(paper);
    for (const code of codes) availableSections.get(code).add(paper.section);
    if (!codes.length || !eligibleSection(paper.section, settings)) continue;
    const previous = byId.get(paper.id);
    if (!previous) {
      byId.set(paper.id, paper);
    } else {
      const chosen = (Number(paper.version) || 0) > (Number(previous.version) || 0) ? paper : previous;
      byId.set(paper.id, {...chosen, categories: [...new Set([...codes, ...paperCategories(previous)])]});
    }
  }
  const pool = [...byId.values()].sort(compareIds);
  const categories = new Map(pool.map(paper => [paper.id, paperCategories(paper)]));
  const byCategory = new Map(CODES.map(code => [code, []]));
  for (const paper of pool) for (const code of categories.get(paper.id)) byCategory.get(code).push(paper);
  const subscriptionCache = new Map();
  function matches(paper) {
    if (!subscriptionCache.has(paper.id)) {
      const found = [];
      for (const subscription of options.subscriptions || []) {
        const author = paper.authors?.find(person => subscriptionMatches(person, subscription));
        if (author) found.push({name: subscription.name || author.name, nameOnly: !(author.stableId && subscription.stableId)});
      }
      subscriptionCache.set(paper.id, found);
    }
    return subscriptionCache.get(paper.id);
  }
  const useSubscriptions = settings.useSubscriptions === true && (mode === 'balanced' || mode === 'personalized');
  const hasPreference = (mode === 'balanced' || mode === 'personalized') &&
    Boolean(options.model?.sampleCount || (useSubscriptions && pool.some(paper => matches(paper).length)));
  const exploration = Number(settings.exploration ?? 0.25);
  const count = Number(settings.personalizedCount ?? 32);
  return {
    date, mode, seed, model: options.model, random: randomSource(seed), pool, byId, categories, byCategory,
    availableSections, matches, useSubscriptions, hasPreference, info: new Map(),
    exploration: Number.isFinite(exploration) ? Math.max(0, Math.min(1, exploration)) : 0.25,
    count: Number.isFinite(count) ? Math.max(1, Math.min(32, Math.trunc(count))) : 32,
    encounters: mode === 'discovery' ? encountered(options, byId) : null,
    incomplete: options.complete === false,
  };
}

function encountered(options, candidates) {
  const ids = new Set();
  const history = new Map();
  for (const paper of options.model?.encounterPapers || []) if (paper?.id) history.set(paper.id, paper);
  for (const id of Object.keys(options.reading || {})) {
    ids.add(id);
    const known = options.knownPapers instanceof Map ? options.knownPapers.get(id) :
      Object.hasOwn(options.knownPapers || {}, id) ? options.knownPapers[id] : null;
    if (known || candidates.has(id)) history.set(id, known || candidates.get(id));
  }
  const subjects = new Map();
  const topics = new Map();
  const authors = new Map();
  function count(keys, target) {
    for (const key of new Set(keys)) if (key) target.set(key, (target.get(key) || 0) + 1);
  }
  for (const [id, paper] of history) {
    ids.add(id);
    count(paperCategories(paper), subjects);
    count(conceptTerms(paper), topics);
    count((paper.authors || []).map(authorIdentity), authors);
  }
  return {ids, subjects, topics, authors};
}

function novelty(paper, ctx) {
  const known = ctx.encounters;
  const topicLabels = conceptTerms(paper);
  const authorLabels = [...new Set((paper.authors || []).map(authorIdentity).filter(Boolean))];
  const groups = [
    [ctx.categories.get(paper.id), known.subjects, 0.2],
    [topicLabels, known.topics, 0.48],
    [authorLabels, known.authors, 0.32],
  ];
  let total = 0;
  let denominator = 0;
  for (const [labels, counts, importance] of groups) {
    if (!labels.length) continue;
    total += importance * labels.reduce((n, label) => n + 1 / Math.sqrt(1 + (counts.get(label) || 0)), 0) / labels.length;
    denominator += importance;
  }
  const score = total / (denominator || 1) - (known.ids.has(paper.id) ? 0.6 : 0);
  return {weight: Math.exp(4.5 * score), totalTopics: topicLabels.length,
    newTopics: topicLabels.filter(term => !known.topics.has(term)).length,
    totalAuthors: authorLabels.length, newAuthors: authorLabels.filter(id => !known.authors.has(id)).length};
}

function paperInfo(paper, ctx) {
  if (ctx.info.has(paper.id)) return ctx.info.get(paper.id);
  let detail = {weight: 1};
  if (ctx.mode === 'discovery' && ctx.encounters.ids.size) {
    detail = novelty(paper, ctx);
  } else if (ctx.hasPreference) {
    const prediction = predict(ctx.model, paper);
    const followed = ctx.useSubscriptions && ctx.matches(paper).length > 0;
    detail = {prediction, followed, weight: Math.exp(5 * ((prediction ?? 0.5) - 0.5)) * (followed ? 2 : 1)};
  }
  ctx.info.set(paper.id, detail);
  return detail;
}

function rankPool(items, ctx) {
  const n = items.length;
  const weights = items.map(paper => paperInfo(paper, ctx).weight);
  const equal = weights.every(weight => weight === weights[0]);
  const explore = ctx.mode === 'balanced' ? ctx.exploration : 0;
  const sum = weights.reduce((a, b) => a + b, 0);
  const flat = equal || explore === 1;
  const first = new Map(items.map((paper, i) => [paper.id, flat ? 1 / n : explore / n + (1 - explore) * weights[i] / sum]));
  const exploreBranch = explore === 1 || (!equal && explore > 0 && ctx.random.unit() < explore);
  let order;
  if (equal || exploreBranch) {
    order = shuffled(items, ctx.random);
  } else {
    // Independent exponential clocks generate a weighted permutation without replacement.
    order = items.map((paper, i) => ({paper, key: -Math.log(ctx.random.unit()) / weights[i]}))
      .sort((a, b) => a.key - b.key || compareIds(a.paper, b.paper)).map(item => item.paper);
  }
  return {order, first, flat, exploreBranch, count: n};
}

function describe(paper, category, ranking, ctx) {
  const where = category ? ' for ' + category : '';
  if (ctx.mode === 'random') {
    return 'Uniform random priorities' + where + ' among ' + ranking.count +
      ' eligible paper(s). Cross-listed papers are assigned to maximize distinct category coverage.';
  }
  if (ctx.mode === 'discovery') {
    if (!ctx.encounters.ids.size) return 'First discovery draw' + where + '. All eligible papers received uniform priorities.';
    const info = paperInfo(paper, ctx);
    return 'Discovery draw' + where + ' weighted by prior topic, category and author encounters. ' +
      info.newTopics + ' of ' + info.totalTopics + ' topic labels and ' + info.newAuthors + ' of ' +
      info.totalAuthors + ' author IDs or names were unseen.';
  }
  if (!ctx.hasPreference) return 'Cold-start draw' + where + '. Eligible papers received uniform priorities.';
  if (ctx.mode === 'balanced' && ranking.exploreBranch) return 'Uniform exploration draw' + where +
    ' among ' + ranking.count + ' eligible paper(s). Cross-listed papers are assigned to maximize coverage.';
  const info = paperInfo(paper, ctx);
  let text = (ctx.mode === 'personalized' ? 'Personalized draw' : 'Within-category draw') + where + '.';
  if (ctx.model?.sampleCount) {
    text += ' Weights use a local model trained on ' + ctx.model.sampleCount + ' active rating(s).';
    const term = interestEvidence(ctx.model, paper);
    if (term) text += ' Its strongest positive text association was “' + term + '”.';
  }
  if (info.followed) text += ' A followed-author match also increased its weight.';
  if (ctx.model?.sampleCount > 0 && ctx.model.sampleCount < 10) text += ' The training sample is small.';
  return text;
}

function matchedEntry(paper, code, ranking, ctx, probability) {
  return {paperId: paper.id, category: code, reason: describe(paper, code, ranking, ctx), probability};
}

function augment(code, visited, rankings, byPaper, byCategory) {
  for (const paper of rankings.get(code).order) {
    if (visited.has(paper.id)) continue;
    visited.add(paper.id);
    const previous = byPaper.get(paper.id);
    if (previous === undefined || augment(previous, visited, rankings, byPaper, byCategory)) {
      byPaper.set(paper.id, code);
      byCategory.set(code, paper);
      return true;
    }
  }
  return false;
}

function missingReason(code, ctx) {
  const candidates = ctx.byCategory.get(code);
  if (candidates.length) return 'All ' + candidates.length +
    ' eligible paper(s) represent other categories in this maximum-coverage matching.';
  const sections = ctx.availableSections.get(code);
  const disabled = [];
  if (sections.has('cross')) disabled.push('cross-submissions');
  if (sections.has('replacement')) disabled.push('replacements');
  if (disabled.length) return 'Only ' + disabled.join(' and ') + ' were found for this date. Their sections are disabled.';
  if (ctx.incomplete) return 'No eligible paper was found in the loaded part of this announcement.';
  return 'No eligible paper was found for this category on the announcement date.';
}

function categorySelection(ctx) {
  const rankings = new Map(CODES.map(code => [code, rankPool(ctx.byCategory.get(code), ctx)]));
  const order = shuffled(CODES.filter(code => rankings.get(code).count), ctx.random);
  const byPaper = new Map();
  const byCategory = new Map();
  for (const code of order) augment(code, new Set(), rankings, byPaper, byCategory);
  const entries = [];
  for (const code of order) {
    const paper = byCategory.get(code);
    if (!paper) continue;
    const ranking = rankings.get(code);
    const isolated = ctx.byCategory.get(code).every(candidate => ctx.categories.get(candidate.id).length === 1);
    // Matching changes the inclusion probabilities of overlapping candidates.
    entries.push(matchedEntry(paper, code, ranking, ctx, isolated ? ranking.first.get(paper.id) : null));
  }
  const missing = CODES.filter(code => !byCategory.has(code)).map(category =>
    ({category, reason: missingReason(category, ctx)}));
  return {entries, missing};
}

function coldPersonalized(ctx, count) {
  const base = categorySelection(ctx).entries;
  const initialCount = base.length;
  const assigned = new Set(base.map(entry => entry.paperId));
  let entries;
  if (count < initialCount) {
    entries = shuffled(base, ctx.random).slice(0, count);
  } else {
    const extra = shuffled(ctx.pool.filter(paper => !assigned.has(paper.id)), ctx.random).slice(0, count - initialCount);
    entries = [...base, ...extra.map(paper => ({paperId: paper.id, category: null, probability: null,
      reason: 'Uniform cold-start draw from the remaining papers after the available categories were represented.'}))];
  }
  return entries.map(entry => {
    let probability = null;
    if (count === ctx.pool.length) {
      probability = 1;
    } else {
      const [code, ...otherCodes] = ctx.categories.get(entry.paperId);
      const candidates = ctx.byCategory.get(code);
      if (!otherCodes.length && candidates.every(paper => ctx.categories.get(paper.id).length === 1)) {
        const initial = 1 / candidates.length;
        probability = count <= initialCount ? initial * count / initialCount :
          initial + (1 - initial) * (count - initialCount) / (ctx.pool.length - initialCount);
      }
    }
    return {...entry, probability};
  });
}

function personalized(ctx) {
  const count = Math.min(ctx.count, ctx.pool.length);
  if (!ctx.hasPreference) return coldPersonalized(ctx, count);
  const ranking = rankPool(ctx.pool, ctx);
  return ranking.order.slice(0, count).map(paper => {
    let probability = null;
    if (count === ctx.pool.length) probability = 1;
    else if (ranking.flat) probability = count / ctx.pool.length;
    else if (count === 1) probability = ranking.first.get(paper.id);
    return matchedEntry(paper, null, ranking, ctx, probability);
  });
}

function followedEntry(paper, ctx) {
  const names = ctx.matches(paper).map(match => match.name + (match.nameOnly ? ' (confirmed name-only match)' : ' (stable ID)'));
  return {paperId: paper.id, category: null, probability: 1, reason: 'Matches your subscription to ' + names.join(', ') + '.'};
}

function generateSelection(papers, options = {}) {
  const ctx = optionsFor(papers, options);
  const result = {mode: ctx.mode, date: ctx.date, seed: ctx.seed, entries: [], missing: []};
  switch (ctx.mode) {
    case 'original': return result;
    case 'subscriptions': result.entries = ctx.pool.filter(paper => ctx.matches(paper).length).map(paper => followedEntry(paper, ctx)); break;
    case 'personalized': result.entries = personalized(ctx); break;
    default: Object.assign(result, categorySelection(ctx));
  }
  return result;
}

function crossListedReplacement(selection, paperId, target, ctx) {
  const rankings = new Map();
  const byPaper = new Map();
  const byCategory = new Map();
  for (const entry of selection.entries) {
    if (!ctx.byCategory.has(entry.category)) return null;
    if (entry.paperId !== paperId) {
      const paper = ctx.byId.get(entry.paperId);
      if (!paper || !ctx.categories.get(paper.id).includes(entry.category)) return null;
      byPaper.set(paper.id, entry.category);
      byCategory.set(entry.category, paper);
    }
  }
  const retained = new Set(byPaper.keys());
  for (const {category} of selection.entries) {
    const ranking = rankPool(ctx.byCategory.get(category).filter(paper => paper.id !== paperId), ctx);
    // Prefer ending a path at an unused paper to unnecessary reassignment.
    ranking.order = [...ranking.order.filter(paper => !retained.has(paper.id)), ...ranking.order.filter(paper => retained.has(paper.id))];
    rankings.set(category, ranking);
  }
  if (!augment(target.category, new Set(), rankings, byPaper, byCategory)) return null;
  const added = [...byPaper.keys()].find(id => !retained.has(id));
  if (!added) return null;
  return selection.entries.map(entry => {
    const id = entry.paperId === paperId ? added : entry.paperId;
    const code = byPaper.get(id);
    if (id === entry.paperId && code === entry.category) return entry;
    const updated = matchedEntry(ctx.byId.get(id), code, rankings.get(code), ctx, null);
    return {...updated, reason: 'A cross-list reassignment preserved the represented categories. ' + updated.reason};
  });
}

function replaceSelectionPaper(selection, paperId, papers, options = {}) {
  const target = selection?.entries?.find(entry => entry.paperId === paperId);
  if (!target || selection.mode === 'original') return null;
  const ctx = optionsFor(papers, {...options, mode: selection.mode, date: selection.date,
    seed: options.seed ?? (String(selection.seed) + '|replace|' + paperId)});
  const selected = new Set(selection.entries.map(entry => entry.paperId));
  const quota = ['random', 'balanced', 'discovery'].includes(ctx.mode);
  const candidates = (quota ? ctx.byCategory.get(target.category) || [] : ctx.pool).filter(paper =>
    !selected.has(paper.id) && (ctx.mode !== 'subscriptions' || ctx.matches(paper).length));
  let entries;
  if (candidates.length) {
    const ranking = rankPool(candidates, ctx);
    const paper = ranking.order[0];
    const entry = ctx.mode === 'subscriptions' ? followedEntry(paper, ctx) :
      matchedEntry(paper, quota ? target.category : null, ranking, ctx, ranking.first.get(paper.id));
    if (ctx.mode === 'subscriptions') entry.probability = 1 / candidates.length;
    entries = selection.entries.map(old => old.paperId === paperId ? entry : old);
  } else if (quota) {
    entries = crossListedReplacement(selection, paperId, target, ctx);
  }
  return entries ? {...selection, entries, seed: ctx.seed} : null;
}

return {generateSelection,replaceSelectionPaper};
},
"src/ai.js": (__require) => {
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

class AIClient {
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
    const pendingKey = key + ':generation:' + generation;
    if (this.pending.has(pendingKey)) return this.pending.get(pendingKey);
    // Claim the key before awaiting cache access or another generation check.
    // Otherwise two simultaneous cache misses can both start inference.
    const work = (async () => {
      const saved = await this.cacheGet(key);
      const age = Date.now() - saved?.savedAt;
      const cacheAgeLimit = !paper.version ? MAX_UNKNOWN_VERSION_AGE : saved?.source?.kind === 'abstract' ? 86400000 : Infinity;
      if (saved && age >= 0 && age < cacheAgeLimit) {
        try { return { ...checkResult(saved, paper), cached: true }; } catch { /* Replace invalid imported cache entries. */ }
      }
      if (!limits.dailyRequests || (provider === 'openai' && !limits.dailyBudget)) {
        throw new Error('The configured daily AI allowance is zero.');
      }
      if (generation !== await this.getGeneration()) throw new Error('Saved data changed while preparing this request. Please request the explanation again.');
      return this.send(origin, ai.token, { ...prompt, limits, progress: provider === "local" }, key, generation, timeout, options.onProgress);
    })();
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

return {AIClient};
},
"src/dom.js": (__require) => {
const {mathFragment} = __require("src/math.js");

function element(tag,attrs={},...children) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs||{})) {
    if(value===null||value===undefined||value===false) continue;
    if(key==='class') node.className=value;
    else if(key==='text') node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function') node.addEventListener(key.slice(2),value);
    else if(key==='checked'||key==='disabled'||key==='selected'||key==='open') node[key]=Boolean(value);
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity)) if(child!==null&&child!==undefined&&child!==false) node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
function safeURL(value,base='https://arxiv.org') {
  try {const url=new URL(value,base);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;} catch {return null;}
}
function link(text,url) {
  const clean=safeURL(url);return clean?element('a',{href:clean,target:'_blank',rel:'noopener noreferrer'},text):element('span',{},text);
}
function field(label,input,help='') {
  const id=`ad-input-${Math.random().toString(36).slice(2)}`;input.id=id;
  return element('div',{class:'field'},element('label',{for:id},label),input,help?element('small',{},help):null);
}
function select(options,value,change) {
  return element('select',{onchange:change},options.map(([id,label])=>element('option',{value:id,selected:String(id)===String(value)},label)));
}
function checkbox(label,value,onchange) {
  const input=element('input',{type:'checkbox',checked:value,onchange});
  return element('label',{class:'check'},input,element('span',{},label));
}
function richText(paper,fieldName) {
  const span=element('span');const text=String(paper[fieldName]||'');let cursor=0;
  for(const item of paper.inlineLinks?.[fieldName]||[]) {
    if(!Number.isInteger(item.start)||!Number.isInteger(item.end)||item.start<cursor||item.end>text.length||item.end<=item.start) continue;
    span.append(mathFragment(document,text.slice(cursor,item.start)),link(mathFragment(document,text.slice(item.start,item.end)),item.url));cursor=item.end;
  }
  span.append(mathFragment(document,text.slice(cursor)));return span;
}
const STYLES = `
:host{color-scheme:light dark;--bg:#fff;--fg:#252525;--muted:#626262;--line:#d9d4cc;--soft:#f8f7f4;--accent:#8b1e28;--link:#174e7a;color:var(--fg);font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;display:block;}
:host([data-theme=dark]){--bg:#202124;--fg:#ededed;--muted:#b9b9b9;--line:#515359;--soft:#292b30;--accent:#f2a2ac;--link:#a7cafa;}
@media(prefers-color-scheme:dark){:host([data-theme=auto]){--bg:#202124;--fg:#ededed;--muted:#b9b9b9;--line:#515359;--soft:#292b30;--accent:#f2a2ac;--link:#a7cafa;}}
*{box-sizing:border-box}button,input,select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:5px 8px}button{cursor:pointer;min-height:30px}button:hover{border-color:var(--accent);background:var(--soft)}button[aria-pressed=true]{background:var(--soft);border-color:var(--accent);color:var(--accent);font-weight:bold}button:disabled{opacity:.6;cursor:wait}a{color:var(--link)}a:hover{text-decoration:underline}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}h2{font-size:21px;margin:0}h3{font-size:17px;margin:16px 0 8px}p{margin:8px 0}small,.muted{color:var(--muted);font-size:12px}.toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:9px 0;margin:12px 0;background:var(--bg)}.brand{font-family:Georgia,serif;font-weight:bold;color:var(--accent);margin-right:5px}.status{width:100%;color:var(--muted);font-size:12px}.tools{margin:5px 0 12px;font-size:12px}.tools summary{cursor:pointer;display:list-item;color:var(--link);max-width:max-content}.actions{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.actions button{font-size:12px}.notice{padding:10px 12px;background:var(--soft);border-left:3px solid var(--accent);margin:10px 0}.error{border-left-color:#bd3030}.pill{display:inline-block;border:1px solid var(--line);padding:2px 5px;margin:0 5px 4px 0;font-size:11px;border-radius:3px}dialog{padding:0;border:1px solid var(--line);border-radius:5px;color:var(--fg);background:var(--bg);width:min(940px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:88vh;box-shadow:0 8px 40px #0003}dialog::backdrop{background:#0004}.dialog-header{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}.dialog-body{padding:4px 20px 20px;overflow-wrap:anywhere}.card{padding:16px 0;border-bottom:1px solid var(--line)}.card h3{margin:3px 0 5px;font-family:Georgia,'Times New Roman',serif;line-height:1.35}.card:last-child{border-bottom:0}.authors{font-size:13px}.authors button{font-size:11px;min-height:22px;padding:1px 5px;margin:0 5px 3px}.abstract{white-space:pre-wrap;font-family:Georgia,'Times New Roman',serif;line-height:1.55}.feedback-reason{font-size:12px;max-width:260px}.field{margin:12px 0}.field label{display:block;font-weight:bold;margin-bottom:4px}.field small{display:block;margin-top:4px}.field input,.field select,.field textarea{max-width:100%}.field input:not([type=checkbox]),.field select{min-width:170px}.field textarea{width:100%;min-height:80px}.check{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.check input{margin-top:4px}.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 24px}.tabular{width:100%;border-collapse:collapse;font-size:12px}.tabular th,.tabular td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}.tabular th{background:var(--soft)}.table-wrap{overflow-x:auto}.answer{white-space:pre-wrap;line-height:1.6;font-family:Georgia,'Times New Roman',serif}.source{font-size:12px;border-bottom:1px solid var(--line);padding-bottom:8px}.end{font-family:Georgia,serif;text-align:center;margin:20px 0;color:var(--muted)}.toolbar button{font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.spacer{flex:1}.danger{color:#b32323}.dictionary-select{position:fixed;z-index:2147483646;max-width:240px;background:var(--bg);border:1px solid var(--line);padding:5px;box-shadow:0 2px 12px #0003}.help-key{font-family:monospace;background:var(--soft);padding:1px 4px}.version{font-size:11px;color:var(--muted)}@media(max-width:600px){.dialog-header{padding:12px}.dialog-body{padding:4px 12px 16px}.toolbar{gap:4px}.columns{display:block}.tabular{font-size:11px}dialog{max-height:94vh;width:calc(100vw - 16px);max-width:calc(100vw - 16px)}}
`;

return {element,safeURL,link,field,select,checkbox,richText,STYLES};
},
"src/math.js": (__require) => {
const {temml} = __require("vendor/temml.js");

const NS = 'http://www.w3.org/1998/Math/MathML';
const MAX_FIELD = 96_000;
const MAX_FORMULA = 4_096;
const MAX_FORMULAS = 96;
const MAX_NODES = 1_200;
const MAX_DEPTH = 64;
const endOf = new Map([['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]);

function escaped(text, index) {
  let start = index;
  while (start && text[start - 1] === '\\') start--;
  return (index - start) % 2 === 1;
}

// Keep the delimiters in each source slice so any unsupported formula can be
// returned byte for byte. Do not treat a dollar sign followed by space as an opener.
function mathParts(text) {
  if (text.length > MAX_FIELD) return [{text}];
  const parts = [];
  const delimiters = /\$\$?|\\[()[\]]/g;
  let opening = null;
  let cursor = 0;
  let count = 0;
  for (const match of text.matchAll(delimiters)) {
    const token = match[0];
    const index = match.index;
    if (escaped(text, index)) continue;
    if (opening && endOf.get(opening.token) === token) {
      if (token === '$' && (/\s/.test(text[index - 1]) || /[0-9]/.test(text[index + 1] || ''))) {
        if (text[index + 1] && !/\s/.test(text[index + 1])) opening = {index, token};
        continue;
      }
      const end = index + token.length;
      const tex = text.slice(opening.index + opening.token.length, index);
      if (tex.trim() && tex.length <= MAX_FORMULA) {
        if (cursor < opening.index) parts.push({text:text.slice(cursor, opening.index)});
        parts.push({text:text.slice(opening.index, end), tex, display:['$$', '\\['].includes(opening.token)});
        cursor = end;
        if (++count === MAX_FORMULAS) break;
      }
      opening = null;
    } else if (endOf.has(token) && (!opening || token === '\\(' || token === '\\[' || token === '$$')) {
      if (token === '$' && (!text[index + 1] || /\s/.test(text[index + 1]))) continue;
      opening = {index, token};
    }
  }
  if (cursor < text.length || parts.length === 0) parts.push({text:text.slice(cursor)});
  return parts;
}

const tags = new Set(('math semantics annotation mrow mi mn mo mtext mspace ms ' +
  'mfrac msqrt mroot mstyle merror mphantom mpadded menclose msub msup msubsup ' +
  'munder mover munderover mmultiscripts mprescripts none mtable mtr mtd').split(' '));
const flagAttrs = new Set(('stretchy fence separator symmetric movablelimits largeop ' +
  'accent accentunder displaystyle bevelled').split(' '));
const metricAttrs = new Set('width height depth lspace rspace minsize maxsize linethickness voffset'.split(' '));
const metricStyles = new Set('padding paddingLeft paddingRight paddingTop paddingBottom verticalAlign width height'.split(' '));
const dimension = /^(?:0|[+-]?(?:\d{1,2}(?:\.\d{1,5})?|\.\d{1,5})(?:em|ex|px|pt)|100%|50%)$/;
const plainClasses = /^(?:mathcal|tml-(?:display|prime|(?:sml|med|lrg)-pad|(?:hat|tilde)-[1-4]|jot|small)|(?:chr|wbk)-(?:sml|med|lrg|acc)(?:-acc|-vec)?)$/;
const values = new Map([
  ['display', /^(?:inline|block)$/], ['form', /^(?:prefix|infix|postfix)$/],
  ['mathvariant', /^(?:normal|bold|italic|bold-italic|double-struck|bold-fraktur|script|bold-script|fraktur|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace)$/],
  ['scriptlevel', /^[+-]?[0-6]$/], ['notation', /^(?:top|bottom)$/],
  ['rowspan', /^[1-9][0-9]?$/], ['columnspan', /^[1-9][0-9]?$/],
  ['columnalign', /^(?:left|center|right)$/], ['rowalign', /^(?:top|bottom|center|baseline|axis)$/],
  ['encoding', /^application\/x-tex$/]
]);

function copyAttributes(element, node) {
  for (const [name, raw] of Object.entries(node.attributes || {})) {
    const value = String(raw);
    if (name === 'xmlns' && value === NS) continue;
    const validator = flagAttrs.has(name) ? /^(?:true|false)$/ : metricAttrs.has(name) ? dimension : values.get(name);
    if (!validator?.test(value)) throw new Error('Unsupported math attribute');
    element.setAttribute(name, value);
  }
  for (const [name, raw] of Object.entries(node.style || {})) {
    const value = String(raw);
    if (name === 'display' && value === 'block math') continue;
    if (name === 'mathDepth' && /^[+-]?[0-6]$/.test(value)) { element.style.mathDepth = value; continue; }
    if (!metricStyles.has(name) || !dimension.test(value)) throw new Error('Unsupported math style');
    element.style[name] = value;
  }
  for (const name of node.classes || []) {
    if (plainClasses.test(name)) continue;
    if (name === 'tml-left' || name === 'tml-right') element.style.textAlign = name.slice(4);
    else if (name === 'tml-overline') element.style.borderTop = '0.065em solid currentColor';
    else if (name === 'tml-underline') element.style.borderBottom = '0.065em solid currentColor';
    else throw new Error('Math layout requires extra fonts or styling');
  }
}

function copyTree(doc, node, budget, depth = 0) {
  if (!node || ++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Math layout limit');
  if (!node.type && Object.hasOwn(node, 'text') && typeof node.text === 'string') return doc.createTextNode(node.text);
  // Temml can group infix expressions in a transparent document fragment.
  if (!node.type && Array.isArray(node.children) && !node.attributes && !node.classes?.length &&
      !Object.keys(node.style || {}).length) {
    const fragment = doc.createDocumentFragment();
    for (const child of node.children) fragment.append(copyTree(doc, child, budget, depth + 1));
    return fragment;
  }
  if (!tags.has(node.type) || !Array.isArray(node.children)) throw new Error('Unsupported math element');
  const element = doc.createElementNS(NS, node.type);
  copyAttributes(element, node);
  for (const child of node.children) element.append(copyTree(doc, child, budget, depth + 1));
  return element;
}

// Only insert newly created text and MathML nodes. The pinned renderer returns
// its abstract tree. Neither the paper nor the renderer supplies live markup.
function mathFragment(doc, value) {
  const fragment = doc.createDocumentFragment();
  for (const part of mathParts(String(value ?? ''))) {
    if (part.tex !== undefined) {
      try {
        const tree = temml.__renderToMathMLTree(part.tex, {
          displayMode:part.display, annotate:true, throwOnError:true, strict:true, trust:false,
          maxExpand:250, maxSize:[12, 72], macros:Object.create(null)
        });
        if (tree.type !== 'math') throw new Error('Unexpected renderer output');
        fragment.append(copyTree(doc, tree, {nodes:0}));
        continue;
      } catch {
        // A custom command, unfamiliar layout, or unusually large expression
        // keeps its exact readable source, including the delimiters.
      }
    }
    fragment.append(doc.createTextNode(part.text));
  }
  return fragment;
}

return {mathParts,mathFragment};
},
"vendor/temml.js": (__require) => {
var temml=function(){"use strict";class e{constructor(t,r){let n,s=" "+t;const o=r&&r.loc;if(o&&o.start<=o.end){const e=o.lexer.input;n=o.start;const t=o.end;n===e.length?s+=" at end of input: ":s+=" at position "+(n+1)+": \n";const r=e.slice(n,t).replace(/[^]/g,"$&̲");let a,l;a=n>15?"…"+e.slice(n-15,n):e.slice(0,n),l=t+15<e.length?e.slice(t,t+15)+"…":e.slice(t),s+=a+r+l}const a=new Error(s);return a.name="ParseError",a.__proto__=e.prototype,a.position=n,a}}e.prototype.__proto__=Error.prototype;const t=function(e,t,r){if(!Object.prototype.hasOwnProperty.call(e,t))return r;const n=e[t];return void 0===n?r:n},r=/([A-Z])/g,n=function(e){return e.replace(r,"-$1").toLowerCase()},s={"&":"&amp;",">":"&gt;","<":"&lt;",'"':"&quot;","'":"&#x27;"},o=/[&><"']/g;function a(e){return String(e).replace(o,e=>s[e])}const l=function(e){return"ordgroup"===e.type||"color"===e.type?1===e.body.length?l(e.body[0]):e:"font"===e.type?l(e.body):e},i=function(e){const t=l(e);return"mathord"===t.type||"textord"===t.type||"atom"===t.type},c=function(e){return+e.toFixed(4)},m="acegıȷmnopqrsuvwxyzαγεηικμνοπρςστυχωϕ𝐚𝐜𝐞𝐠𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐮𝐯𝐰𝐱𝐲𝐳",p=["__proto__","prototype","constructor"];class u{constructor(e){e=e||{},this.displayMode=t(e,"displayMode",!1),this.annotate=t(e,"annotate",!1),this.leqno=t(e,"leqno",!1),this.throwOnError=t(e,"throwOnError",!1),this.errorColor=t(e,"errorColor","#b22222"),this.macros=(e=>{if(null==e||"object"!=typeof e)return Object.create(null);for(const t of p)Object.prototype.hasOwnProperty.call(e,t)&&delete e[t];return Object.setPrototypeOf(e,null)})(Object.prototype.hasOwnProperty.call(e,"macros")?e.macros:void 0),this.wrap=t(e,"wrap","none"),this.xml=t(e,"xml",!1),this.colorIsTextColor=t(e,"colorIsTextColor",!1),this.strict=t(e,"strict",!1),this.trust=t(e,"trust",!1);const r=Object.prototype.hasOwnProperty.call(e,"maxSize")?e.maxSize:void 0;this.maxSize=void 0===r?[1/0,1/0]:Array.isArray(r)?r:[1/0,1/0],this.maxExpand=Math.max(0,t(e,"maxExpand",1e3)),this.wrapDelimiterPairs=!0}isTrusted(e){if(e.url&&!e.protocol){const t=function(e){const t=/^[\x00-\x20]*([^\\/#?]*?)(:|&#0*58|&#x0*3a|&colon)/i.exec(e);return t?":"!==t[2]?null:/^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(t[1])?t[1].toLowerCase():null:"_relative"}(e.url);if(null==t)return!1;e.protocol=t}const t="function"==typeof this.trust?this.trust(e):this.trust;return Boolean(t)}}const d={},h={};function g({type:e,names:t,props:r,handler:n,mathmlBuilder:s}){const o={type:e,numArgs:r.numArgs,argTypes:r.argTypes,allowedInArgument:!!r.allowedInArgument,allowedInText:!!r.allowedInText,allowedInMath:void 0===r.allowedInMath||r.allowedInMath,numOptionalArgs:r.numOptionalArgs||0,infix:!!r.infix,primitive:!!r.primitive,handler:n};for(let e=0;e<t.length;++e)d[t[e]]=o;e&&s&&(h[e]=s)}function f({type:e,mathmlBuilder:t}){g({type:e,names:[],props:{numArgs:0},handler(){throw new Error("Should never be called.")},mathmlBuilder:t})}const b=function(e){return"ordgroup"===e.type&&1===e.body.length?e.body[0]:e},y=function(e){return"ordgroup"===e.type?e.body:[e]};class w{constructor(e){this.children=e,this.classes=[],this.style={}}hasClass(e){return this.classes.includes(e)}toNode(){const e=document.createDocumentFragment();for(let t=0;t<this.children.length;t++)e.appendChild(this.children[t].toNode());return e}toMarkup(){let e="";for(let t=0;t<this.children.length;t++)e+=this.children[t].toMarkup();return e}toText(){return this.children.map(e=>e.toText()).join("")}}const x=function(e){return e.filter(e=>e).join(" ")},k=function(e,t){this.classes=e||[],this.attributes={},this.style=t||{}},v=function(e){const t=document.createElement(e);t.className=x(this.classes);for(const e in this.style)Object.prototype.hasOwnProperty.call(this.style,e)&&(t.style[e]=this.style[e]);for(const e in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,e)&&t.setAttribute(e,this.attributes[e]);for(let e=0;e<this.children.length;e++)t.appendChild(this.children[e].toNode());return t},A=function(e){let t=`<${e}`;this.classes.length&&(t+=` class="${a(x(this.classes))}"`);let r="";for(const e in this.style)Object.prototype.hasOwnProperty.call(this.style,e)&&(r+=`${n(e)}:${this.style[e]};`);r&&(t+=` style="${r}"`);for(const e in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,e)&&(t+=` ${e}="${a(this.attributes[e])}"`);t+=">";for(let e=0;e<this.children.length;e++)t+=this.children[e].toMarkup();return t+=`</${e}>`,t};class T{constructor(e,t,r){k.call(this,e,r),this.children=t||[]}setAttribute(e,t){this.attributes[e]=t}toNode(){return v.call(this,"span")}toMarkup(){return A.call(this,"span")}}let S=class{constructor(e){this.text=e}toNode(){return document.createTextNode(this.text)}toMarkup(){return a(this.text)}};class O{constructor(e,t,r){this.href=e,this.classes=t,this.children=r||[]}toNode(){const e=document.createElement("a");e.setAttribute("href",this.href),this.classes.length>0&&(e.className=x(this.classes));for(let t=0;t<this.children.length;t++)e.appendChild(this.children[t].toNode());return e}toMarkup(){let e=`<a href='${a(this.href)}'`;this.classes.length>0&&(e+=` class="${a(x(this.classes))}"`),e+=">";for(let t=0;t<this.children.length;t++)e+=this.children[t].toMarkup();return e+="</a>",e}}class q{constructor(e,t,r){this.alt=t,this.src=e,this.classes=["mord"],this.style=r}hasClass(e){return this.classes.includes(e)}toNode(){const e=document.createElement("img");e.src=this.src,e.alt=this.alt,e.className="mord";for(const t in this.style)Object.prototype.hasOwnProperty.call(this.style,t)&&(e.style[t]=this.style[t]);return e}toMarkup(){let e=`<img src='${this.src}' alt='${this.alt}'`,t="";for(const e in this.style)Object.prototype.hasOwnProperty.call(this.style,e)&&(t+=`${n(e)}:${this.style[e]};`);return t&&(e+=` style="${a(t)}"`),e+=">",e}}function B(e){return new w(e)}class C{constructor(e,t,r,n){this.type=e,this.attributes={},this.children=t||[],this.classes=r||[],this.style=n||{},this.label=""}setAttribute(e,t){this.attributes[e]=t}getAttribute(e){return this.attributes[e]}setLabel(e){this.label=e}toNode(){const e=document.createElementNS("http://www.w3.org/1998/Math/MathML",this.type);for(const t in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,t)&&e.setAttribute(t,this.attributes[t]);this.classes.length>0&&(e.className=x(this.classes));for(const t in this.style)Object.prototype.hasOwnProperty.call(this.style,t)&&(e.style[t]=this.style[t]);for(let t=0;t<this.children.length;t++)e.appendChild(this.children[t].toNode());return e}toMarkup(){let e="<"+this.type;for(const t in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,t)&&(e+=" "+t+'="',e+=a(this.attributes[t]),e+='"');this.classes.length>0&&(e+=` class="${a(x(this.classes))}"`);let t="";for(const e in this.style)Object.prototype.hasOwnProperty.call(this.style,e)&&(t+=`${n(e)}:${this.style[e]};`);t&&(e+=` style="${t}"`),e+=">";for(let t=0;t<this.children.length;t++)e+=this.children[t].toMarkup();return e+="</"+this.type+">",e}toText(){return this.children.map(e=>e.toText()).join("")}}class N{constructor(e){this.text=e}toNode(){return document.createTextNode(this.text)}toMarkup(){return a(this.toText())}toText(){return this.text}}const z=e=>{let t;return 1===e.length&&"mrow"===e[0].type?(t=e.pop(),t.type="mstyle"):t=new C("mstyle",e),t},$=e=>{let t=0;if(e.body&&Array.isArray(e.body))for(const r of e.body)t+=$(r);else if(e.body)t+=$(e.body);else if("supsub"===e.type)t+=$(e.base),e.sub&&(t+=.7*$(e.sub)),e.sup&&(t+=.7*$(e.sup));else if("mathord"===e.type||"textord"===e.type)for(const r of e.text.split("")){const e=r.codePointAt(0);t+=96<e&&e<123||944<e&&e<970?.56:47<e&&e<58?.5:.92}else t+=1;return t},E={widehat:"ˆ",widecheck:"ˇ",widetilde:"~",wideparen:"⏜",utilde:"~",overleftarrow:"←",underleftarrow:"←",xleftarrow:"←",overrightarrow:"→",underrightarrow:"→",xrightarrow:"→",underbrace:"⏟",overbrace:"⏞",overbracket:"⎴",underbracket:"⎵",overgroup:"⏠",overparen:"⏜",undergroup:"⏡",underparen:"⏝",overleftrightarrow:"↔",underleftrightarrow:"↔",xleftrightarrow:"↔",Overrightarrow:"⇒",xRightarrow:"⇒",overleftharpoon:"↼",xleftharpoonup:"↼",overrightharpoon:"⇀",xrightharpoonup:"⇀",xLeftarrow:"⇐",xLeftrightarrow:"⇔",xhookleftarrow:"↩",xhookrightarrow:"↪",xmapsto:"↦",xrightharpoondown:"⇁",xleftharpoondown:"↽",xtwoheadleftarrow:"↞",xtwoheadrightarrow:"↠",xlongequal:"=",xrightleftarrows:"⇄",xtofrom:"⇄",xleftrightharpoons:"⇋",xrightleftharpoons:"⇌",yields:"→",yieldsLeft:"←",mesomerism:"↔",longrightharpoonup:"⇀",longleftharpoondown:"↽",eqrightharpoonup:"⇀",eqleftharpoondown:"↽","\\cdrightarrow":"→","\\cdleftarrow":"←","\\cdlongequal":"=",yieldsLeftRight:"⇄",chemequilibrium:"⇌"},I=function(e){const t=new N(E[e.slice(1)]),r=new C("mo",[t]);return r.setAttribute("stretchy","true"),r},L=["\\widehat","\\widecheck"],F=e=>{const t=I(e.label);if(e.label.indexOf("tilde")>-1){const r=$(e.base);1<r&&r<1.6?t.classes.push("tml-tilde-2"):1.6<=r&&r<2.5?t.classes.push("tml-tilde-3"):2.5<=r&&t.classes.push("tml-tilde-4")}else if(L.includes(e.label)){const r=$(e.base);0<r&&r<=1?t.classes.push("tml-hat-1"):1<r&&r<1.6?t.classes.push("tml-hat-2"):1.6<=r&&r<2.5?t.classes.push("tml-hat-3"):2.5<=r&&t.classes.push("tml-hat-4")}return t},j={bin:1,close:1,inner:1,open:1,punct:1,rel:1},M={"accent-token":1,mathord:1,"op-token":1,spacing:1,textord:1},D=Object.create(null);function G(e,t,r,n,s){if("math"!==e&&"text"!==e)throw new TypeError(`Invalid mode: ${e} called in defineSymbol`);const o={group:t,replace:r};D[e][n]=o,s&&r&&(D[e][r]=o)}D.math=Object.create(null),D.text=Object.create(null);const P="math",R="text",U="accent-token",H="bin",_="close",V="inner",W="mathord",X="op-token",Z="open",Y="punct",J="rel",K="spacing",Q="textord";G(P,J,"≡","\\equiv",!0),G(P,J,"≺","\\prec",!0),G(P,J,"≻","\\succ",!0),G(P,J,"∼","\\sim",!0),G(P,J,"⟂","\\perp",!0),G(P,J,"⪯","\\preceq",!0),G(P,J,"⪰","\\succeq",!0),G(P,J,"≃","\\simeq",!0),G(P,J,"≌","\\backcong",!0),G(P,J,"|","\\mid",!0),G(P,J,"≪","\\ll",!0),G(P,J,"≫","\\gg",!0),G(P,J,"≍","\\asymp",!0),G(P,J,"∥","\\parallel"),G(P,J,"⌣","\\smile",!0),G(P,J,"⊑","\\sqsubseteq",!0),G(P,J,"⊒","\\sqsupseteq",!0),G(P,J,"≐","\\doteq",!0),G(P,J,"⌢","\\frown",!0),G(P,J,"∋","\\ni",!0),G(P,J,"∌","\\notni",!0),G(P,J,"∝","\\propto",!0),G(P,J,"⊢","\\vdash",!0),G(P,J,"⊣","\\dashv",!0),G(P,J,"∋","\\owns"),G(P,J,"≘","\\arceq",!0),G(P,J,"≙","\\wedgeq",!0),G(P,J,"≚","\\veeeq",!0),G(P,J,"≛","\\stareq",!0),G(P,J,"≝","\\eqdef",!0),G(P,J,"≞","\\measeq",!0),G(P,J,"≟","\\questeq",!0),G(P,J,"≠","\\ne",!0),G(P,J,"≠","\\neq"),G(P,J,"⩵","\\eqeq",!0),G(P,J,"⩶","\\eqeqeq",!0),G(P,J,"∷","\\dblcolon",!0),G(P,J,"≔","\\coloneqq",!0),G(P,J,"≕","\\eqqcolon",!0),G(P,J,"∹","\\eqcolon",!0),G(P,J,"⩴","\\Coloneqq",!0),G(P,Y,".","\\ldotp"),G(P,Y,"·","\\cdotp"),G(P,Q,"#","\\#"),G(R,Q,"#","\\#"),G(P,Q,"&","\\&"),G(R,Q,"&","\\&"),G(P,Q,"ℵ","\\aleph",!0),G(P,Q,"∀","\\forall",!0),G(P,Q,"ℏ","\\hbar",!0),G(P,Q,"∃","\\exists",!0),G(P,Z,"∇","\\nabla",!0),G(P,Q,"♭","\\flat",!0),G(P,Q,"ℓ","\\ell",!0),G(P,Q,"♮","\\natural",!0),G(P,Q,"Å","\\Angstrom",!0),G(R,Q,"Å","\\Angstrom",!0),G(P,Q,"♣","\\clubsuit",!0),G(P,Q,"♧","\\varclubsuit",!0),G(P,Q,"℘","\\wp",!0),G(P,Q,"♯","\\sharp",!0),G(P,Q,"♢","\\diamondsuit",!0),G(P,Q,"♦","\\vardiamondsuit",!0),G(P,Q,"ℜ","\\Re",!0),G(P,Q,"♡","\\heartsuit",!0),G(P,Q,"♥","\\varheartsuit",!0),G(P,Q,"ℑ","\\Im",!0),G(P,Q,"♠","\\spadesuit",!0),G(P,Q,"♤","\\varspadesuit",!0),G(P,Q,"♀","\\female",!0),G(P,Q,"♂","\\male",!0),G(P,Q,"§","\\S",!0),G(R,Q,"§","\\S"),G(P,Q,"¶","\\P",!0),G(R,Q,"¶","\\P"),G(R,Q,"☺","\\smiley",!0),G(P,Q,"☺","\\smiley",!0),G(P,Q,"†","\\dag"),G(R,Q,"†","\\dag"),G(R,Q,"†","\\textdagger"),G(P,Q,"‡","\\ddag"),G(R,Q,"‡","\\ddag"),G(R,Q,"‡","\\textdaggerdbl"),G(P,_,"⎱","\\rmoustache",!0),G(P,Z,"⎰","\\lmoustache",!0),G(P,_,"⟯","\\rgroup",!0),G(P,Z,"⟮","\\lgroup",!0),G(P,H,"∓","\\mp",!0),G(P,H,"⊖","\\ominus",!0),G(P,H,"⊎","\\uplus",!0),G(P,H,"⊓","\\sqcap",!0),G(P,H,"∗","\\ast"),G(P,H,"⊔","\\sqcup",!0),G(P,H,"◯","\\bigcirc",!0),G(P,H,"∙","\\bullet",!0),G(P,H,"‡","\\ddagger"),G(P,H,"≀","\\wr",!0),G(P,H,"⨿","\\amalg"),G(P,H,"&","\\And"),G(P,H,"⫽","\\sslash",!0),G(P,J,"⟵","\\longleftarrow",!0),G(P,J,"⇐","\\Leftarrow",!0),G(P,J,"⟸","\\Longleftarrow",!0),G(P,J,"⟶","\\longrightarrow",!0),G(P,J,"⇒","\\Rightarrow",!0),G(P,J,"⟹","\\Longrightarrow",!0),G(P,J,"↔","\\leftrightarrow",!0),G(P,J,"⟷","\\longleftrightarrow",!0),G(P,J,"⇔","\\Leftrightarrow",!0),G(P,J,"⟺","\\Longleftrightarrow",!0),G(P,J,"↤","\\mapsfrom",!0),G(P,J,"↦","\\mapsto",!0),G(P,J,"⟼","\\longmapsto",!0),G(P,J,"↗","\\nearrow",!0),G(P,J,"↩","\\hookleftarrow",!0),G(P,J,"↪","\\hookrightarrow",!0),G(P,J,"↘","\\searrow",!0),G(P,J,"↼","\\leftharpoonup",!0),G(P,J,"⇀","\\rightharpoonup",!0),G(P,J,"↙","\\swarrow",!0),G(P,J,"↽","\\leftharpoondown",!0),G(P,J,"⇁","\\rightharpoondown",!0),G(P,J,"↖","\\nwarrow",!0),G(P,J,"⇌","\\rightleftharpoons",!0),G(P,W,"↯","\\lightning",!0),G(P,W,"∎","\\QED",!0),G(P,W,"‰","\\permil",!0),G(R,Q,"‰","\\permil"),G(P,W,"☉","\\astrosun",!0),G(P,W,"☼","\\sun",!0),G(P,W,"☾","\\leftmoon",!0),G(P,W,"☽","\\rightmoon",!0),G(P,W,"⊕","\\Earth"),G(P,J,"≮","\\nless",!0),G(P,J,"⪇","\\lneq",!0),G(P,J,"≨","\\lneqq",!0),G(P,J,"≨︀","\\lvertneqq"),G(P,J,"⋦","\\lnsim",!0),G(P,J,"⪉","\\lnapprox",!0),G(P,J,"⊀","\\nprec",!0),G(P,J,"⋠","\\npreceq",!0),G(P,J,"⋨","\\precnsim",!0),G(P,J,"⪹","\\precnapprox",!0),G(P,J,"≁","\\nsim",!0),G(P,J,"∤","\\nmid",!0),G(P,J,"∤","\\nshortmid"),G(P,J,"⊬","\\nvdash",!0),G(P,J,"⊭","\\nvDash",!0),G(P,J,"⋪","\\ntriangleleft"),G(P,J,"⋬","\\ntrianglelefteq",!0),G(P,J,"⊄","\\nsubset",!0),G(P,J,"⊅","\\nsupset",!0),G(P,J,"⊊","\\subsetneq",!0),G(P,J,"⊊︀","\\varsubsetneq"),G(P,J,"⫋","\\subsetneqq",!0),G(P,J,"⫋︀","\\varsubsetneqq"),G(P,J,"≯","\\ngtr",!0),G(P,J,"⪈","\\gneq",!0),G(P,J,"≩","\\gneqq",!0),G(P,J,"≩︀","\\gvertneqq"),G(P,J,"⋧","\\gnsim",!0),G(P,J,"⪊","\\gnapprox",!0),G(P,J,"⊁","\\nsucc",!0),G(P,J,"⋡","\\nsucceq",!0),G(P,J,"⋩","\\succnsim",!0),G(P,J,"⪺","\\succnapprox",!0),G(P,J,"≆","\\ncong",!0),G(P,J,"∦","\\nparallel",!0),G(P,J,"∦","\\nshortparallel"),G(P,J,"⊯","\\nVDash",!0),G(P,J,"⋫","\\ntriangleright"),G(P,J,"⋭","\\ntrianglerighteq",!0),G(P,J,"⊋","\\supsetneq",!0),G(P,J,"⊋","\\varsupsetneq"),G(P,J,"⫌","\\supsetneqq",!0),G(P,J,"⫌︀","\\varsupsetneqq"),G(P,J,"⊮","\\nVdash",!0),G(P,J,"⪵","\\precneqq",!0),G(P,J,"⪶","\\succneqq",!0),G(P,H,"⊴","\\unlhd"),G(P,H,"⊵","\\unrhd"),G(P,J,"↚","\\nleftarrow",!0),G(P,J,"↛","\\nrightarrow",!0),G(P,J,"⇍","\\nLeftarrow",!0),G(P,J,"⇏","\\nRightarrow",!0),G(P,J,"↮","\\nleftrightarrow",!0),G(P,J,"⇎","\\nLeftrightarrow",!0),G(P,J,"△","\\vartriangle"),G(P,Q,"ℏ","\\hslash"),G(P,Q,"▽","\\triangledown"),G(P,Q,"◊","\\lozenge"),G(P,Q,"Ⓢ","\\circledS"),G(P,Q,"®","\\circledR",!0),G(R,Q,"®","\\circledR"),G(R,Q,"®","\\textregistered"),G(P,Q,"∡","\\measuredangle",!0),G(P,Q,"∄","\\nexists"),G(P,Q,"℧","\\mho"),G(P,Q,"Ⅎ","\\Finv",!0),G(P,Q,"⅁","\\Game",!0),G(P,Q,"‵","\\backprime"),G(P,Q,"‶","\\backdprime"),G(P,Q,"‷","\\backtrprime"),G(P,Q,"▲","\\blacktriangle"),G(P,Q,"▼","\\blacktriangledown"),G(P,Q,"■","\\blacksquare"),G(P,Q,"⧫","\\blacklozenge"),G(P,Q,"★","\\bigstar"),G(P,Q,"∢","\\sphericalangle",!0),G(P,Q,"∁","\\complement",!0),G(P,Q,"╱","\\diagup"),G(P,Q,"╲","\\diagdown"),G(P,Q,"□","\\square"),G(P,Q,"□","\\Box"),G(P,Q,"◊","\\Diamond"),G(P,Q,"¥","\\yen",!0),G(R,Q,"¥","\\yen",!0),G(P,Q,"✓","\\checkmark",!0),G(R,Q,"✓","\\checkmark"),G(P,Q,"✗","\\ballotx",!0),G(R,Q,"✗","\\ballotx"),G(R,Q,"•","\\textbullet"),G(P,Q,"ℶ","\\beth",!0),G(P,Q,"ℸ","\\daleth",!0),G(P,Q,"ℷ","\\gimel",!0),G(P,Q,"ϝ","\\digamma",!0),G(P,Q,"ϰ","\\varkappa"),G(P,Z,"⌜","\\ulcorner",!0),G(P,_,"⌝","\\urcorner",!0),G(P,Z,"⌞","\\llcorner",!0),G(P,_,"⌟","\\lrcorner",!0),G(P,J,"≦","\\leqq",!0),G(P,J,"⩽","\\leqslant",!0),G(P,J,"⪕","\\eqslantless",!0),G(P,J,"≲","\\lesssim",!0),G(P,J,"⪅","\\lessapprox",!0),G(P,J,"≊","\\approxeq",!0),G(P,H,"⋖","\\lessdot"),G(P,J,"⋘","\\lll",!0),G(P,J,"≶","\\lessgtr",!0),G(P,J,"⋚","\\lesseqgtr",!0),G(P,J,"⪋","\\lesseqqgtr",!0),G(P,J,"≑","\\doteqdot"),G(P,J,"≓","\\risingdotseq",!0),G(P,J,"≒","\\fallingdotseq",!0),G(P,J,"∽","\\backsim",!0),G(P,J,"⋍","\\backsimeq",!0),G(P,J,"⫅","\\subseteqq",!0),G(P,J,"⋐","\\Subset",!0),G(P,J,"⊏","\\sqsubset",!0),G(P,J,"≼","\\preccurlyeq",!0),G(P,J,"⋞","\\curlyeqprec",!0),G(P,J,"≾","\\precsim",!0),G(P,J,"⪷","\\precapprox",!0),G(P,J,"⊲","\\vartriangleleft"),G(P,J,"⊴","\\trianglelefteq"),G(P,J,"⊨","\\vDash",!0),G(P,J,"⊫","\\VDash",!0),G(P,J,"⊪","\\Vvdash",!0),G(P,J,"⌣","\\smallsmile"),G(P,J,"⌢","\\smallfrown"),G(P,J,"≏","\\bumpeq",!0),G(P,J,"≎","\\Bumpeq",!0),G(P,J,"≧","\\geqq",!0),G(P,J,"⩾","\\geqslant",!0),G(P,J,"⪖","\\eqslantgtr",!0),G(P,J,"≳","\\gtrsim",!0),G(P,J,"⪆","\\gtrapprox",!0),G(P,H,"⋗","\\gtrdot"),G(P,J,"⋙","\\ggg",!0),G(P,J,"≷","\\gtrless",!0),G(P,J,"⋛","\\gtreqless",!0),G(P,J,"⪌","\\gtreqqless",!0),G(P,J,"≖","\\eqcirc",!0),G(P,J,"≗","\\circeq",!0),G(P,J,"≜","\\triangleq",!0),G(P,J,"∼","\\thicksim"),G(P,J,"≈","\\thickapprox"),G(P,J,"⫆","\\supseteqq",!0),G(P,J,"⋑","\\Supset",!0),G(P,J,"⊐","\\sqsupset",!0),G(P,J,"≽","\\succcurlyeq",!0),G(P,J,"⋟","\\curlyeqsucc",!0),G(P,J,"≿","\\succsim",!0),G(P,J,"⪸","\\succapprox",!0),G(P,J,"⊳","\\vartriangleright"),G(P,J,"⊵","\\trianglerighteq"),G(P,J,"⊩","\\Vdash",!0),G(P,J,"∣","\\shortmid"),G(P,J,"∥","\\shortparallel"),G(P,J,"≬","\\between",!0),G(P,J,"⋔","\\pitchfork",!0),G(P,J,"∝","\\varpropto"),G(P,J,"◀","\\blacktriangleleft"),G(P,J,"∴","\\therefore",!0),G(P,J,"∍","\\backepsilon"),G(P,J,"▶","\\blacktriangleright"),G(P,J,"∵","\\because",!0),G(P,J,"⋘","\\llless"),G(P,J,"⋙","\\gggtr"),G(P,H,"⊲","\\lhd"),G(P,H,"⊳","\\rhd"),G(P,J,"≂","\\eqsim",!0),G(P,J,"≑","\\Doteq",!0),G(P,J,"⥽","\\strictif",!0),G(P,J,"⥼","\\strictfi",!0),G(P,H,"∔","\\dotplus",!0),G(P,H,"∖","\\smallsetminus"),G(P,H,"⋒","\\Cap",!0),G(P,H,"⋓","\\Cup",!0),G(P,H,"⩞","\\doublebarwedge",!0),G(P,H,"⊟","\\boxminus",!0),G(P,H,"⊞","\\boxplus",!0),G(P,H,"⧄","\\boxslash",!0),G(P,H,"⋇","\\divideontimes",!0),G(P,H,"⋉","\\ltimes",!0),G(P,H,"⋊","\\rtimes",!0),G(P,H,"⋋","\\leftthreetimes",!0),G(P,H,"⋌","\\rightthreetimes",!0),G(P,H,"⋏","\\curlywedge",!0),G(P,H,"⋎","\\curlyvee",!0),G(P,H,"⊝","\\circleddash",!0),G(P,H,"⊛","\\circledast",!0),G(P,H,"⊺","\\intercal",!0),G(P,H,"⋒","\\doublecap"),G(P,H,"⋓","\\doublecup"),G(P,H,"⊠","\\boxtimes",!0),G(P,H,"⋈","\\bowtie",!0),G(P,H,"⋈","\\Join"),G(P,H,"⟕","\\leftouterjoin",!0),G(P,H,"⟖","\\rightouterjoin",!0),G(P,H,"⟗","\\fullouterjoin",!0),G(P,H,"∸","\\dotminus",!0),G(P,H,"⟑","\\wedgedot",!0),G(P,H,"⟇","\\veedot",!0),G(P,H,"⩢","\\doublebarvee",!0),G(P,H,"⩣","\\veedoublebar",!0),G(P,H,"⩟","\\wedgebar",!0),G(P,H,"⩠","\\wedgedoublebar",!0),G(P,H,"⩔","\\Vee",!0),G(P,H,"⩓","\\Wedge",!0),G(P,H,"⩃","\\barcap",!0),G(P,H,"⩂","\\barcup",!0),G(P,H,"⩈","\\capbarcup",!0),G(P,H,"⩀","\\capdot",!0),G(P,H,"⩇","\\capovercup",!0),G(P,H,"⩆","\\cupovercap",!0),G(P,H,"⩍","\\closedvarcap",!0),G(P,H,"⩌","\\closedvarcup",!0),G(P,H,"⨪","\\minusdot",!0),G(P,H,"⨫","\\minusfdots",!0),G(P,H,"⨬","\\minusrdots",!0),G(P,H,"⊻","\\Xor",!0),G(P,H,"⊼","\\Nand",!0),G(P,H,"⊽","\\Nor",!0),G(P,H,"⊽","\\barvee"),G(P,H,"⫴","\\interleave",!0),G(P,H,"⧢","\\shuffle",!0),G(P,H,"⫶","\\threedotcolon",!0),G(P,H,"⦂","\\typecolon",!0),G(P,H,"∾","\\invlazys",!0),G(P,H,"⩋","\\twocaps",!0),G(P,H,"⩊","\\twocups",!0),G(P,H,"⩎","\\Sqcap",!0),G(P,H,"⩏","\\Sqcup",!0),G(P,H,"⩖","\\veeonvee",!0),G(P,H,"⩕","\\wedgeonwedge",!0),G(P,H,"⧗","\\blackhourglass",!0),G(P,H,"⧆","\\boxast",!0),G(P,H,"⧈","\\boxbox",!0),G(P,H,"⧇","\\boxcircle",!0),G(P,H,"⊜","\\circledequal",!0),G(P,H,"⦷","\\circledparallel",!0),G(P,H,"⦶","\\circledvert",!0),G(P,H,"⦵","\\circlehbar",!0),G(P,H,"⟡","\\concavediamond",!0),G(P,H,"⟢","\\concavediamondtickleft",!0),G(P,H,"⟣","\\concavediamondtickright",!0),G(P,H,"⋄","\\diamond",!0),G(P,H,"⧖","\\hourglass",!0),G(P,H,"⟠","\\lozengeminus",!0),G(P,H,"⌽","\\obar",!0),G(P,H,"⦸","\\obslash",!0),G(P,H,"⨸","\\odiv",!0),G(P,H,"⧁","\\ogreaterthan",!0),G(P,H,"⧀","\\olessthan",!0),G(P,H,"⦹","\\operp",!0),G(P,H,"⨷","\\Otimes",!0),G(P,H,"⨶","\\otimeshat",!0),G(P,H,"⋆","\\star",!0),G(P,H,"△","\\triangle",!0),G(P,H,"⨺","\\triangleminus",!0),G(P,H,"⨹","\\triangleplus",!0),G(P,H,"⨻","\\triangletimes",!0),G(P,H,"⟤","\\whitesquaretickleft",!0),G(P,H,"⟥","\\whitesquaretickright",!0),G(P,H,"⨳","\\smashtimes",!0),G(P,J,"⇢","\\dashrightarrow",!0),G(P,J,"⇠","\\dashleftarrow",!0),G(P,J,"⇇","\\leftleftarrows",!0),G(P,J,"⇆","\\leftrightarrows",!0),G(P,J,"⇚","\\Lleftarrow",!0),G(P,J,"↞","\\twoheadleftarrow",!0),G(P,J,"↢","\\leftarrowtail",!0),G(P,J,"↫","\\looparrowleft",!0),G(P,J,"⇋","\\leftrightharpoons",!0),G(P,J,"↶","\\curvearrowleft",!0),G(P,J,"↺","\\circlearrowleft",!0),G(P,J,"↰","\\Lsh",!0),G(P,J,"⇈","\\upuparrows",!0),G(P,J,"↿","\\upharpoonleft",!0),G(P,J,"⇃","\\downharpoonleft",!0),G(P,J,"⊶","\\origof",!0),G(P,J,"⊷","\\imageof",!0),G(P,J,"⊸","\\multimap",!0),G(P,J,"↭","\\leftrightsquigarrow",!0),G(P,J,"⇉","\\rightrightarrows",!0),G(P,J,"⇄","\\rightleftarrows",!0),G(P,J,"↠","\\twoheadrightarrow",!0),G(P,J,"↣","\\rightarrowtail",!0),G(P,J,"↬","\\looparrowright",!0),G(P,J,"↷","\\curvearrowright",!0),G(P,J,"↻","\\circlearrowright",!0),G(P,J,"↱","\\Rsh",!0),G(P,J,"⇊","\\downdownarrows",!0),G(P,J,"↾","\\upharpoonright",!0),G(P,J,"⇂","\\downharpoonright",!0),G(P,J,"⇝","\\rightsquigarrow",!0),G(P,J,"⇝","\\leadsto"),G(P,J,"⇛","\\Rrightarrow",!0),G(P,J,"↾","\\restriction"),G(P,Q,"‘","`"),G(P,Q,"$","\\$"),G(R,Q,"$","\\$"),G(R,Q,"$","\\textdollar"),G(P,Q,"¢","\\cent"),G(R,Q,"¢","\\cent"),G(P,Q,"%","\\%"),G(R,Q,"%","\\%"),G(P,Q,"_","\\_"),G(R,Q,"_","\\_"),G(R,Q,"_","\\textunderscore"),G(R,Q,"␣","\\textvisiblespace",!0),G(P,Q,"∠","\\angle",!0),G(P,Q,"∞","\\infty",!0),G(P,Q,"′","\\prime"),G(P,Q,"″","\\dprime"),G(P,Q,"‴","\\trprime"),G(P,Q,"⁗","\\qprime"),G(P,Q,"△","\\triangle"),G(R,Q,"Α","\\Alpha",!0),G(R,Q,"Β","\\Beta",!0),G(R,Q,"Γ","\\Gamma",!0),G(R,Q,"Δ","\\Delta",!0),G(R,Q,"Ε","\\Epsilon",!0),G(R,Q,"Ζ","\\Zeta",!0),G(R,Q,"Η","\\Eta",!0),G(R,Q,"Θ","\\Theta",!0),G(R,Q,"Ι","\\Iota",!0),G(R,Q,"Κ","\\Kappa",!0),G(R,Q,"Λ","\\Lambda",!0),G(R,Q,"Μ","\\Mu",!0),G(R,Q,"Ν","\\Nu",!0),G(R,Q,"Ξ","\\Xi",!0),G(R,Q,"Ο","\\Omicron",!0),G(R,Q,"Π","\\Pi",!0),G(R,Q,"Ρ","\\Rho",!0),G(R,Q,"Σ","\\Sigma",!0),G(R,Q,"Τ","\\Tau",!0),G(R,Q,"Υ","\\Upsilon",!0),G(R,Q,"Φ","\\Phi",!0),G(R,Q,"Χ","\\Chi",!0),G(R,Q,"Ψ","\\Psi",!0),G(R,Q,"Ω","\\Omega",!0),G(P,W,"Α","\\Alpha",!0),G(P,W,"Β","\\Beta",!0),G(P,W,"Γ","\\Gamma",!0),G(P,W,"Δ","\\Delta",!0),G(P,W,"Ε","\\Epsilon",!0),G(P,W,"Ζ","\\Zeta",!0),G(P,W,"Η","\\Eta",!0),G(P,W,"Θ","\\Theta",!0),G(P,W,"Ι","\\Iota",!0),G(P,W,"Κ","\\Kappa",!0),G(P,W,"Λ","\\Lambda",!0),G(P,W,"Μ","\\Mu",!0),G(P,W,"Ν","\\Nu",!0),G(P,W,"Ξ","\\Xi",!0),G(P,W,"Ο","\\Omicron",!0),G(P,W,"Π","\\Pi",!0),G(P,W,"Ρ","\\Rho",!0),G(P,W,"Σ","\\Sigma",!0),G(P,W,"Τ","\\Tau",!0),G(P,W,"Υ","\\Upsilon",!0),G(P,W,"Φ","\\Phi",!0),G(P,W,"Χ","\\Chi",!0),G(P,W,"Ψ","\\Psi",!0),G(P,W,"Ω","\\Omega",!0),G(P,Z,"¬","\\neg",!0),G(P,Z,"¬","\\lnot"),G(P,Q,"⊤","\\top"),G(P,Q,"⊥","\\bot"),G(P,Q,"∅","\\emptyset"),G(P,Q,"⌀","\\varnothing"),G(P,W,"α","\\alpha",!0),G(P,W,"β","\\beta",!0),G(P,W,"γ","\\gamma",!0),G(P,W,"δ","\\delta",!0),G(P,W,"ϵ","\\epsilon",!0),G(P,W,"ζ","\\zeta",!0),G(P,W,"η","\\eta",!0),G(P,W,"θ","\\theta",!0),G(P,W,"ι","\\iota",!0),G(P,W,"κ","\\kappa",!0),G(P,W,"λ","\\lambda",!0),G(P,W,"μ","\\mu",!0),G(P,W,"ν","\\nu",!0),G(P,W,"ξ","\\xi",!0),G(P,W,"ο","\\omicron",!0),G(P,W,"π","\\pi",!0),G(P,W,"ρ","\\rho",!0),G(P,W,"σ","\\sigma",!0),G(P,W,"τ","\\tau",!0),G(P,W,"υ","\\upsilon",!0),G(P,W,"ϕ","\\phi",!0),G(P,W,"χ","\\chi",!0),G(P,W,"ψ","\\psi",!0),G(P,W,"ω","\\omega",!0),G(P,W,"ε","\\varepsilon",!0),G(P,W,"ϑ","\\vartheta",!0),G(P,W,"ϖ","\\varpi",!0),G(P,W,"ϱ","\\varrho",!0),G(P,W,"ς","\\varsigma",!0),G(P,W,"φ","\\varphi",!0),G(P,W,"Ϙ","\\Coppa",!0),G(P,W,"ϙ","\\coppa",!0),G(P,W,"ϙ","\\varcoppa",!0),G(P,W,"Ϟ","\\Koppa",!0),G(P,W,"ϟ","\\koppa",!0),G(P,W,"Ϡ","\\Sampi",!0),G(P,W,"ϡ","\\sampi",!0),G(P,W,"Ϛ","\\Stigma",!0),G(P,W,"ϛ","\\stigma",!0),G(P,W,"⫫","\\Bot"),G(P,Q,"ð","\\eth",!0),G(R,Q,"ð","ð"),G(P,Q,"Å","\\AA"),G(R,Q,"Å","\\AA",!0),G(P,Q,"Æ","\\AE",!0),G(R,Q,"Æ","\\AE",!0),G(P,Q,"Ð","\\DH",!0),G(R,Q,"Ð","\\DH",!0),G(P,Q,"Þ","\\TH",!0),G(R,Q,"Þ","\\TH",!0),G(P,Q,"ß","\\ss",!0),G(R,Q,"ß","\\ss",!0),G(P,Q,"å","\\aa"),G(R,Q,"å","\\aa",!0),G(P,Q,"æ","\\ae",!0),G(R,Q,"æ","\\ae",!0),G(P,Q,"ð","\\dh"),G(R,Q,"ð","\\dh",!0),G(P,Q,"þ","\\th",!0),G(R,Q,"þ","\\th",!0),G(P,Q,"Đ","\\DJ",!0),G(R,Q,"Đ","\\DJ",!0),G(P,Q,"đ","\\dj",!0),G(R,Q,"đ","\\dj",!0),G(P,Q,"Ł","\\L",!0),G(R,Q,"Ł","\\L",!0),G(P,Q,"Ł","\\l",!0),G(R,Q,"Ł","\\l",!0),G(P,Q,"Ŋ","\\NG",!0),G(R,Q,"Ŋ","\\NG",!0),G(P,Q,"ŋ","\\ng",!0),G(R,Q,"ŋ","\\ng",!0),G(P,Q,"Œ","\\OE",!0),G(R,Q,"Œ","\\OE",!0),G(P,Q,"œ","\\oe",!0),G(R,Q,"œ","\\oe",!0),G(P,H,"∗","∗",!0),G(P,H,"+","+"),G(P,H,"∗","*"),G(P,H,"⁄","/",!0),G(P,H,"⁄","⁄"),G(P,H,"−","-",!0),G(P,H,"⋅","\\cdot",!0),G(P,H,"∘","\\circ",!0),G(P,H,"÷","\\div",!0),G(P,H,"±","\\pm",!0),G(P,H,"×","\\times",!0),G(P,H,"∩","\\cap",!0),G(P,H,"∪","\\cup",!0),G(P,H,"∖","\\setminus",!0),G(P,H,"∧","\\land"),G(P,H,"∨","\\lor"),G(P,H,"∧","\\wedge",!0),G(P,H,"∨","\\vee",!0),G(P,Z,"⟦","\\llbracket",!0),G(P,_,"⟧","\\rrbracket",!0),G(P,Z,"⟨","\\langle",!0),G(P,Z,"⟪","\\lAngle",!0),G(P,Z,"⦉","\\llangle",!0),G(P,Z,"|","\\lvert"),G(P,Z,"‖","\\lVert",!0),G(P,Q,"!","\\oc"),G(P,Q,"?","\\wn"),G(P,Q,"↓","\\shpos"),G(P,Q,"↕","\\shift"),G(P,Q,"↑","\\shneg"),G(P,_,"?","?"),G(P,_,"!","!"),G(P,_,"‼","‼"),G(P,_,"⟩","\\rangle",!0),G(P,_,"⟫","\\rAngle",!0),G(P,_,"⦊","\\rrangle",!0),G(P,_,"|","\\rvert"),G(P,_,"‖","\\rVert"),G(P,Z,"⦃","\\lBrace",!0),G(P,_,"⦄","\\rBrace",!0),G(P,J,"=","\\equal",!0),G(P,J,":",":"),G(P,J,"≈","\\approx",!0),G(P,J,"≅","\\cong",!0),G(P,J,"≥","\\ge"),G(P,J,"≥","\\geq",!0),G(P,J,"←","\\gets"),G(P,J,">","\\gt",!0),G(P,J,"∈","\\in",!0),G(P,J,"∉","\\notin",!0),G(P,J,"","\\@not"),G(P,J,"⊂","\\subset",!0),G(P,J,"⊃","\\supset",!0),G(P,J,"⊆","\\subseteq",!0),G(P,J,"⊇","\\supseteq",!0),G(P,J,"⊈","\\nsubseteq",!0),G(P,J,"⊈","\\nsubseteqq"),G(P,J,"⊉","\\nsupseteq",!0),G(P,J,"⊉","\\nsupseteqq"),G(P,J,"⊨","\\models"),G(P,J,"←","\\leftarrow",!0),G(P,J,"≤","\\le"),G(P,J,"≤","\\leq",!0),G(P,J,"<","\\lt",!0),G(P,J,"→","\\rightarrow",!0),G(P,J,"→","\\to"),G(P,J,"≱","\\ngeq",!0),G(P,J,"≱","\\ngeqq"),G(P,J,"≱","\\ngeqslant"),G(P,J,"≰","\\nleq",!0),G(P,J,"≰","\\nleqq"),G(P,J,"≰","\\nleqslant"),G(P,J,"⫫","\\Perp",!0),G(P,K," ","\\ "),G(P,K," ","\\space"),G(P,K," ","\\nobreakspace"),G(R,K," ","\\ "),G(R,K," "," "),G(R,K," ","\\space"),G(R,K," ","\\nobreakspace"),G(P,K,null,"\\nobreak"),G(P,K,null,"\\allowbreak"),G(P,Y,",",","),G(R,Y,":",":"),G(P,Y,";",";"),G(P,H,"⊼","\\barwedge"),G(P,H,"⊻","\\veebar"),G(P,H,"⊙","\\odot",!0),G(P,H,"⊕︎","\\oplus"),G(P,H,"⊗","\\otimes",!0),G(P,Q,"∂","\\partial",!0),G(P,H,"⊘","\\oslash",!0),G(P,H,"⊚","\\circledcirc",!0),G(P,H,"⊡","\\boxdot",!0),G(P,H,"△","\\bigtriangleup"),G(P,H,"▽","\\bigtriangledown"),G(P,H,"†","\\dagger"),G(P,H,"⋄","\\diamond"),G(P,H,"◃","\\triangleleft"),G(P,H,"▹","\\triangleright"),G(P,Z,"{","\\{"),G(R,Q,"{","\\{"),G(R,Q,"{","\\textbraceleft"),G(P,_,"}","\\}"),G(R,Q,"}","\\}"),G(R,Q,"}","\\textbraceright"),G(P,Z,"{","\\lbrace"),G(P,_,"}","\\rbrace"),G(P,Z,"[","\\lbrack",!0),G(R,Q,"[","\\lbrack",!0),G(P,_,"]","\\rbrack",!0),G(R,Q,"]","\\rbrack",!0),G(P,Z,"(","\\lparen",!0),G(P,_,")","\\rparen",!0),G(P,Z,"⦇","\\llparenthesis",!0),G(P,_,"⦈","\\rrparenthesis",!0),G(R,Q,"<","\\textless",!0),G(R,Q,">","\\textgreater",!0),G(P,Z,"⌊","\\lfloor",!0),G(P,_,"⌋","\\rfloor",!0),G(P,Z,"⌈","\\lceil",!0),G(P,_,"⌉","\\rceil",!0),G(P,Q,"\\","\\backslash"),G(P,Q,"|","|"),G(P,Q,"|","\\vert"),G(R,Q,"|","\\textbar",!0),G(P,Q,"‖","\\|"),G(P,Q,"‖","\\Vert"),G(R,Q,"‖","\\textbardbl"),G(R,Q,"~","\\textasciitilde"),G(R,Q,"\\","\\textbackslash"),G(R,Q,"^","\\textasciicircum"),G(P,J,"↑","\\uparrow",!0),G(P,J,"⇑","\\Uparrow",!0),G(P,J,"↓","\\downarrow",!0),G(P,J,"⇓","\\Downarrow",!0),G(P,J,"↕","\\updownarrow",!0),G(P,J,"⇕","\\Updownarrow",!0),G(P,X,"∐","\\coprod"),G(P,X,"⋁","\\bigvee"),G(P,X,"⋀","\\bigwedge"),G(P,X,"⨄","\\biguplus"),G(P,X,"⨄","\\bigcupplus"),G(P,X,"⨃","\\bigcupdot"),G(P,X,"⨇","\\bigdoublevee"),G(P,X,"⨈","\\bigdoublewedge"),G(P,X,"⋂","\\bigcap"),G(P,X,"⋃","\\bigcup"),G(P,X,"∫","\\int"),G(P,X,"∫","\\intop"),G(P,X,"∬","\\iint"),G(P,X,"∭","\\iiint"),G(P,X,"∏","\\prod"),G(P,X,"∑","\\sum"),G(P,X,"⨂","\\bigotimes"),G(P,X,"⨁","\\bigoplus"),G(P,X,"⨀","\\bigodot"),G(P,X,"⨉","\\bigtimes"),G(P,X,"∮","\\oint"),G(P,X,"∯","\\oiint"),G(P,X,"∰","\\oiiint"),G(P,X,"∱","\\intclockwise"),G(P,X,"∲","\\varointclockwise"),G(P,X,"⨌","\\iiiint"),G(P,X,"⨍","\\intbar"),G(P,X,"⨎","\\intBar"),G(P,X,"⨏","\\fint"),G(P,X,"⨒","\\rppolint"),G(P,X,"⨓","\\scpolint"),G(P,X,"⨕","\\pointint"),G(P,X,"⨖","\\sqint"),G(P,X,"⨗","\\intlarhk"),G(P,X,"⨘","\\intx"),G(P,X,"⨙","\\intcap"),G(P,X,"⨚","\\intcup"),G(P,X,"⨅","\\bigsqcap"),G(P,X,"⨆","\\bigsqcup"),G(P,X,"∫","\\smallint"),G(R,V,"…","\\textellipsis"),G(P,V,"…","\\mathellipsis"),G(R,V,"…","\\ldots",!0),G(P,V,"…","\\dotso"),G(P,V,"…","\\dotsc"),G(P,V,"…","\\ldots",!0),G(P,V,"⋰","\\iddots",!0),G(P,V,"⋯","\\cdots",!0),G(P,V,"⋱","\\ddots",!0),G(P,Q,"⋮","\\varvdots"),G(R,Q,"⋮","\\varvdots"),G(P,U,"´","\\acute"),G(P,U,"`","\\grave"),G(P,U,"¨","\\ddot"),G(P,U,"…","\\dddot"),G(P,U,"….","\\ddddot"),G(P,U,"~","\\tilde"),G(P,U,"‾","\\bar"),G(P,U,"˘","\\breve"),G(P,U,"ˇ","\\check"),G(P,U,"ˆ","\\hat"),G(P,U,"→","\\vec"),G(P,U,"˙","\\dot"),G(P,U,"˚","\\mathring"),G(P,W,"ı","\\imath",!0),G(P,W,"ȷ","\\jmath",!0),G(P,Q,"ı","ı"),G(P,Q,"ȷ","ȷ"),G(R,Q,"ı","\\i",!0),G(R,Q,"ȷ","\\j",!0),G(R,Q,"ø","\\o",!0),G(P,W,"ø","\\o",!0),G(R,Q,"Ø","\\O",!0),G(P,W,"Ø","\\O",!0),G(R,U,"ˊ","\\'"),G(R,U,"ˋ","\\`"),G(R,U,"ˆ","\\^"),G(R,U,"~","\\~"),G(R,U,"ˉ","\\="),G(R,U,"˘","\\u"),G(R,U,"˙","\\."),G(R,U,"¸","\\c");G(R,U,"˚","\\r"),G(R,U,"ˇ","\\v"),G(R,U,"¨",'\\"'),G(R,U,"˝","\\H"),G(P,U,"ˊ","\\'"),G(P,U,"ˋ","\\`"),G(P,U,"ˆ","\\^"),G(P,U,"~","\\~"),G(P,U,"ˉ","\\="),G(P,U,"˘","\\u"),G(P,U,"˙","\\."),G(P,U,"¸","\\c"),G(P,U,"˚","\\r"),G(P,U,"ˇ","\\v"),G(P,U,"¨",'\\"'),G(P,U,"˝","\\H");const ee={"--":!0,"---":!0,"``":!0,"''":!0};G(R,Q,"–","--",!0),G(R,Q,"–","\\textendash"),G(R,Q,"—","---",!0),G(R,Q,"—","\\textemdash"),G(R,Q,"‘","`",!0),G(R,Q,"‘","\\textquoteleft"),G(R,Q,"’","'",!0),G(R,Q,"’","\\textquoteright"),G(R,Q,"“","``",!0),G(R,Q,"“","\\textquotedblleft"),G(R,Q,"”","''",!0),G(R,Q,"”","\\textquotedblright"),G(P,Q,"°","\\degree",!0),G(R,Q,"°","\\degree"),G(R,Q,"°","\\textdegree",!0),G(P,Q,"£","\\pounds"),G(P,Q,"£","\\mathsterling",!0),G(R,Q,"£","\\pounds"),G(R,Q,"£","\\textsterling",!0),G(P,Q,"✠","\\maltese"),G(R,Q,"✠","\\maltese"),G(P,Q,"€","\\euro",!0),G(R,Q,"€","\\euro",!0),G(R,Q,"€","\\texteuro"),G(P,Q,"©","\\copyright",!0),G(R,Q,"©","\\textcopyright"),G(P,Q,"⌀","\\diameter",!0),G(R,Q,"⌀","\\diameter"),G(P,Q,"𝛤","\\varGamma"),G(P,Q,"𝛥","\\varDelta"),G(P,Q,"𝛩","\\varTheta"),G(P,Q,"𝛬","\\varLambda"),G(P,Q,"𝛯","\\varXi"),G(P,Q,"𝛱","\\varPi"),G(P,Q,"𝛴","\\varSigma"),G(P,Q,"𝛶","\\varUpsilon"),G(P,Q,"𝛷","\\varPhi"),G(P,Q,"𝛹","\\varPsi"),G(P,Q,"𝛺","\\varOmega"),G(R,Q,"𝛤","\\varGamma"),G(R,Q,"𝛥","\\varDelta"),G(R,Q,"𝛩","\\varTheta"),G(R,Q,"𝛬","\\varLambda"),G(R,Q,"𝛯","\\varXi"),G(R,Q,"𝛱","\\varPi"),G(R,Q,"𝛴","\\varSigma"),G(R,Q,"𝛶","\\varUpsilon"),G(R,Q,"𝛷","\\varPhi"),G(R,Q,"𝛹","\\varPsi"),G(R,Q,"𝛺","\\varOmega");const te='0123456789/@."';for(let e=0;e<14;e++){const t=te.charAt(e);G(P,Q,t,t)}const re='0123456789!@*()-=+";:?/.,';for(let e=0;e<25;e++){const t=re.charAt(e);G(R,Q,t,t)}const ne="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";for(let e=0;e<52;e++){const t=ne.charAt(e);G(P,W,t,t),G(R,Q,t,t)}const se="ÇÐÞçþℂℍℕℙℚℝℤℎℏℊℋℌℐℑℒℓ℘ℛℜℬℰℱℳℭℨ";for(let e=0;e<30;e++){const t=se.charAt(e);G(P,W,t,t),G(R,Q,t,t)}let oe="";for(let e=0;e<52;e++){oe=String.fromCharCode(55349,56320+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56372+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56424+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56580+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56736+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56788+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56840+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56944+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,56632+e),G(P,W,oe,oe),G(R,Q,oe,oe);const t=ne.charAt(e);oe=String.fromCharCode(55349,56476+e),G(P,W,t,oe),G(R,Q,t,oe)}for(let e=0;e<10;e++)oe=String.fromCharCode(55349,57294+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,57314+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,57324+e),G(P,W,oe,oe),G(R,Q,oe,oe),oe=String.fromCharCode(55349,57334+e),G(P,W,oe,oe),G(R,Q,oe,oe);const ae=function(e,t,r){return!D[t][e]||!D[t][e].replace||55349===e.charCodeAt(0)||Object.prototype.hasOwnProperty.call(ee,e)&&r&&(r.fontFamily&&"tt"===r.fontFamily.slice(4,6)||r.font&&"tt"===r.font.slice(4,6))||(e=D[t][e].replace),new N(e)},le=(e,t)=>{if(0===e.children.length||"mtext"!==e.children[e.children.length-1].type){const r=new C("mtext",[new N(t.children[0].text)]);e.children.push(r)}else e.children[e.children.length-1].children[0].text+=t.children[0].text},ie=e=>{if("mrow"!==e.type&&"mstyle"!==e.type)return e;if(0===e.children.length)return e;const t=new C("mrow");for(let r=0;r<e.children.length;r++){const n=e.children[r];if("mtext"===n.type&&0===Object.keys(n.attributes).length)le(t,n);else if("mrow"===n.type){let e=!0;for(let t=0;t<n.children.length;t++){if("mtext"!==n.children[t].type||0!==Object.keys(n.attributes).length){e=!1;break}}if(e)for(let e=0;e<n.children.length;e++){const r=n.children[e];le(t,r)}else t.children.push(n)}else t.children.push(n)}for(let r=0;r<t.children.length;r++)if("mtext"===t.children[r].type){const n=t.children[r];" "===n.children[0].text.charAt(0)&&(n.children[0].text=" "+n.children[0].text.slice(1));const s=n.children[0].text.length;s>0&&" "===n.children[0].text.charAt(s-1)&&(n.children[0].text=n.children[0].text.slice(0,-1)+" ");for(const[t,r]of Object.entries(e.attributes))n.attributes[t]=r}return 1===t.children.length&&"mtext"===t.children[0].type?t.children[0]:t},ce=function(e,t=!1){if(!(1!==e.length||e[0]instanceof w))return e[0];if(!t){e[0]instanceof C&&"mo"===e[0].type&&!e[0].attributes.fence&&(e[0].attributes.lspace="0em",e[0].attributes.rspace="0em");const t=e.length-1;e[t]instanceof C&&"mo"===e[t].type&&!e[t].attributes.fence&&(e[t].attributes.lspace="0em",e[t].attributes.rspace="0em")}return new C("mrow",e)};function me(e){if(!e)return!1;if("mi"===e.type&&1===e.children.length){const t=e.children[0];return t instanceof N&&"."===t.text}if("mtext"===e.type&&1===e.children.length){const t=e.children[0];return t instanceof N&&" "===t.text}if("mo"===e.type&&1===e.children.length&&"true"===e.getAttribute("separator")&&"0em"===e.getAttribute("lspace")&&"0em"===e.getAttribute("rspace")){const t=e.children[0];return t instanceof N&&","===t.text}return!1}const pe=(e,t)=>{const r=e[t],n=e[t+1];return"atom"===r.type&&","===r.text&&r.loc&&n.loc&&r.loc.end===n.loc.start},ue=e=>"atom"===e.type&&"rel"===e.family||"mclass"===e.type&&"mrel"===e.mclass,de=function(e,t,r=!1){if(!r&&1===e.length){const r=ge(e[0],t);return r instanceof C&&"mo"===r.type&&(r.setAttribute("lspace","0em"),r.setAttribute("rspace","0em")),[r]}const n=[],s=[];let o;for(let r=0;r<e.length;r++)s.push(ge(e[r],t));for(let t=0;t<s.length;t++){const r=s[t];if(t<e.length-1&&ue(e[t])&&ue(e[t+1])&&r.setAttribute("rspace","0em"),t>0&&ue(e[t])&&ue(e[t-1])&&r.setAttribute("lspace","0em"),"mn"===r.type&&o&&"mn"===o.type)o.children.push(...r.children);else if(me(r)&&o&&"mn"===o.type)o.children.push(...r.children);else if(o&&"mn"===o.type&&t<s.length-1&&"mn"===s[t+1].type&&pe(e,t))o.children.push(...r.children);else{if("mn"===r.type&&me(o))r.children=[...o.children,...r.children],n.pop();else if(("msup"===r.type||"msub"===r.type)&&r.children.length>=1&&o&&("mn"===o.type||me(o))){const e=r.children[0];e instanceof C&&"mn"===e.type&&o&&(e.children=[...o.children,...e.children],n.pop())}n.push(r),o=r}}return n},he=function(e,t,r=!1){return ce(de(e,t,r),r)},ge=function(t,r){if(!t)return new C("mrow");if(h[t.type]){return h[t.type](t,r)}throw new e("Got group of unknown type: '"+t.type+"'")},fe=e=>new C("mtd",[],[],{padding:"0",width:"50%"}),be=["mrow","mtd","mtable","mtr"],ye=e=>{for(const t of e.children)if(t.type&&be.includes(t.type)){if(t.classes&&"tml-label"===t.classes[0]){return t.label}{const e=ye(t);if(e)return e}}else if(!t.type){const e=ye(t);if(e)return e}};function we(e,t,r,n){let s=null;1===e.length&&"tag"===e[0].type&&(s=e[0].tag,e=e[0].body);const o=de(e,r);if(1===o.length&&o[0]instanceof O)return o[0];const a=n.displayMode||n.annotate?"none":n.wrap,l=0===o.length?null:o[0];let i=1===o.length&&null===s&&l instanceof C?o[0]:function(e,t,r){const n=[];let s=[],o=[],a=0,l=0;for(;l<e.length;){for(;e[l]instanceof w;)e.splice(l,1,...e[l].children);const r=e[l];if(r.attributes&&r.attributes.linebreak&&"newline"===r.attributes.linebreak){o.length>0&&s.push(new C("mrow",o)),s.push(r),o=[];const e=new C("mtd",s);e.style.textAlign="left",n.push(new C("mtr",[e])),s=[],l+=1;continue}if(o.push(r),r.type&&"mo"===r.type&&1===r.children.length&&(!r.attributes.form||"prefix"!==r.attributes.form)&&!Object.prototype.hasOwnProperty.call(r.attributes,"movablelimits")){const n=r.children[0].text;if("="===t&&"="===n){if(a+=1,a>1){o.pop();const e=new C("mrow",o);s.push(e),o=[r]}}else if("tex"===t){const t=l<e.length-1?e[l+1]:null;let r=!0;if(!t||"mtext"!==t.type||!t.attributes.linebreak||"nobreak"!==t.attributes.linebreak)for(let t=l+1;t<e.length;t++){const n=e[t];if(!n.type||"mspace"!==n.type||n.attributes.linebreak&&"newline"===n.attributes.linebreak)break;o.push(n),l+=1,n.attributes&&n.attributes.linebreak&&"nobreak"===n.attributes.linebreak&&(r=!1)}if(r){const e=new C("mrow",o);s.push(e),o=[]}}}l+=1}if(o.length>0){const e=new C("mrow",o);s.push(e)}if(n.length>0){const e=new C("mtd",s);e.style.textAlign="left";const t=new C("mtr",[e]);n.push(t);const o=new C("mtable",n);return r||(o.setAttribute("columnalign","left"),o.setAttribute("rowspacing","0em")),o}return B(s)}(o,a,n.displayMode);if(s&&(i=((e,t,r,n)=>{t=he(t[0].body,r),(t=ie(t)).classes.push("tml-tag");const s=ye(e);e=new C("mtd",[e]);const o=[fe(),e,fe()];o[n?0:2].children.push(t);const a=new C("mtr",o,["tml-tageqn"]);s&&a.setAttribute("id",s);const l=new C("mtable",[a]);return l.style.width="100%",l.setAttribute("displaystyle","true"),l})(i,s,r,n.leqno)),n.annotate){const e=new C("annotation",[new N(t)]);e.setAttribute("encoding","application/x-tex"),i=new C("semantics",[i,e])}const c=new C("math",[i]);return n.xml&&c.setAttribute("xmlns","http://www.w3.org/1998/Math/MathML"),n.displayMode&&(c.setAttribute("display","block"),c.style.display="block math",c.classes=["tml-display"]),c}const xe=(e,t)=>{const r=e.isStretchy?F(e):new C("mo",[ae(e.label,e.mode)]);e.isStretchy||r.setAttribute("stretchy","false"),"\\vec"!==e.label&&(r.style.mathDepth="0");const n="\\c"===e.label?"munder":"mover",s=ve.has(e.label);if("mover"===n&&"math"===e.mode&&!e.isStretchy&&e.base.text&&1===e.base.text.length){const t=e.base.text,n="\\vec"===e.label,o="\\vec"===n?"-vec":"";n&&r.classes.push("tml-vec");const a=n?"-vec":s?"-acc":"";"DHKLUcegorsuvxyzΠΥΨαδηιμνοτυχϵ".indexOf(t)>-1?(r.classes.push(`chr-sml${o}`),r.classes.push(`wbk-sml${a}`)):"BCEGIMNOPQRSTXZlpqtwΓΘΞΣΦΩβεζθξρςφψϑϕϱ".indexOf(t)>-1?(r.classes.push(`chr-med${o}`),r.classes.push(`wbk-med${a}`)):"AFJdfΔΛ".indexOf(t)>-1?(r.classes.push(`chr-lrg${o}`),r.classes.push(`wbk-lrg${a}`)):n?r.classes.push("wbk-vec"):s&&r.classes.push("wbk-acc")}else s&&r.classes.push("wbk-acc");return new C(n,[ge(e.base,t),r])},ke=new Set(["\\acute","\\check","\\grave","\\ddot","\\dddot","\\ddddot","\\tilde","\\bar","\\breve","\\check","\\hat","\\vec","\\dot","\\mathring"]),ve=new Set(["\\acute","\\bar","\\breve","\\check","\\dot","\\ddot","\\grave","\\hat","\\mathring","\\`","\\'","\\^","\\=","\\u","\\.",'\\"',"\\r","\\H","\\v"]),Ae={"\\`":"̀","\\'":"́","\\^":"̂","\\~":"̃","\\=":"̄","\\u":"̆","\\.":"̇",'\\"':"̈","\\r":"̊","\\H":"̋","\\v":"̌","\\c":"̧"};g({type:"accent",names:["\\acute","\\grave","\\ddot","\\dddot","\\ddddot","\\tilde","\\bar","\\breve","\\check","\\hat","\\vec","\\dot","\\mathring","\\overparen","\\widecheck","\\widehat","\\wideparen","\\widetilde","\\overrightarrow","\\overleftarrow","\\Overrightarrow","\\overleftrightarrow","\\overgroup","\\overleftharpoon","\\overrightharpoon"],props:{numArgs:1},handler:(e,t)=>{const r=b(t[0]),n=!ke.has(e.funcName);return{type:"accent",mode:e.parser.mode,label:e.funcName,isStretchy:n,base:r}},mathmlBuilder:xe}),g({type:"accent",names:["\\'","\\`","\\^","\\~","\\=","\\c","\\u","\\.",'\\"',"\\r","\\H","\\v"],props:{numArgs:1,allowedInText:!0,allowedInMath:!0,argTypes:["primitive"]},handler:(e,t)=>{const r=b(t[0]),n=e.parser.mode;return"math"===n&&e.parser.settings.strict&&console.log(`Temml parse error: Command ${e.funcName} is invalid in math mode.`),"text"===n&&r.text&&1===r.text.length&&e.funcName in Ae&&m.indexOf(r.text)>-1?{type:"textord",mode:"text",text:r.text+Ae[e.funcName]}:"\\c"===e.funcName&&"text"===n&&r.text&&1===r.text.length?{type:"textord",mode:"text",text:r.text+"̧"}:{type:"accent",mode:n,label:e.funcName,isStretchy:!1,base:r}},mathmlBuilder:xe}),g({type:"accentUnder",names:["\\underleftarrow","\\underrightarrow","\\underleftrightarrow","\\undergroup","\\underparen","\\utilde"],props:{numArgs:1},handler:({parser:e,funcName:t},r)=>{const n=r[0];return{type:"accentUnder",mode:e.mode,label:t,base:n}},mathmlBuilder:(e,t)=>{const r=F(e);r.style["math-depth"]=0;return new C("munder",[ge(e.base,t),r])}});const Te={pt:800/803,pc:9600/803,dd:1238/1157*800/803,cc:12.792133216944668,nd:685/642*800/803,nc:1370/107*800/803,sp:1/65536*800/803,mm:25.4/72,cm:2.54/72,in:1/72,px:96/72},Se=["em","ex","mu","pt","mm","cm","in","px","bp","pc","dd","cc","nd","nc","sp"],Oe=function(e){return"string"!=typeof e&&(e=e.unit),Se.indexOf(e)>-1},qe=e=>[1,.7,.5][Math.max(e-1,0)],Be=function(t,r){let n=t.number;if(r.maxSize[0]<0&&n>0)return{number:0,unit:"em"};const s=t.unit;switch(s){case"mm":case"cm":case"in":case"px":return n*Te[s]>r.maxSize[1]?{number:r.maxSize[1],unit:"pt"}:{number:n,unit:s};case"em":case"ex":return"ex"===s&&(n*=.431),n=Math.min(n/qe(r.level),r.maxSize[0]),{number:c(n),unit:"em"};case"bp":return n>r.maxSize[1]&&(n=r.maxSize[1]),{number:n,unit:"pt"};case"pt":case"pc":case"dd":case"cc":case"nd":case"nc":case"sp":return n=Math.min(n*Te[s],r.maxSize[1]),{number:c(n),unit:"pt"};case"mu":return n=Math.min(n/18,r.maxSize[0]),{number:c(n),unit:"em"};default:throw new e("Invalid unit: '"+s+"'")}},Ce=e=>{const t=new C("mspace");return t.setAttribute("width",e+"em"),t},Ne=(e,t=.3,r=0,n=!1)=>{if(null==e&&0===r)return Ce(t);const s=e?[e]:[];if(0!==t&&s.unshift(Ce(t)),r>0&&s.push(Ce(r)),n){const e=new C("mpadded",s);return e.setAttribute("height","0.1px"),e}return new C("mrow",s)},ze=(e,t)=>Number(e)/qe(t),$e=(e,t,r,n)=>{const s=I(e),o="eq"===e.slice(1,3),a="x"===e.charAt(1)?"1.75":"cd"===e.slice(2,4)?"3.0":o?"1.0":"2.0";s.setAttribute("lspace","0"),s.setAttribute("rspace",o?"0.5em":"0");const l=n.withLevel(n.level<2?2:3),i=ze(a,l.level),c=ze(a,3),m=Ne(null,i.toFixed(4),0),p=Ne(null,c.toFixed(4),0),u=ze(o?0:.3,l.level).toFixed(4);let d,h;const g=t&&t.body&&(t.body.body||t.body.length>0);if(g){let r=ge(t,l);r=Ne(r,u,u,"\\\\cdrightarrow"===e||"\\\\cdleftarrow"===e),d=new C("mover",[r,p])}const f=r&&r.body&&(r.body.body||r.body.length>0);if(f){let e=ge(r,l);e=Ne(e,u,u),h=new C("munder",[e,p])}let b;return b=g||f?g&&f?new C("munderover",[s,h,d]):g?new C("mover",[s,d]):new C("munder",[s,h]):new C("mover",[s,m]),"3.0"===a&&(b.style.height="1em"),b.setAttribute("accent","false"),b};g({type:"xArrow",names:["\\xleftarrow","\\xrightarrow","\\xLeftarrow","\\xRightarrow","\\xleftrightarrow","\\xLeftrightarrow","\\xhookleftarrow","\\xhookrightarrow","\\xmapsto","\\xrightharpoondown","\\xrightharpoonup","\\xleftharpoondown","\\xleftharpoonup","\\xlongequal","\\xtwoheadrightarrow","\\xtwoheadleftarrow","\\xtofrom","\\xleftrightharpoons","\\xrightleftharpoons","\\yields","\\yieldsLeft","\\mesomerism","\\longrightharpoonup","\\longleftharpoondown","\\yieldsLeftRight","\\chemequilibrium","\\\\cdrightarrow","\\\\cdleftarrow","\\\\cdlongequal"],props:{numArgs:1,numOptionalArgs:1},handler:({parser:e,funcName:t},r,n)=>({type:"xArrow",mode:e.mode,name:t,body:r[0],below:n[0]}),mathmlBuilder(e,t){const r=[$e(e.name,e.body,e.below,t)];return r.unshift(Ce(.2778)),r.push(Ce(.2778)),new C("mrow",r)}});const Ee={"\\equilibriumRight":["\\longrightharpoonup","\\eqleftharpoondown"],"\\equilibriumLeft":["\\eqrightharpoonup","\\longleftharpoondown"]};g({type:"stackedArrow",names:["\\equilibriumRight","\\equilibriumLeft"],props:{numArgs:1,numOptionalArgs:1},handler({parser:e,funcName:t},r,n){const s=r[0]?{type:"hphantom",mode:e.mode,body:r[0]}:null,o=n[0]?{type:"hphantom",mode:e.mode,body:n[0]}:null;return{type:"stackedArrow",mode:e.mode,name:t,body:r[0],upperArrowBelow:o,lowerArrowBody:s,below:n[0]}},mathmlBuilder(e,t){const r=Ee[e.name][0],n=Ee[e.name][1],s=$e(r,e.body,e.upperArrowBelow,t),o=$e(n,e.lowerArrowBody,e.below,t);let a;const l=new C("mpadded",[s]);if(l.setAttribute("voffset","0.3em"),l.setAttribute("height","+0.3em"),l.setAttribute("depth","-0.3em"),"\\equilibriumLeft"===e.name){const e=new C("mpadded",[o]);e.setAttribute("width","0.5em"),a=new C("mpadded",[Ce(.2778),e,l,Ce(.2778)])}else l.setAttribute("width","\\equilibriumRight"===e.name?"0.5em":"0"),a=new C("mpadded",[Ce(.2778),l,o,Ce(.2778)]);return a.setAttribute("voffset","-0.18em"),a.setAttribute("height","-0.18em"),a.setAttribute("depth","+0.18em"),a}});const Ie={};function Le({type:e,names:t,props:r,handler:n,mathmlBuilder:s}){const o={type:e,numArgs:r.numArgs||0,allowedInText:!1,numOptionalArgs:0,handler:n};for(let e=0;e<t.length;++e)Ie[t[e]]=o;s&&(h[e]=s)}function Fe(e,t){if(!e||e.type!==t)throw new Error(`Expected node of type ${t}, but got `+(e?`node of type ${e.type}`:String(e)));return e}function je(e){const t=Me(e);if(!t)throw new Error("Expected node of symbol group type, but got "+(e?`node of type ${e.type}`:String(e)));return t}function Me(e){return e&&("atom"===e.type||"delimiter"===e.type||Object.prototype.hasOwnProperty.call(M,e.type))?e:null}const De={">":"\\\\cdrightarrow","<":"\\\\cdleftarrow","=":"\\\\cdlongequal",A:"\\uparrow",V:"\\downarrow","|":"\\Vert",".":"no arrow"},Ge=()=>({type:"styling",body:[],mode:"math",scriptLevel:"display"}),Pe=e=>"textord"===e.type&&"@"===e.text,Re=(e,t)=>("mathord"===e.type||"atom"===e.type)&&e.text===t;function Ue(e,t,r){const n=De[e];switch(n){case"\\\\cdrightarrow":case"\\\\cdleftarrow":return r.callFunction(n,[t[0]],[t[1]]);case"\\uparrow":case"\\downarrow":{const e={type:"atom",text:n,mode:"math",family:"rel"},s={type:"ordgroup",mode:"math",body:[r.callFunction("\\\\cdleft",[t[0]],[]),r.callFunction("\\Big",[e],[]),r.callFunction("\\\\cdright",[t[1]],[])],semisimple:!0};return r.callFunction("\\\\cdparent",[s],[])}case"\\\\cdlongequal":return r.callFunction("\\\\cdlongequal",[],[]);case"\\Vert":{const e={type:"textord",text:"\\Vert",mode:"math"};return r.callFunction("\\Big",[e],[])}default:return{type:"textord",text:" ",mode:"math"}}}g({type:"cdlabel",names:["\\\\cdleft","\\\\cdright"],props:{numArgs:1},handler:({parser:e,funcName:t},r)=>({type:"cdlabel",mode:e.mode,side:t.slice(4),label:r[0]}),mathmlBuilder(e,t){if(0===e.label.body.length)return new C("mrow",t);const r=ge(e.label,t);"left"===e.side&&r.classes.push("tml-shift-left");const n=new C("mtd",[r]);n.style.padding="0";const s=new C("mtr",[n]),o=new C("mtable",[s]),a=new C("mpadded",[o]);return a.setAttribute("width","0.1px"),a.setAttribute("displaystyle","false"),a.setAttribute("scriptlevel","1"),a}}),g({type:"cdlabelparent",names:["\\\\cdparent"],props:{numArgs:1},handler:({parser:e},t)=>({type:"cdlabelparent",mode:e.mode,fragment:t[0]}),mathmlBuilder:(e,t)=>new C("mrow",[ge(e.fragment,t)])});const He=e=>({type:"ordgroup",mode:"math",body:e,semisimple:!0}),_e=(e,t)=>({type:t,mode:"math",body:He(e)});class Ve{constructor(e,t,r){this.lexer=e,this.start=t,this.end=r}static range(e,t){return t?e&&e.loc&&t.loc&&e.loc.lexer===t.loc.lexer?new Ve(e.loc.lexer,e.loc.start,t.loc.end):null:e&&e.loc}}class We{constructor(e,t){this.text=e,this.loc=t}range(e,t){return new We(t,Ve.range(this,e))}}const Xe=0,Ze=1,Ye=2,Je=3,Ke=Object.create(null);function Qe(e,t){Ke[e]=t}const et=Ke;Qe("\\noexpand",function(e){const t=e.popToken();return e.isExpandable(t.text)&&(t.noexpand=!0,t.treatAsRelax=!0),{tokens:[t],numArgs:0}}),Qe("\\expandafter",function(e){const t=e.popToken();return e.expandOnce(!0),{tokens:[t],numArgs:0}}),Qe("\\@firstoftwo",function(e){return{tokens:e.consumeArgs(2)[0],numArgs:0}}),Qe("\\@secondoftwo",function(e){return{tokens:e.consumeArgs(2)[1],numArgs:0}}),Qe("\\@ifnextchar",function(e){const t=e.consumeArgs(3);e.consumeSpaces();const r=e.future();return 1===t[0].length&&t[0][0].text===r.text?{tokens:t[1],numArgs:0}:{tokens:t[2],numArgs:0}}),Qe("\\@ifstar","\\@ifnextchar *{\\@firstoftwo{#1}}"),Qe("\\TextOrMath",function(e){const t=e.consumeArgs(2);return"text"===e.mode?{tokens:t[0],numArgs:0}:{tokens:t[1],numArgs:0}});const tt=e=>{let t="";for(let r=e.length-1;r>-1;r--)t+=e[r].text;return t},rt={0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,a:10,A:10,b:11,B:11,c:12,C:12,d:13,D:13,e:14,E:14,f:15,F:15},nt=e=>{const t=e.future().text;return"EOF"===t?[null,""]:[rt[t.charAt(0)],t]},st=(e,t,r)=>{for(let n=1;n<t.length;n++){e*=r,e+=rt[t.charAt(n)]}return e};function ot(e){const t=e.consumeArgs(1)[0];let r="",n=t[t.length-1].loc.start;for(let e=t.length-1;e>=0;e--){const s=t[e].loc.start;s>n&&(r+=" ",n=s),r+=t[e].text,n+=t[e].text.length}return r}Qe("\\char",function(t){let r,n=t.popToken(),s="";if("'"===n.text)r=8,n=t.popToken();else if('"'===n.text)r=16,n=t.popToken();else if("`"===n.text)if(n=t.popToken(),"\\"===n.text[0])s=n.text.charCodeAt(1);else{if("EOF"===n.text)throw new e("\\char` missing argument");s=n.text.charCodeAt(0)}else r=10;if(r){let o,a=n.text;if(s=rt[a.charAt(0)],null==s||s>=r)throw new e(`Invalid base-${r} digit ${n.text}`);for(s=st(s,a,r),[o,a]=nt(t);null!=o&&o<r;)s*=r,s+=o,s=st(s,a,r),t.popToken(),[o,a]=nt(t)}return`\\@char{${s}}`}),Qe("\\surd","\\sqrt{\\vphantom{|}}"),Qe("⊕","\\oplus"),Qe("\\long",""),Qe("\\bgroup","{"),Qe("\\egroup","}"),Qe("~","\\nobreakspace"),Qe("\\lq","`"),Qe("\\rq","'"),Qe("\\aa","\\r a"),Qe("\\Bbbk","\\Bbb{k}"),Qe("\\mathstrut","\\vphantom{(}"),Qe("\\underbar","\\underline{\\text{#1}}"),Qe("\\vdots","{\\varvdots\\rule{0pt}{15pt}}"),Qe("⋮","\\vdots"),Qe("\\arraystretch","1"),Qe("\\arraycolsep","6pt"),Qe("\\substack","\\begin{subarray}{c}#1\\end{subarray}"),Qe("\\iff","\\DOTSB\\;\\Longleftrightarrow\\;"),Qe("\\implies","\\DOTSB\\;\\Longrightarrow\\;"),Qe("\\impliedby","\\DOTSB\\;\\Longleftarrow\\;");const at={",":"\\dotsc","\\not":"\\dotsb","+":"\\dotsb","=":"\\dotsb","<":"\\dotsb",">":"\\dotsb","-":"\\dotsb","*":"\\dotsb",":":"\\dotsb","\\DOTSB":"\\dotsb","\\coprod":"\\dotsb","\\bigvee":"\\dotsb","\\bigwedge":"\\dotsb","\\biguplus":"\\dotsb","\\bigcap":"\\dotsb","\\bigcup":"\\dotsb","\\prod":"\\dotsb","\\sum":"\\dotsb","\\bigotimes":"\\dotsb","\\bigoplus":"\\dotsb","\\bigodot":"\\dotsb","\\bigsqcap":"\\dotsb","\\bigsqcup":"\\dotsb","\\bigtimes":"\\dotsb","\\And":"\\dotsb","\\longrightarrow":"\\dotsb","\\Longrightarrow":"\\dotsb","\\longleftarrow":"\\dotsb","\\Longleftarrow":"\\dotsb","\\longleftrightarrow":"\\dotsb","\\Longleftrightarrow":"\\dotsb","\\mapsto":"\\dotsb","\\longmapsto":"\\dotsb","\\hookrightarrow":"\\dotsb","\\doteq":"\\dotsb","\\mathbin":"\\dotsb","\\mathrel":"\\dotsb","\\relbar":"\\dotsb","\\Relbar":"\\dotsb","\\xrightarrow":"\\dotsb","\\xleftarrow":"\\dotsb","\\DOTSI":"\\dotsi","\\int":"\\dotsi","\\oint":"\\dotsi","\\iint":"\\dotsi","\\iiint":"\\dotsi","\\iiiint":"\\dotsi","\\DOTSX":"\\dotsx"};Qe("\\dots",function(e){let t="\\dotso";const r=e.expandAfterFuture().text;return r in at?t=at[r]:("\\not"===r.slice(0,4)||r in D.math&&["bin","rel"].includes(D.math[r].group))&&(t="\\dotsb"),t}),Qe("\\dotsb","\\cdots"),Qe("\\dotsm","\\cdots"),Qe("\\dotsi","\\!\\cdots"),Qe("\\idotsint","\\int\\!\\cdots\\!\\int"),Qe("\\dotsx","\\ldots\\,"),Qe("\\DOTSI","\\relax"),Qe("\\DOTSB","\\relax"),Qe("\\DOTSX","\\relax"),Qe("\\tmspace","\\TextOrMath{\\kern#1#3}{\\mskip#1#2}\\relax"),Qe("\\,","{\\tmspace+{3mu}{.1667em}}"),Qe("\\thinspace","\\,"),Qe("\\>","\\mskip{4mu}"),Qe("\\:","{\\tmspace+{4mu}{.2222em}}"),Qe("\\medspace","\\:"),Qe("\\;","{\\tmspace+{5mu}{.2777em}}"),Qe("\\thickspace","\\;"),Qe("\\!","{\\tmspace-{3mu}{.1667em}}"),Qe("\\negthinspace","\\!"),Qe("\\negmedspace","{\\tmspace-{4mu}{.2222em}}"),Qe("\\negthickspace","{\\tmspace-{5mu}{.277em}}"),Qe("\\enspace","\\kern.5em "),Qe("\\enskip","\\hskip.5em\\relax"),Qe("\\quad","\\hskip1em\\relax"),Qe("\\qquad","\\hskip2em\\relax"),Qe("\\AA","\\TextOrMath{\\Angstrom}{\\mathring{A}}\\relax"),Qe("\\tag","\\@ifstar\\tag@literal\\tag@paren"),Qe("\\tag@paren","\\tag@literal{({#1})}"),Qe("\\tag@literal",t=>{if(t.macros.get("\\df@tag"))throw new e("Multiple \\tag");return"\\gdef\\df@tag{\\text{#1}}"}),Qe("\\notag","\\nonumber"),Qe("\\nonumber","\\gdef\\@eqnsw{0}"),Qe("\\bmod","\\mathbin{\\text{mod}}"),Qe("\\pod","\\allowbreak\\mathchoice{\\mkern18mu}{\\mkern8mu}{\\mkern8mu}{\\mkern8mu}(#1)"),Qe("\\pmod","\\pod{{\\rm mod}\\mkern6mu#1}"),Qe("\\mod","\\allowbreak\\mathchoice{\\mkern18mu}{\\mkern12mu}{\\mkern12mu}{\\mkern12mu}{\\rm mod}\\,\\,#1"),Qe("\\newline","\\\\\\relax"),Qe("\\TeX","\\textrm{T}\\kern-.1667em\\raisebox{-.5ex}{E}\\kern-.125em\\textrm{X}"),Qe("\\LaTeX","\\textrm{L}\\kern-.35em\\raisebox{0.2em}{\\scriptstyle A}\\kern-.15em\\TeX"),Qe("\\Temml","\\textrm{T}\\kern-0.2em\\lower{0.2em}{\\textrm{E}}\\kern-0.08em{\\textrm{M}\\kern-0.08em\\raise{0.2em}\\textrm{M}\\kern-0.08em\\textrm{L}}"),Qe("\\hspace","\\@ifstar\\@hspacer\\@hspace"),Qe("\\@hspace","\\hskip #1\\relax"),Qe("\\@hspacer","\\rule{0pt}{0pt}\\hskip #1\\relax"),Qe("\\colon",'\\mathpunct{\\char"3a}'),Qe("\\prescript","\\pres@cript{^{#1}_{#2}}{}{#3}"),Qe("\\ordinarycolon",'\\char"3a'),Qe("\\vcentcolon","\\mathrel{\\raisebox{0.035em}{\\ordinarycolon}}"),Qe("\\coloneq",'\\mathrel{\\raisebox{0.035em}{\\ordinarycolon}\\char"2212}'),Qe("\\Coloneq",'\\mathrel{\\char"2237\\char"2212}'),Qe("\\Eqqcolon",'\\mathrel{\\char"3d\\char"2237}'),Qe("\\Eqcolon",'\\mathrel{\\char"2212\\char"2237}'),Qe("\\colonapprox",'\\mathrel{\\raisebox{0.035em}{\\ordinarycolon}\\char"2248}'),Qe("\\Colonapprox",'\\mathrel{\\char"2237\\char"2248}'),Qe("\\colonsim",'\\mathrel{\\raisebox{0.035em}{\\ordinarycolon}\\char"223c}'),Qe("\\Colonsim",'\\mathrel{\\raisebox{0.035em}{\\ordinarycolon}\\char"223c}'),Qe("\\ratio","\\vcentcolon"),Qe("\\coloncolon","\\dblcolon"),Qe("\\colonequals","\\coloneqq"),Qe("\\coloncolonequals","\\Coloneqq"),Qe("\\equalscolon","\\eqqcolon"),Qe("\\equalscoloncolon","\\Eqqcolon"),Qe("\\colonminus","\\coloneq"),Qe("\\coloncolonminus","\\Coloneq"),Qe("\\minuscolon","\\eqcolon"),Qe("\\minuscoloncolon","\\Eqcolon"),Qe("\\coloncolonapprox","\\Colonapprox"),Qe("\\coloncolonsim","\\Colonsim"),Qe("\\notni","\\mathrel{\\char`∌}"),Qe("\\limsup","\\DOTSB\\operatorname*{lim\\,sup}"),Qe("\\liminf","\\DOTSB\\operatorname*{lim\\,inf}"),Qe("\\injlim","\\DOTSB\\operatorname*{inj\\,lim}"),Qe("\\projlim","\\DOTSB\\operatorname*{proj\\,lim}"),Qe("\\varlimsup","\\DOTSB\\operatorname*{\\overline{\\text{lim}}}"),Qe("\\varliminf","\\DOTSB\\operatorname*{\\underline{\\text{lim}}}"),Qe("\\varinjlim","\\DOTSB\\operatorname*{\\underrightarrow{\\text{lim}}}"),Qe("\\varprojlim","\\DOTSB\\operatorname*{\\underleftarrow{\\text{lim}}}"),Qe("\\centerdot","{\\medspace\\rule{0.167em}{0.189em}\\medspace}"),Qe("\\argmin","\\DOTSB\\operatorname*{arg\\,min}"),Qe("\\argmax","\\DOTSB\\operatorname*{arg\\,max}"),Qe("\\plim","\\DOTSB\\operatorname*{plim}"),Qe("\\leftmodels","\\mathop{\\reflectbox{$\\models$}}"),Qe("\\bra","\\mathinner{\\langle{#1}|}"),Qe("\\ket","\\mathinner{|{#1}\\rangle}"),Qe("\\braket","\\mathinner{\\langle{#1}\\rangle}"),Qe("\\Bra","\\left\\langle#1\\right|"),Qe("\\Ket","\\left|#1\\right\\rangle");const lt=(e,t)=>{const r=`}\\,\\middle${"|"===t[0]?"\\vert":"\\Vert"}\\,{`;return e.slice(0,t.index)+r+e.slice(t.index+t[0].length)};Qe("\\Braket",function(e){let t=ot(e);const r=/\|\||\||\\\|/g;let n;for(;null!==(n=r.exec(t));)t=lt(t,n);return"\\left\\langle{"+t+"}\\right\\rangle"}),Qe("\\Set",function(e){let t=ot(e);const r=/\|\||\||\\\|/.exec(t);return r&&(t=lt(t,r)),"\\left\\{\\:{"+t+"}\\:\\right\\}"}),Qe("\\set",function(e){return"\\{{"+ot(e).replace(/\|/,"}\\mid{")+"}\\}"}),Qe("\\angln","{\\angl n}"),Qe("\\odv","\\@ifstar\\odv@next\\odv@numerator"),Qe("\\odv@numerator","\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}"),Qe("\\odv@next","\\frac{\\mathrm{d}}{\\mathrm{d}#2}#1"),Qe("\\pdv","\\@ifstar\\pdv@next\\pdv@numerator");const it=e=>{const t=e[0][0].text,r=tt(e[1]).split(","),n=String(r.length),s="1"===n?"\\partial":`\\partial^${n}`;let o="";return r.map(e=>{o+="\\partial "+e.trim()+"\\,"}),[t,s,o.replace(/\\,$/,"")]};function ct(e){const t=[];e.consumeSpaces();let r=e.fetch().text;for("\\relax"===r&&(e.consume(),e.consumeSpaces(),r=e.fetch().text);"\\hline"===r||"\\hdashline"===r;)e.consume(),t.push("\\hdashline"===r),e.consumeSpaces(),r=e.fetch().text;return t}Qe("\\pdv@numerator",function(e){const[t,r,n]=it(e.consumeArgs(2));return`\\frac{${r} ${t}}{${n}}`}),Qe("\\pdv@next",function(e){const[t,r,n]=it(e.consumeArgs(2));return`\\frac{${r}}{${n}} ${t}`}),Qe("\\upalpha","\\up@greek{\\alpha}"),Qe("\\upbeta","\\up@greek{\\beta}"),Qe("\\upgamma","\\up@greek{\\gamma}"),Qe("\\updelta","\\up@greek{\\delta}"),Qe("\\upepsilon","\\up@greek{\\epsilon}"),Qe("\\upzeta","\\up@greek{\\zeta}"),Qe("\\upeta","\\up@greek{\\eta}"),Qe("\\uptheta","\\up@greek{\\theta}"),Qe("\\upiota","\\up@greek{\\iota}"),Qe("\\upkappa","\\up@greek{\\kappa}"),Qe("\\uplambda","\\up@greek{\\lambda}"),Qe("\\upmu","\\up@greek{\\mu}"),Qe("\\upnu","\\up@greek{\\nu}"),Qe("\\upxi","\\up@greek{\\xi}"),Qe("\\upomicron","\\up@greek{\\omicron}"),Qe("\\uppi","\\up@greek{\\pi}"),Qe("\\upalpha","\\up@greek{\\alpha}"),Qe("\\uprho","\\up@greek{\\rho}"),Qe("\\upsigma","\\up@greek{\\sigma}"),Qe("\\uptau","\\up@greek{\\tau}"),Qe("\\upupsilon","\\up@greek{\\upsilon}"),Qe("\\upphi","\\up@greek{\\phi}"),Qe("\\upchi","\\up@greek{\\chi}"),Qe("\\uppsi","\\up@greek{\\psi}"),Qe("\\upomega","\\up@greek{\\omega}"),Qe("\\invamp",'\\mathbin{\\char"214b}'),Qe("\\parr",'\\mathbin{\\char"214b}'),Qe("\\upand",'\\mathbin{\\char"214b}'),Qe("\\with",'\\mathbin{\\char"26}'),Qe("\\multimapinv",'\\mathrel{\\char"27dc}'),Qe("\\multimapboth",'\\mathrel{\\char"29df}'),Qe("\\scoh",'{\\mkern5mu\\char"2322\\mkern5mu}'),Qe("\\sincoh",'{\\mkern5mu\\char"2323\\mkern5mu}'),Qe("\\coh",'{\\mkern5mu\\rule{}{0.7em}\\mathrlap{\\smash{\\raise2mu{\\char"2322}}}\n{\\smash{\\lower4mu{\\char"2323}}}\\mkern5mu}'),Qe("\\incoh",'{\\mkern5mu\\rule{}{0.7em}\\mathrlap{\\smash{\\raise2mu{\\char"2323}}}\n{\\smash{\\lower4mu{\\char"2322}}}\\mkern5mu}'),Qe("\\standardstate","\\text{\\tiny\\char`⦵}");const mt=t=>{if(!t.parser.settings.displayMode)throw new e(`{${t.envName}} can be used only in display mode.`)},pt=/([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/,ut=e=>{let t=e.get("\\arraystretch");"string"!=typeof t&&(t=tt(t.tokens)),t=isNaN(t)?null:Number(t);let r=e.get("\\arraycolsep");"string"!=typeof r&&(r=tt(r.tokens));const n=pt.exec(r);return[t,n?{number:+(n[1]+n[2]),unit:n[3]}:null]},dt=t=>{let r="";for(let n=0;n<t.length;n++)if("label"===t[n].type){if(r)throw new e("Multiple \\labels in one row");r=t[n].string}return r};function ht(e){if(-1===e.indexOf("ed"))return-1===e.indexOf("*")}function gt(t,{cols:r,envClasses:n,autoTag:s,singleRow:o,emptySingleRow:a,maxNumCols:l,leqno:i,arraystretch:c,arraycolsep:m},p){const u=n&&n.includes("bordermatrix")?"}":"\\end";t.gullet.beginGroup(),o||t.gullet.macros.set("\\cr","\\\\\\relax"),t.gullet.beginGroup();let d=[];const h=[d],g=[],f=[],b=[],y=null!=s?[]:void 0;function w(){s&&t.gullet.macros.set("\\@eqnsw","1",!0)}function x(){y&&(t.gullet.macros.get("\\df@tag")?(y.push(t.subparse([new We("\\df@tag")])),t.gullet.macros.set("\\df@tag",void 0,!0)):y.push(Boolean(s)&&"1"===t.gullet.macros.get("\\@eqnsw")))}for(w(),b.push(ct(t));;){let r=t.parseExpression(!1,o?"\\end":"\\\\");t.gullet.endGroup(),t.gullet.beginGroup(),r={type:"ordgroup",mode:t.mode,body:r,semisimple:!0},d.push(r);const s=t.fetch().text;if("&"===s){if(l&&d.length===l){if(!n.includes("array"))throw new e(2===l?"The split environment accepts no more than two columns":"The equation environment accepts only one column",t.nextToken);if(t.settings.strict)throw new e("Too few columns specified in the {array} column argument.",t.nextToken)}t.consume()}else{if(s===u){x(),1===d.length&&0===r.body.length&&(h.length>1||!a)&&h.pop(),f.push(dt(r.body)),b.length<h.length+1&&b.push([]);break}if("\\\\"!==s)throw new e("Expected & or \\\\ or \\cr or "+u,t.nextToken);{let e;t.consume()," "!==t.gullet.future().text&&(e=t.parseSizeGroup(!0)),g.push(e?e.value:null),x(),f.push(dt(r.body)),b.push(ct(t)),d=[],h.push(d),w()}}}return t.gullet.endGroup(),t.gullet.endGroup(),{type:"array",mode:t.mode,body:h,cols:r,rowGaps:g,hLinesBeforeRow:b,envClasses:n,autoTag:s,scriptLevel:p,tags:y,labels:f,leqno:i,arraystretch:c,arraycolsep:m}}function ft(e){return"d"===e.slice(0,1)?"display":"text"}const bt={c:"center ",l:"left ",r:"right "},yt=e=>{const t=new C("mtd",[]);return t.style={padding:"0",width:"50%"},e.envClasses.includes("multline")&&(t.style.width="7.5%"),t},wt=function(e,t){const r=[],n=e.body.length,s=e.hLinesBeforeRow,o=e.tags&&e.tags.some(e=>e);for(let a=0;a<n;a++){const l=e.body[a],i=[],c="text"===e.scriptLevel?Ze:"script"===e.scriptLevel?Ye:Xe;for(let r=0;r<l.length;r++){const s=new C("mtd",[ge(l[r],t.withLevel(c))]);if(e.envClasses.includes("multline")){const e=0===a?"left":a===n-1?"right":"center";"center"!==e&&s.classes.push("tml-"+e)}i.push(s)}const m=e.body[0].length;for(let e=0;e<m-l.length;e++)i.push(new C("mtd",[],[],t));if(o){const r=e.tags[a];let n;!0===r?n=new C("mtext",[new T(["tml-eqn"])]):!1===r?n=new C("mtext",[],[]):(n=he(r[0].body,t.withLevel(c),!0),n=ie(n),n.classes=["tml-tag"]),n&&(i.unshift(yt(e)),i.push(yt(e)),e.leqno?i[0].children.push(n):i[i.length-1].children.push(n))}const p=new C("mtr",i,[]),u=e.labels.shift();u&&e.tags&&e.tags[a]&&(p.setAttribute("id",u),Array.isArray(e.tags[a])&&p.classes.push("tml-tageqn")),0===a&&s[0].length>0&&(2===s[0].length?p.children.forEach(e=>{e.style.borderTop="0.15em double"}):p.children.forEach(e=>{e.style.borderTop=s[0][0]?"0.06em dashed":"0.06em solid"})),s[a+1].length>0&&(2===s[a+1].length?p.children.forEach(e=>{e.style.borderBottom="0.15em double"}):p.children.forEach(e=>{e.style.borderBottom=s[a+1][0]?"0.06em dashed":"0.06em solid"}));let d=!0;for(let e=0;e<p.children.length;e++){const t=p.children[e].children[0];if(!t||"mpadded"!==t.type||"0px"!==t.attributes.height){d=!1;break}}if(d){p.classes.push("ff-squash");for(let e=0;e<p.children.length;e++)p.children[e].style.paddingTop="0",p.children[e].style.paddingBottom="0"}r.push(p)}if(e.arraystretch&&1!==e.arraystretch){const t=String(1.4*e.arraystretch-.8)+"ex";for(let e=0;e<r.length;e++)for(let n=0;n<r[e].children.length;n++)r[e].children[n].style.paddingTop=t,r[e].children[n].style.paddingBottom=t}let a,l;if(e.envClasses.length>0&&(a=e.envClasses.includes("abut")||e.envClasses.includes("cases")?"0":e.envClasses.includes("small")?"0.1389":e.envClasses.includes("cd")?"0.25":"0.4",l="em"),e.arraycolsep){const r=Be(e.arraycolsep,t);a=r.number.toFixed(4),l=r.unit}if(a){const t=0===r.length?0:r[0].children.length,n=(r,n)=>0===r&&0===n||r===t-1&&1===n?"0":"align"!==e.envClasses[0]?a:1===n?"0":o?r%2?"1":"0":r%2?"0":"1";for(let e=0;e<r.length;e++)for(let t=0;t<r[e].children.length;t++)r[e].children[t].style.paddingLeft=`${n(t,0)}${l}`,r[e].children[t].style.paddingRight=`${n(t,1)}${l}`}if(0===e.envClasses.length)for(let e=0;e<r.length;e++)r[e].children[0].style.paddingLeft="0em",r[e].children.length===r[0].children.length&&(r[e].children[r[e].children.length-1].style.paddingRight="0em");if(e.envClasses.length>0){const t=e.envClasses.includes("align")||e.envClasses.includes("alignat");for(let n=0;n<r.length;n++){const s=r[n];if(t){for(let e=0;e<s.children.length;e++)s.children[e].classes=["tml-"+(e%2?"left":"right")];if(o){const t=e.leqno?0:s.children.length-1;s.children[t].classes=[]}}if(s.children.length>1&&e.envClasses.includes("cases")&&(s.children[1].style.paddingLeft="1em"),e.envClasses.includes("cases")||e.envClasses.includes("subarray"))for(const e of s.children)e.classes.push("tml-left")}}let i=new C("mtable",r);if(e.envClasses.length>0&&(e.envClasses.includes("jot")?i.classes.push("tml-jot"):e.envClasses.includes("small")&&i.classes.push("tml-small")),"display"===e.scriptLevel&&i.setAttribute("displaystyle","true"),(e.autoTag||e.envClasses.includes("multline"))&&(i.style.width="100%"),e.cols&&e.cols.length>0){const t=e.cols;let r=!1,n=0,s=t.length;for(;"separator"===t[n].type;)n+=1;for(;"separator"===t[s-1].type;)s-=1;if("separator"===t[0].type){const e="separator"===t[1].type?"0.15em double":"|"===t[0].separator?"0.06em solid ":"0.06em dashed ";for(const t of i.children)t.children[0].style.borderLeft=e}let a=o?0:-1;for(let e=n;e<s;e++)if("align"===t[e].type){const n=bt[t[e].align];a+=1;for(const e of i.children)"center"!==n.trim()&&a<e.children.length&&(e.children[a].classes=["tml-"+n.trim()]);r=!0}else if("separator"===t[e].type){if(r){const r="separator"===t[e+1].type?"0.15em double":"|"===t[e].separator?"0.06em solid":"0.06em dashed";for(const e of i.children)a<e.children.length&&(e.children[a].style.borderRight=r)}r=!1}if("separator"===t[t.length-1].type){const e="separator"===t[t.length-2].type?"0.15em double":"|"===t[t.length-1].separator?"0.06em solid":"0.06em dashed";for(const t of i.children)t.children[t.children.length-1].style.borderRight=e,t.children[t.children.length-1].style.paddingRight="0.4em"}}return e.envClasses.includes("small")&&(i=new C("mstyle",[i]),i.setAttribute("scriptlevel","1")),i},xt=function(t,r){-1===t.envName.indexOf("ed")&&mt(t);const n="split"===t.envName,s=[],o=gt(t.parser,{cols:s,emptySingleRow:!0,autoTag:n?void 0:ht(t.envName),envClasses:["abut","jot"],maxNumCols:"split"===t.envName?2:void 0,leqno:t.parser.settings.leqno},"display");let a,l=0;const i=t.envName.indexOf("at")>-1;if(r[0]&&i){let t="";for(let e=0;e<r[0].body.length;e++){t+=Fe(r[0].body[e],"textord").text}if(isNaN(t))throw new e("The alignat enviroment requires a numeric first argument.");a=Number(t),l=2*a}o.body.forEach(function(t){if(i){const r=t.length/2;if(a<r)throw new e(`Too many math in a row: expected ${a}, but got ${r}`,t[0])}else l<t.length&&(l=t.length)});for(let e=0;e<l;++e){let t="r";e%2==1&&(t="l"),s[e]={type:"align",align:t}}return"split"===t.envName||(i?o.envClasses.push("alignat"):o.envClasses[0]="align"),o};Le({type:"array",names:["array","darray"],props:{numArgs:1},handler(t,r){const n=(Me(r[0])?[r[0]]:Fe(r[0],"ordgroup").body).map(function(t){const r=je(t).text;if(-1!=="lcr".indexOf(r))return{type:"align",align:r};if("|"===r)return{type:"separator",separator:"|"};if(":"===r)return{type:"separator",separator:":"};throw new e("Unknown column alignment: "+r,t)}),[s,o]=ut(t.parser.gullet.macros),a={cols:n,envClasses:["array"],maxNumCols:n.length,arraystretch:s,arraycolsep:o};return gt(t.parser,a,ft(t.envName))},mathmlBuilder:wt}),Le({type:"array",names:["matrix","pmatrix","bmatrix","Bmatrix","vmatrix","Vmatrix","matrix*","pmatrix*","bmatrix*","Bmatrix*","vmatrix*","Vmatrix*"],props:{numArgs:0},handler(t){const r={matrix:null,pmatrix:["(",")"],bmatrix:["[","]"],Bmatrix:["\\{","\\}"],vmatrix:["|","|"],Vmatrix:["\\Vert","\\Vert"]}[t.envName.replace("*","")];let n="c";const s={envClasses:[],cols:[]};if("*"===t.envName.charAt(t.envName.length-1)){const r=t.parser;if(r.consumeSpaces(),"["===r.fetch().text){if(r.consume(),r.consumeSpaces(),n=r.fetch().text,-1==="lcr".indexOf(n))throw new e("Expected l or c or r",r.nextToken);r.consume(),r.consumeSpaces(),r.expect("]"),r.consume(),s.cols=[]}}const o=gt(t.parser,s,"text");o.cols=o.body.length>0?new Array(o.body[0].length).fill({type:"align",align:n}):[];const[a,l]=ut(t.parser.gullet.macros);return o.arraystretch=a,!l||6===l&&"pt"===l||(o.arraycolsep=l),r?{type:"leftright",mode:t.mode,body:[o],left:r[0],right:r[1],rightColor:void 0}:o},mathmlBuilder:wt}),Le({type:"array",names:["bordermatrix"],props:{numArgs:0},handler(e){const t=gt(e.parser,{cols:[],envClasses:["bordermatrix"]},"text");return t.cols=t.body.length>0?new Array(t.body[0].length).fill({type:"align",align:"c"}):[],t.envClasses=[],t.arraystretch=1,"matrix"===e.envName?t:((e,t)=>{const r=e.body;r[0].shift();const n=new Array(r.length-1).fill().map(()=>[]);for(let e=1;e<r.length;e++){n[e-1].push(r[e].shift());const t=[];for(let n=0;n<r[e].length;n++)t.push(r[e][n]);n[e-1].push(_e(t,"vphantom"))}const s=new Array(r.length).fill().map(()=>[]);for(let e=0;e<r[0].length;e++)s[0].push(r[0][e]);for(let e=1;e<r.length;e++)for(let t=0;t<r[0].length;t++)s[e].push(_e(r[e][t].body,"hphantom"));for(let e=0;e<r[0].length;e++)r[0][e]=_e(r[0][e].body,"hphantom");const o={type:"array",mode:"math",body:n,cols:[{type:"align",align:"c"}],rowGaps:new Array(n.length-1).fill(null),hLinesBeforeRow:new Array(n.length+1).fill().map(()=>[]),envClasses:[],scriptLevel:"text",arraystretch:1,labels:new Array(n.length).fill(""),arraycolsep:{number:.04,unit:"em"}},a={type:"styling",mode:"math",scriptLevel:"text",body:[{type:"array",mode:"math",body:s,cols:new Array(s.length).fill({type:"align",align:"c"}),rowGaps:new Array(s.length-1).fill(null),hLinesBeforeRow:new Array(s.length+1).fill().map(()=>[]),envClasses:[],scriptLevel:"text",arraystretch:1,labels:new Array(s.length).fill(""),arraycolsep:null}]},l={type:"leftright",mode:"math",body:[e],left:t?t[0]:"(",right:t?t[1]:")",rightColor:void 0};return He([o,{type:"supsub",mode:"math",stack:!0,base:{type:"op",mode:"math",limits:!0,alwaysHandleSupSub:!0,parentIsSupSub:!0,symbol:!1,suppressBaseShift:!0,body:[l]},sup:a,sub:null}])})(t,e.delimiters)},mathmlBuilder:wt}),Le({type:"array",names:["smallmatrix"],props:{numArgs:0},handler:e=>gt(e.parser,{envClasses:["small"]},"script"),mathmlBuilder:wt}),Le({type:"array",names:["subarray"],props:{numArgs:1},handler(t,r){const n=(Me(r[0])?[r[0]]:Fe(r[0],"ordgroup").body).map(function(t){const r=je(t).text;if(-1!=="lc".indexOf(r))return{type:"align",align:r};throw new e("Unknown column alignment: "+r,t)});if(n.length>1)throw new e("{subarray} can contain only one column");let s={cols:n,envClasses:["small"]};if(s=gt(t.parser,s,"script"),s.body.length>0&&s.body[0].length>1)throw new e("{subarray} can contain only one column");return s},mathmlBuilder:wt}),Le({type:"array",names:["cases","dcases","rcases","drcases"],props:{numArgs:0},handler(e){const t=gt(e.parser,{cols:[],envClasses:["cases"]},ft(e.envName));return{type:"leftright",mode:e.mode,body:[t],left:e.envName.indexOf("r")>-1?".":"\\{",right:e.envName.indexOf("r")>-1?"\\}":".",rightColor:void 0}},mathmlBuilder:wt}),Le({type:"array",names:["align","align*","aligned","split"],props:{numArgs:0},handler:xt,mathmlBuilder:wt}),Le({type:"array",names:["alignat","alignat*","alignedat"],props:{numArgs:1},handler:xt,mathmlBuilder:wt}),Le({type:"array",names:["gathered","gather","gather*"],props:{numArgs:0},handler(e){"gathered"!==e.envName&&mt(e);const t={cols:[],envClasses:["abut","jot"],autoTag:ht(e.envName),emptySingleRow:!0,leqno:e.parser.settings.leqno};return gt(e.parser,t,"display")},mathmlBuilder:wt}),Le({type:"array",names:["equation","equation*"],props:{numArgs:0},handler(e){mt(e);const t={autoTag:ht(e.envName),emptySingleRow:!0,singleRow:!0,maxNumCols:1,envClasses:["align"],leqno:e.parser.settings.leqno};return gt(e.parser,t,"display")},mathmlBuilder:wt}),Le({type:"array",names:["multline","multline*"],props:{numArgs:0},handler(e){mt(e);const t={autoTag:"multline"===e.envName,maxNumCols:1,envClasses:["jot","multline"],leqno:e.parser.settings.leqno};return gt(e.parser,t,"display")},mathmlBuilder:wt}),Le({type:"array",names:["CD"],props:{numArgs:0},handler:t=>(mt(t),function(t){const r=[];for(t.gullet.beginGroup(),t.gullet.macros.set("\\cr","\\\\\\relax"),t.gullet.beginGroup();;){r.push(t.parseExpression(!1,"\\\\")),t.gullet.endGroup(),t.gullet.beginGroup();const n=t.fetch().text;if("&"!==n&&"\\\\"!==n){if("\\end"===n){0===r[r.length-1].length&&r.pop();break}throw new e("Expected \\\\ or \\cr or \\end",t.nextToken)}t.consume()}let n=[];const s=[n];for(let o=0;o<r.length;o++){const a=r[o];let l=Ge();for(let r=0;r<a.length;r++)if(Pe(a[r])){n.push(l),r+=1;const s=je(a[r]).text,o=new Array(2);if(o[0]={type:"ordgroup",mode:"math",body:[]},o[1]={type:"ordgroup",mode:"math",body:[]},"=|.".indexOf(s)>-1);else{if(!("<>AV".indexOf(s)>-1))throw new e('Expected one of "<>AV=|." after @.');for(let t=0;t<2;t++){let n=!0;for(let l=r+1;l<a.length;l++){if(Re(a[l],s)){n=!1,r=l;break}if(Pe(a[l]))throw new e("Missing a "+s+" character to complete a CD arrow.",a[l]);o[t].body.push(a[l])}if(n)throw new e("Missing a "+s+" character to complete a CD arrow.",a[r])}}const i=Ue(s,o,t);n.push(i),l=Ge()}else l.body.push(a[r]);o%2==0?n.push(l):n.shift(),n=[],s.push(n)}return s.pop(),t.gullet.endGroup(),t.gullet.endGroup(),{type:"array",mode:"math",body:s,tags:null,labels:new Array(s.length+1).fill(""),envClasses:["jot","cd"],cols:[],hLinesBeforeRow:new Array(s.length+1).fill([])}}(t.parser)),mathmlBuilder:wt}),g({type:"text",names:["\\hline","\\hdashline"],props:{numArgs:0,allowedInText:!0,allowedInMath:!0},handler(t,r){throw new e(`${t.funcName} valid only within array environment`)}});const kt=Ie;g({type:"bordermatrix",names:["\\bordermatrix","\\matrix"],props:{numArgs:0,numOptionalArgs:1},handler:({parser:e,funcName:t},r,n)=>{let s=["(",")"];if("\\bordermatrix"===t&&n[0]&&n[0].body){const e=n[0].body;1===e.length&&"delimiter"===e[0].type&&(s=[e[0].left,e[0].right])}e.consumeSpaces(),e.consume();const o=kt.bordermatrix,a={mode:e.mode,envName:t.slice(1),delimiters:s,parser:e},l=o.handler(a);return e.expect("}",!0),l}}),g({type:"cancelto",names:["\\cancelto"],props:{numArgs:2},handler({parser:e},t){const r=t[0],n=t[1];return{type:"cancelto",mode:e.mode,body:n,to:r,isCharacterBox:i(n)}},mathmlBuilder(e,t){const r=new C("mrow",[ge(e.body,t)],["ff-narrow"]),n=new C("mphantom",[ge(e.body,t)]),s=new C("mrow",[n],["tml-cancelto"]);s.style.color=t.color,e.isCharacterBox&&m.indexOf(e.body.body[0].text)>-1&&(s.style.left="0.1em",s.style.width="90%");const o=new C("mrow",[r,s],["menclose"]);if(!e.isCharacterBox||/[f∫∑]/.test(e.body.body[0].text))n.style.paddingRight="0.2em";else{n.style.padding="0.5ex 0.1em 0 0";const e=new C("mspace",[]);e.setAttribute("height","0.85em"),r.children.push(e)}let a;if(e.isCharacterBox)a=new C("mspace",[]),a.setAttribute("height","1em");else{const r=ge(e.body,t),n=new C("mpadded",[r]);n.setAttribute("width","0.1px"),a=new C("mphantom",[n])}const l=ge(e.to,t);l.style.color=t.color;const i=new C("mpadded",[l]);if(!e.isCharacterBox||/[f∫∑]/.test(e.body.body[0].text)){const e=new C("mspace",[]);e.setAttribute("width","0.2em"),i.children.unshift(e)}i.setAttribute("width","0.1px");const c=new C("mover",[a,i]),p=new C("mrow",[],["ff-nudge-left"]);return B([ce([o,c]),p])}}),g({type:"textord",names:["\\@char"],props:{numArgs:1,allowedInText:!0},handler({parser:t,token:r},n){const s=Fe(n[0],"ordgroup").body;let o="";for(let e=0;e<s.length;e++){o+=Fe(s[e],"textord").text}const a=parseInt(o);if(isNaN(a))throw new e(`\\@char has non-numeric argument ${o}`,r);return{type:"textord",mode:t.mode,text:String.fromCodePoint(a)}}});const vt=/^(#[a-f0-9]{3}|#?[a-f0-9]{6})$/i,At=/^(#[a-f0-9]{3}|#?[a-f0-9]{6}|[a-z]+)$/i,Tt=/^ *\d{1,3} *(?:, *\d{1,3} *){2}$/,St=/^ *[10](?:\.\d*)? *(?:, *[10](?:\.\d*)? *){2}$/,Ot=/^[a-f0-9]{6}$/i,qt=e=>{let t=e.toString(16);return 1===t.length&&(t="0"+t),t},Bt=JSON.parse('{\n  "Apricot": "#ffb484",\n  "Aquamarine": "#08b4bc",\n  "Bittersweet": "#c84c14",\n  "blue": "#0000FF",\n  "Blue": "#303494",\n  "BlueGreen": "#08b4bc",\n  "BlueViolet": "#503c94",\n  "BrickRed": "#b8341c",\n  "brown": "#BF8040",\n  "Brown": "#802404",\n  "BurntOrange": "#f8941c",\n  "CadetBlue": "#78749c",\n  "CarnationPink": "#f884b4",\n  "Cerulean": "#08a4e4",\n  "CornflowerBlue": "#40ace4",\n  "cyan": "#00FFFF",\n  "Cyan": "#08acec",\n  "Dandelion": "#ffbc44",\n  "darkgray": "#404040",\n  "DarkOrchid": "#a8548c",\n  "Emerald": "#08ac9c",\n  "ForestGreen": "#089c54",\n  "Fuchsia": "#90348c",\n  "Goldenrod": "#ffdc44",\n  "gray": "#808080",\n  "Gray": "#98949c",\n  "green": "#00FF00",\n  "Green": "#08a44c",\n  "GreenYellow": "#e0e474",\n  "JungleGreen": "#08ac9c",\n  "Lavender": "#f89cc4",\n  "lightgray": "#c0c0c0",\n  "lime": "#BFFF00",\n  "LimeGreen": "#90c43c",\n  "magenta": "#FF00FF",\n  "Magenta": "#f0048c",\n  "Mahogany": "#b0341c",\n  "Maroon": "#b03434",\n  "Melon": "#f89c7c",\n  "MidnightBlue": "#086494",\n  "Mulberry": "#b03c94",\n  "NavyBlue": "#086cbc",\n  "olive": "#7F7F00",\n  "OliveGreen": "#407c34",\n  "orange": "#FF8000",\n  "Orange": "#f8843c",\n  "OrangeRed": "#f0145c",\n  "Orchid": "#b074ac",\n  "Peach": "#f8945c",\n  "Periwinkle": "#8074bc",\n  "PineGreen": "#088c74",\n  "pink": "#ff7f7f",\n  "Plum": "#98248c",\n  "ProcessBlue": "#08b4ec",\n  "purple": "#BF0040",\n  "Purple": "#a0449c",\n  "RawSienna": "#983c04",\n  "red": "#ff0000",\n  "Red": "#f01c24",\n  "RedOrange": "#f86434",\n  "RedViolet": "#a0246c",\n  "Rhodamine": "#f0549c",\n  "Royallue": "#0874bc",\n  "RoyalPurple": "#683c9c",\n  "RubineRed": "#f0047c",\n  "Salmon": "#f8948c",\n  "SeaGreen": "#30bc9c",\n  "Sepia": "#701404",\n  "SkyBlue": "#48c4dc",\n  "SpringGreen": "#c8dc64",\n  "Tan": "#e09c74",\n  "teal": "#007F7F",\n  "TealBlue": "#08acb4",\n  "Thistle": "#d884b4",\n  "Turquoise": "#08b4cc",\n  "violet": "#800080",\n  "Violet": "#60449c",\n  "VioletRed": "#f054a4",\n  "WildStrawberry": "#f0246c",\n  "yellow": "#FFFF00",\n  "Yellow": "#fff404",\n  "YellowGreen": "#98cc6c",\n  "YellowOrange": "#ffa41c"\n}'),Ct=(t,r)=>{let n="";if("HTML"===t){if(!vt.test(r))throw new e("Invalid HTML input.");n=r}else if("RGB"===t){if(!Tt.test(r))throw new e("Invalid RGB input.");r.split(",").map(e=>{n+=qt(Number(e.trim()))})}else{if(!St.test(r))throw new e("Invalid rbg input.");r.split(",").map(t=>{const r=Number(t.trim());if(r>1)throw new e("Color rgb input must be < 1.");n+=qt(Number((255*r).toFixed(0)))})}return"#"!==n.charAt(0)&&(n="#"+n),n},Nt=(t,r,n)=>{const s=`\\\\color@${t}`;if(!At.exec(t))throw new e("Invalid color: '"+t+"'",n);return Ot.test(t)?"#"+t:("#"===t.charAt(0)||(r.has(s)?t=r.get(s).tokens[0].text:Bt[t]&&(t=Bt[t])),t)},zt=(e,t)=>{let r=de(e.body,t.withColor(e.color));return 0===r.length&&r.push(new C("mrow")),r=r.map(t=>(t.style.color=e.color,t)),B(r)};g({type:"color",names:["\\textcolor"],props:{numArgs:2,numOptionalArgs:1,allowedInText:!0,argTypes:["raw","raw","original"]},handler({parser:e,token:t},r,n){const s=n[0]&&Fe(n[0],"raw").string;let o="";if(s){const e=Fe(r[0],"raw").string;o=Ct(s,e)}else o=Nt(Fe(r[0],"raw").string,e.gullet.macros,t);const a=r[1];return{type:"color",mode:e.mode,color:o,isTextColor:!0,body:y(a)}},mathmlBuilder:zt}),g({type:"color",names:["\\color"],props:{numArgs:1,numOptionalArgs:1,allowedInText:!0,argTypes:["raw","raw"]},handler({parser:e,breakOnTokenText:t,token:r},n,s){const o=s[0]&&Fe(s[0],"raw").string;let a="";if(o){const e=Fe(n[0],"raw").string;a=Ct(o,e)}else a=Nt(Fe(n[0],"raw").string,e.gullet.macros,r);const l=e.parseExpression(!0,t,!0);return{type:"color",mode:e.mode,color:a,isTextColor:!1,body:l}},mathmlBuilder:zt}),g({type:"color",names:["\\definecolor"],props:{numArgs:3,allowedInText:!0,argTypes:["raw","raw","raw"]},handler({parser:t,funcName:r,token:n},s){const o=Fe(s[0],"raw").string;if(!/^[A-Za-z]+$/.test(o))throw new e("Color name must be latin letters.",n);const a=Fe(s[1],"raw").string;if(!["HTML","RGB","rgb"].includes(a))throw new e("Color model must be HTML, RGB, or rgb.",n);const l=Fe(s[2],"raw").string,i=Ct(a,l);return t.gullet.macros.set(`\\\\color@${o}`,{tokens:[{text:i}],numArgs:0}),{type:"internal",mode:t.mode}}}),g({type:"cr",names:["\\\\"],props:{numArgs:0,numOptionalArgs:0,allowedInText:!0},handler({parser:e},t,r){const n="["===e.gullet.future().text?e.parseSizeGroup(!0):null,s=!e.settings.displayMode;return{type:"cr",mode:e.mode,newLine:s,size:n&&Fe(n,"size").value}},mathmlBuilder(e,t){const r=new C("mo");if(e.newLine&&(r.setAttribute("linebreak","newline"),e.size)){const n=Be(e.size,t);r.setAttribute("height",n.number+n.unit)}return r}});const $t={"\\global":"\\global","\\long":"\\\\globallong","\\\\globallong":"\\\\globallong","\\def":"\\gdef","\\gdef":"\\gdef","\\edef":"\\xdef","\\xdef":"\\xdef","\\let":"\\\\globallet","\\futurelet":"\\\\globalfuture"},Et=t=>{const r=t.text;if(/^(?:[\\{}$&#^_]|EOF)$/.test(r))throw new e("Expected a control sequence",t);return r},It=(e,t,r,n)=>{let s=e.gullet.macros.get(r.text);null==s&&(r.noexpand=!0,s={tokens:[r],numArgs:0,unexpandable:!e.gullet.isExpandable(r.text)}),e.gullet.macros.set(t,s,n)};g({type:"internal",names:["\\global","\\long","\\\\globallong"],props:{numArgs:0,allowedInText:!0},handler({parser:t,funcName:r}){t.consumeSpaces();const n=t.fetch();if($t[n.text])return"\\global"!==r&&"\\\\globallong"!==r||(n.text=$t[n.text]),Fe(t.parseFunction(),"internal");throw new e("Invalid token after macro prefix",n)}}),g({type:"internal",names:["\\def","\\gdef","\\edef","\\xdef"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler({parser:t,funcName:r}){let n=t.gullet.popToken();const s=n.text;if(/^(?:[\\{}$&#^_]|EOF)$/.test(s))throw new e("Expected a control sequence",n);let o,a=0;const l=[[]];for(;"{"!==t.gullet.future().text;)if(n=t.gullet.popToken(),"#"===n.text){if("{"===t.gullet.future().text){o=t.gullet.future(),l[a].push("{");break}if(n=t.gullet.popToken(),!/^[1-9]$/.test(n.text))throw new e(`Invalid argument number "${n.text}"`);if(parseInt(n.text)!==a+1)throw new e(`Argument number "${n.text}" out of order`);a++,l.push([])}else{if("EOF"===n.text)throw new e("Expected a macro definition");l[a].push(n.text)}let{tokens:i}=t.gullet.consumeArg();if(o&&i.unshift(o),"\\edef"===r||"\\xdef"===r){if(i=t.gullet.expandTokens(i),i.length>t.gullet.settings.maxExpand)throw new e("Too many expansions in an "+r);i.reverse()}return t.gullet.macros.set(s,{tokens:i,numArgs:a,delimiters:l},r===$t[r]),{type:"internal",mode:t.mode}}}),g({type:"internal",names:["\\let","\\\\globallet"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler({parser:e,funcName:t}){const r=Et(e.gullet.popToken());e.gullet.consumeSpaces();const n=(e=>{let t=e.gullet.popToken();return"="===t.text&&(t=e.gullet.popToken()," "===t.text&&(t=e.gullet.popToken())),t})(e);return It(e,r,n,"\\\\globallet"===t),{type:"internal",mode:e.mode}}}),g({type:"internal",names:["\\futurelet","\\\\globalfuture"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler({parser:e,funcName:t}){const r=Et(e.gullet.popToken()),n=e.gullet.popToken(),s=e.gullet.popToken();return It(e,r,s,"\\\\globalfuture"===t),e.gullet.pushToken(s),e.gullet.pushToken(n),{type:"internal",mode:e.mode}}}),g({type:"internal",names:["\\newcommand","\\renewcommand","\\providecommand"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler({parser:t,funcName:r}){let n="";const s=t.gullet.popToken();"{"===s.text?(n=Et(t.gullet.popToken()),t.gullet.popToken()):n=Et(s);const o=t.gullet.isDefined(n);if(o&&"\\newcommand"===r)throw new e(`\\newcommand{${n}} attempting to redefine ${n}; use \\renewcommand`);if(!o&&"\\renewcommand"===r)throw new e(`\\renewcommand{${n}} when command ${n} does not yet exist; use \\newcommand`);let a=0;if("["===t.gullet.future().text){let r=t.gullet.popToken();if(r=t.gullet.popToken(),!/^[0-9]$/.test(r.text))throw new e(`Invalid number of arguments: "${r.text}"`);if(a=parseInt(r.text),r=t.gullet.popToken(),"]"!==r.text)throw new e(`Invalid argument "${r.text}"`)}const{tokens:l}=t.gullet.consumeArg();return"\\providecommand"===r&&t.gullet.macros.has(n)||t.gullet.macros.set(n,{tokens:l,numArgs:a}),{type:"internal",mode:t.mode}}});const Lt={"\\bigl":{mclass:"mopen",size:1},"\\Bigl":{mclass:"mopen",size:2},"\\biggl":{mclass:"mopen",size:3},"\\Biggl":{mclass:"mopen",size:4},"\\bigr":{mclass:"mclose",size:1},"\\Bigr":{mclass:"mclose",size:2},"\\biggr":{mclass:"mclose",size:3},"\\Biggr":{mclass:"mclose",size:4},"\\bigm":{mclass:"mrel",size:1},"\\Bigm":{mclass:"mrel",size:2},"\\biggm":{mclass:"mrel",size:3},"\\Biggm":{mclass:"mrel",size:4},"\\big":{mclass:"mord",size:1},"\\Big":{mclass:"mord",size:2},"\\bigg":{mclass:"mord",size:3},"\\Bigg":{mclass:"mord",size:4}},Ft={"(":")","\\lparen":"\\rparen","[":"]","\\lbrack":"\\rbrack","\\{":"\\}","\\lbrace":"\\rbrace","⦇":"⦈","\\llparenthesis":"\\rrparenthesis","\\lfloor":"\\rfloor","⌊":"⌋","\\lceil":"\\rceil","⌈":"⌉","\\langle":"\\rangle","⟨":"⟩","\\lAngle":"\\rAngle","⟪":"⟫","\\llangle":"\\rrangle","⦉":"⦊","\\lvert":"\\rvert","\\lVert":"\\rVert","\\lgroup":"\\rgroup","⟮":"⟯","\\lmoustache":"\\rmoustache","⎰":"⎱","\\llbracket":"\\rrbracket","⟦":"⟧","\\lBrace":"\\rBrace","⦃":"⦄"},jt=new Set(Object.keys(Ft));new Set(Object.values(Ft));const Mt=new Set(["(","\\lparen",")","\\rparen","[","\\lbrack","]","\\rbrack","\\{","\\lbrace","\\}","\\rbrace","⦇","\\llparenthesis","⦈","\\rrparenthesis","\\lfloor","\\rfloor","⌊","⌋","\\lceil","\\rceil","⌈","⌉","<",">","\\langle","⟨","\\rangle","⟩","\\lAngle","⟪","\\rAngle","⟫","\\llangle","⦉","\\rrangle","⦊","\\lt","\\gt","\\lvert","\\rvert","\\lVert","\\rVert","\\lgroup","\\rgroup","⟮","⟯","\\lmoustache","\\rmoustache","⎰","⎱","\\llbracket","\\rrbracket","⟦","⟧","\\lBrace","\\rBrace","⦃","⦄","/","\\backslash","|","\\vert","\\|","\\Vert","‖","\\uparrow","\\Uparrow","\\downarrow","\\Downarrow","\\updownarrow","\\Updownarrow","."]),Dt=new Set(["}","\\left","\\middle","\\right"]),Gt=e=>e.length>0&&(Mt.has(e)||Lt[e]||Dt.has(e)),Pt=[0,1.2,1.8,2.4,3];function Rt(t,r){"ordgroup"===t.type&&1===t.body.length&&(t=t.body[0]);const n=Me(t);if(n&&Mt.has(n.text))return"<"!==n.text&&"\\lt"!==n.text||(n.text="⟨"),">"!==n.text&&"\\gt"!==n.text||(n.text="⟩"),n;throw new e(n?`Invalid delimiter '${n.text}' after '${r.funcName}'`:`Invalid delimiter type '${t.type}'`,t)}const Ut=new Set(["/","\\","\\backslash","∖","\\vert","|"]),Ht=(e,t,r,n)=>{const s=new C("mo",[ae("."===e?"":e,t)]);return s.setAttribute("fence","true"),s.setAttribute("form",r),s.setAttribute("stretchy",n?"true":"false"),s};function _t(e){if(!e.body)throw new Error("Bug: The delim ParseNode wasn't fully parsed.")}g({type:"delimsizing",names:["\\bigl","\\Bigl","\\biggl","\\Biggl","\\bigr","\\Bigr","\\biggr","\\Biggr","\\bigm","\\Bigm","\\biggm","\\Biggm","\\big","\\Big","\\bigg","\\Bigg"],props:{numArgs:1,argTypes:["primitive"]},handler:(e,t)=>{const r=Rt(t[0],e),n={type:"delimsizing",mode:e.parser.mode,size:Lt[e.funcName].size,mclass:Lt[e.funcName].mclass,delim:r.text},s=e.parser.fetch().text;return"^"!==s&&"_"!==s?n:{type:"ordgroup",mode:"math",body:[n,{type:"ordgroup",mode:"math",body:[]}]}},mathmlBuilder:e=>{const t=[],r="."===e.delim?"":e.delim;t.push(ae(r,e.mode));const n=new C("mo",t);return"mopen"===e.mclass||"mclose"===e.mclass?n.setAttribute("fence","true"):n.setAttribute("fence","false"),(Ut.has(r)||r.indexOf("arrow")>-1)&&n.setAttribute("stretchy","true"),n.setAttribute("symmetric","true"),n.setAttribute("minsize",Pt[e.size]+"em"),n.setAttribute("maxsize",Pt[e.size]+"em"),n}}),g({type:"leftright-right",names:["\\right"],props:{numArgs:1,argTypes:["primitive"]},handler:(e,t)=>({type:"leftright-right",mode:e.parser.mode,delim:Rt(t[0],e).text})}),g({type:"leftright",names:["\\left"],props:{numArgs:1,argTypes:["primitive"]},handler:(t,r)=>{const n=Rt(r[0],t),s=t.parser;++s.leftrightDepth;let o=s.parseExpression(!1,"\\right",!0),a=s.fetch();for(;"\\middle"===a.text;){s.consume();const t=s.fetch().text;if(!D.math[t])throw new e(`Invalid delimiter '${t}' after '\\middle'`);Rt({type:"atom",mode:"math",text:t},{funcName:"\\middle"}),o.push({type:"middle",mode:"math",delim:t}),s.consume(),o=o.concat(s.parseExpression(!1,"\\right",!0)),a=s.fetch()}--s.leftrightDepth,s.expect("\\right",!1);const l=Fe(s.parseFunction(),"leftright-right");return{type:"leftright",mode:s.mode,body:o,left:n.text,right:l.delim,isStretchy:!0}},mathmlBuilder:(e,t)=>{_t(e);const r=de(e.body,t),n=Ht(e.left,e.mode,"prefix",!0);r.unshift(n);const s=Ht(e.right,e.mode,"postfix",!0);if(e.body.length>0){const t=e.body[e.body.length-1];"color"!==t.type||t.isTextColor||s.setAttribute("mathcolor",t.color)}return r.push(s),ce(r)}}),g({type:"delimiter",names:Array.from(jt),props:{numArgs:0,allowedInText:!0,allowedInMath:!0,allowedInArgument:!0},handler:({parser:t,funcName:r,token:n})=>{if("text"===t.mode)return{type:"textord",mode:"text",text:r,loc:n.loc};if(!t.settings.wrapDelimiterPairs)return{type:"atom",mode:"math",family:"open",loc:n.loc,text:r};const s=Ft[r],o=t.parseExpression(!1,s,!1);if(t.fetch().text!==s)throw new e("Unmatched delimiter");return t.consume(),{type:"delimiter",mode:t.mode,body:o,left:r,right:s}},mathmlBuilder:(e,t)=>{_t(e);const r=de(e.body,t),n=Ht(e.left,e.mode,"prefix",!1);r.unshift(n);const s=Ht(e.right,e.mode,"postfix",!1);if(e.body.length>0){const t=e.body[e.body.length-1];"color"!==t.type||t.isTextColor||s.setAttribute("mathcolor",t.color)}return r.push(s),ce(r)}}),g({type:"middle",names:["\\middle"],props:{numArgs:1,argTypes:["primitive"]},handler:(t,r)=>{const n=Rt(r[0],t);if(!t.parser.leftrightDepth)throw new e("\\middle without preceding \\left",n);return{type:"middle",mode:t.parser.mode,delim:n.text}},mathmlBuilder:e=>{const t=ae(e.delim,e.mode),r=new C("mo",[t]);return r.setAttribute("stretchy","true"),r.setAttribute("form","infix"),"/"!==t.text&&(r.setAttribute("lspace","0.05em"),r.setAttribute("rspace","0.05em")),r}});const Vt=["\\boxed","\\fcolorbox","\\colorbox"],Wt=(e,t)=>{const r=Vt.includes(e.label)?"mrow":"menclose",n=new C(r,[ge(e.body,t)]);switch(e.label){case"\\overline":n.setAttribute("notation","top"),n.classes.push("tml-overline");break;case"\\underline":n.setAttribute("notation","bottom"),n.classes.push("tml-underline");break;case"\\cancel":n.setAttribute("notation","updiagonalstrike"),n.children.push(new C("mrow",[],["tml-cancel","upstrike"]));break;case"\\bcancel":n.setAttribute("notation","downdiagonalstrike"),n.children.push(new C("mrow",[],["tml-cancel","downstrike"]));break;case"\\sout":n.setAttribute("notation","horizontalstrike"),n.children.push(new C("mrow",[],["tml-cancel","sout"]));break;case"\\xcancel":n.setAttribute("notation","updiagonalstrike downdiagonalstrike"),n.children.push(new C("mrow",[],["tml-cancel","tml-xcancel"]));break;case"\\longdiv":n.setAttribute("notation","longdiv"),n.classes.push("longdiv-top"),n.children.push(new C("mrow",[],["longdiv-arc"]));break;case"\\phase":n.setAttribute("notation","phasorangle"),n.classes.push("phasor-bottom"),n.children.push(new C("mrow",[],["phasor-angle"]));break;case"\\textcircled":n.setAttribute("notation","circle"),n.classes.push("circle-pad"),n.children.push(new C("mrow",[],["textcircle"]));break;case"\\angl":n.setAttribute("notation","actuarial"),n.classes.push("actuarial");break;case"\\boxed":n.style.padding="3pt",n.style.border="1px solid",n.setAttribute("scriptlevel","0"),n.setAttribute("displaystyle","true");break;case"\\fbox":n.setAttribute("notation","box"),n.classes.push("tml-fbox");break;case"\\fcolorbox":case"\\colorbox":n.style.padding="0.3em","\\fcolorbox"===e.label&&(n.style.border="0.0667em solid "+String(e.borderColor))}return e.backgroundColor&&n.setAttribute("mathbackground",e.backgroundColor),n};g({type:"enclose",names:["\\colorbox"],props:{numArgs:2,numOptionalArgs:1,allowedInText:!0,argTypes:["raw","raw","text"]},handler({parser:e,funcName:t},r,n){const s=n[0]&&Fe(n[0],"raw").string;let o="";if(s){const e=Fe(r[0],"raw").string;o=Ct(s,e)}else o=Nt(Fe(r[0],"raw").string,e.gullet.macros);const a=r[1];return{type:"enclose",mode:e.mode,label:t,backgroundColor:o,body:a}},mathmlBuilder:Wt}),g({type:"enclose",names:["\\fcolorbox"],props:{numArgs:3,numOptionalArgs:1,allowedInText:!0,argTypes:["raw","raw","raw","text"]},handler({parser:e,funcName:t},r,n){const s=n[0]&&Fe(n[0],"raw").string;let o,a="";if(s){const e=Fe(r[0],"raw").string,t=Fe(r[0],"raw").string;a=Ct(s,e),o=Ct(s,t)}else a=Nt(Fe(r[0],"raw").string,e.gullet.macros),o=Nt(Fe(r[1],"raw").string,e.gullet.macros);const l=r[2];return{type:"enclose",mode:e.mode,label:t,backgroundColor:o,borderColor:a,body:l}},mathmlBuilder:Wt}),g({type:"enclose",names:["\\fbox"],props:{numArgs:1,argTypes:["hbox"],allowedInText:!0},handler:({parser:e},t)=>({type:"enclose",mode:e.mode,label:"\\fbox",body:t[0]})}),g({type:"enclose",names:["\\angl","\\cancel","\\bcancel","\\xcancel","\\overline","\\boxed","\\longdiv","\\phase"],props:{numArgs:1},handler({parser:e,funcName:t},r){const n=r[0];return{type:"enclose",mode:e.mode,label:t,body:n}},mathmlBuilder:Wt}),g({type:"enclose",names:["\\sout"],props:{numArgs:1,allowedInText:!0},handler({parser:e,funcName:t},r){const n=r[0];return{type:"enclose",mode:e.mode,label:t,body:n}},mathmlBuilder:Wt}),g({type:"enclose",names:["\\underline"],props:{numArgs:1,allowedInText:!0},handler({parser:e,funcName:t},r){const n=r[0];return{type:"enclose",mode:e.mode,label:t,body:n}},mathmlBuilder:Wt}),g({type:"enclose",names:["\\textcircled"],props:{numArgs:1,argTypes:["text"],allowedInArgument:!0,allowedInText:!0},handler({parser:e,funcName:t},r){const n=r[0];return{type:"enclose",mode:e.mode,label:t,body:n}},mathmlBuilder:Wt}),g({type:"environment",names:["\\begin","\\end"],props:{numArgs:1,argTypes:["text"]},handler({parser:t,funcName:r},n){const s=n[0];if("ordgroup"!==s.type)throw new e("Invalid environment name",s);let o="";for(let e=0;e<s.body.length;++e)o+=Fe(s.body[e],"textord").text;if("\\begin"===r){if(!Object.prototype.hasOwnProperty.call(kt,o))throw new e("No such environment: "+o,s);const r=kt[o],{args:n,optArgs:a}=t.parseArguments("\\begin{"+o+"}",r),l={mode:t.mode,envName:o,parser:t},i=r.handler(l,n,a);t.expect("\\end",!1);const c=t.nextToken,m=Fe(t.parseFunction(),"environment");if(m.name!==o)throw new e(`Mismatch: \\begin{${o}} matched by \\end{${m.name}}`,c);return i}return{type:"environment",mode:t.mode,name:o,nameGroup:s}}}),g({type:"envTag",names:["\\env@tag"],props:{numArgs:1,argTypes:["math"]},handler:({parser:e},t)=>({type:"envTag",mode:e.mode,body:t[0]}),mathmlBuilder:(e,t)=>new C("mrow")}),g({type:"noTag",names:["\\env@notag"],props:{numArgs:0},handler:({parser:e})=>({type:"noTag",mode:e.mode}),mathmlBuilder:(e,t)=>new C("mrow")});const Xt=Object.freeze({B:8426,E:8427,F:8427,H:8387,I:8391,L:8390,M:8422,R:8393,e:8394,g:8355,o:8389}),Zt=Object.freeze({C:8426,H:8388,I:8392,R:8394,Z:8398}),Yt=Object.freeze({C:8383,H:8389,N:8391,P:8393,Q:8393,R:8395,Z:8394}),Jt=Object.freeze({"ϵ":119527,"ϑ":119564,"ϰ":119534,"φ":119577,"ϱ":119535,"ϖ":119563}),Kt=Object.freeze({"ϵ":119643,"ϑ":119680,"ϰ":119650,"φ":119693,"ϱ":119651,"ϖ":119679}),Qt=Object.freeze({"ϵ":119701,"ϑ":119738,"ϰ":119708,"φ":119751,"ϱ":119709,"ϖ":119737}),er=Object.freeze({"ϵ":119759,"ϑ":119796,"ϰ":119766,"φ":119809,"ϱ":119767,"ϖ":119795}),tr=Object.freeze({upperCaseLatin:{normal:e=>0,bold:e=>119743,italic:e=>119795,"bold-italic":e=>119847,script:e=>Xt[e]||119899,"script-bold":e=>119951,fraktur:e=>Zt[e]||120003,"fraktur-bold":e=>120107,"double-struck":e=>Yt[e]||120055,"sans-serif":e=>120159,"sans-serif-bold":e=>120211,"sans-serif-italic":e=>120263,"sans-serif-bold-italic":e=>120380,monospace:e=>120367},lowerCaseLatin:{normal:e=>0,bold:e=>119737,italic:e=>"h"===e?8358:119789,"bold-italic":e=>119841,script:e=>Xt[e]||119893,"script-bold":e=>119945,fraktur:e=>119997,"fraktur-bold":e=>120101,"double-struck":e=>120049,"sans-serif":e=>120153,"sans-serif-bold":e=>120205,"sans-serif-italic":e=>120257,"sans-serif-bold-italic":e=>120309,monospace:e=>120361},upperCaseGreek:{normal:e=>0,bold:e=>119575,italic:e=>119633,"bold-italic":e=>119575,script:e=>0,"script-bold":e=>0,fraktur:e=>0,"fraktur-bold":e=>0,"double-struck":e=>0,"sans-serif":e=>119749,"sans-serif-bold":e=>119749,"sans-serif-italic":e=>0,"sans-serif-bold-italic":e=>119807,monospace:e=>0},lowerCaseGreek:{normal:e=>0,bold:e=>119569,italic:e=>119627,"bold-italic":e=>"ϕ"===e?119678:119685,script:e=>0,"script-bold":e=>0,fraktur:e=>0,"fraktur-bold":e=>0,"double-struck":e=>0,"sans-serif":e=>119743,"sans-serif-bold":e=>119743,"sans-serif-italic":e=>0,"sans-serif-bold-italic":e=>119801,monospace:e=>0},varGreek:{normal:e=>0,bold:e=>Jt[e]||-51,italic:e=>0,"bold-italic":e=>Kt[e]||58,script:e=>0,"script-bold":e=>0,fraktur:e=>0,"fraktur-bold":e=>0,"double-struck":e=>0,"sans-serif":e=>Qt[e]||116,"sans-serif-bold":e=>Qt[e]||116,"sans-serif-italic":e=>0,"sans-serif-bold-italic":e=>er[e]||174,monospace:e=>0},numeral:{normal:e=>0,bold:e=>120734,italic:e=>0,"bold-italic":e=>0,script:e=>0,"script-bold":e=>0,fraktur:e=>0,"fraktur-bold":e=>0,"double-struck":e=>120744,"sans-serif":e=>120754,"sans-serif-bold":e=>120764,"sans-serif-italic":e=>0,"sans-serif-bold-italic":e=>0,monospace:e=>120774}}),rr=(e,t)=>{const r=e.codePointAt(0),n=64<r&&r<91?"upperCaseLatin":96<r&&r<123?"lowerCaseLatin":912<r&&r<938?"upperCaseGreek":944<r&&r<970||"ϕ"===e?"lowerCaseGreek":120545<r&&r<120572||Jt[e]?"varGreek":47<r&&r<58?"numeral":"other";return"other"===n?e:String.fromCodePoint(r+tr[n][t](e))},nr=Object.freeze({a:"ᴀ",b:"ʙ",c:"ᴄ",d:"ᴅ",e:"ᴇ",f:"ꜰ",g:"ɢ",h:"ʜ",i:"ɪ",j:"ᴊ",k:"ᴋ",l:"ʟ",m:"ᴍ",n:"ɴ",o:"ᴏ",p:"ᴘ",q:"ǫ",r:"ʀ",s:"s",t:"ᴛ",u:"ᴜ",v:"ᴠ",w:"ᴡ",x:"x",y:"ʏ",z:"ᴢ"}),sr=["mathrm","mathit"],or=(e,t)=>{const r=e.font,n=t.withFont(r),s=ge(e.body,n);if(0===s.children.length)return s;if("boldsymbol"===r&&["mo","mpadded","mrow"].includes(s.type))return s.style.fontWeight="bold",s;if(((e,t)=>{if(!sr.includes(t)||!e.body||"ordgroup"!==e.body.type||1===e.body.body.length)return!1;if("mathord"!==e.body.body[0].type)return!1;for(let t=1;t<e.body.body.length;t++){const r=e.body.body[t].type;if("mathord"!==r&&("textord"!==r||isNaN(e.body.body[t].text)))return!1}return!0})(e,r)){const e=s.children[0].children[0].children?s.children[0].children[0]:s.children[0];delete e.attributes.mathvariant;for(let t=1;t<s.children.length;t++)e.children[0].text+=s.children[t].children[0].children?s.children[t].children[0].children[0].text:s.children[t].children[0].text;if("mathit"===r)return e.children[0].text=e.children[0].text.split("").map(e=>rr(e,"italic")).join(""),e;const t=new C("mpadded",[e]);return t.setAttribute("lspace","0"),t}let o="mo"===s.children[0].type;for(let e=1;e<s.children.length;e++){"mo"===s.children[e].type&&"boldsymbol"===r&&(s.children[e].style.fontWeight="bold"),"mi"!==s.children[e].type&&(o=!1);"normal"!==(s.children[e].attributes&&s.children[e].attributes.mathvariant||"")&&(o=!1)}if(!o)return s;const a=s.children[0];for(let e=1;e<s.children.length;e++)a.children.push(s.children[e].children[0]);if(a.attributes.mathvariant&&"normal"===a.attributes.mathvariant){const e=new C("mtext",new N("​"));return new C("mrow",[e,a])}return a},ar={"\\Bbb":"\\mathbb","\\bold":"\\mathbf","\\frak":"\\mathfrak","\\bm":"\\boldsymbol"};g({type:"font",names:["\\mathrm","\\mathit","\\mathbf","\\mathnormal","\\up@greek","\\boldsymbol","\\mathbb","\\mathcal","\\mathfrak","\\mathscr","\\mathsf","\\mathsfit","\\mathtt","\\Bbb","\\bm","\\bold","\\frak"],props:{numArgs:1,allowedInArgument:!0},handler:({parser:e,funcName:t},r)=>{const n=b(r[0]);let s=t;return s in ar&&(s=ar[s]),{type:"font",mode:e.mode,font:s.slice(1),body:n}},mathmlBuilder:or}),g({type:"font",names:["\\rm","\\sf","\\tt","\\bf","\\it","\\cal"],props:{numArgs:0,allowedInText:!0},handler:({parser:e,funcName:t,breakOnTokenText:r},n)=>{const{mode:s}=e,o=e.parseExpression(!0,r,!0);return{type:"font",mode:s,font:`math${t.slice(1)}`,body:{type:"ordgroup",mode:e.mode,body:o}}},mathmlBuilder:or});const lr=["display","text","script","scriptscript"],ir={auto:-1,display:0,text:0,script:1,scriptscript:2},cr=(e,t)=>{t=((e,t)=>{let r=t;if("display"===e){const e=r.level>=Ye?Ze:Xe;r=r.withLevel(e)}else"text"===e&&r.level===Xe?r=r.withLevel(Ze):"auto"===e?r=r.incrementLevel():"script"===e?r=r.withLevel(Ye):"scriptscript"===e&&(r=r.withLevel(Je));return r})(e.scriptLevel,t);const r=ge(e.numer,t),n=ge(e.denom,t);3===t.level&&(r.style.mathDepth="2",r.setAttribute("scriptlevel","2"),n.style.mathDepth="2",n.setAttribute("scriptlevel","2"));let s=new C("mfrac",[r,n]);if(e.hasBarLine){if(e.barSize){const r=Be(e.barSize,t);s.setAttribute("linethickness",r.number+r.unit)}}else s.setAttribute("linethickness","0px");if(null!=e.leftDelim||null!=e.rightDelim){const t=[];if(null!=e.leftDelim){const r=new C("mo",[new N(e.leftDelim.replace("\\",""))]);r.setAttribute("fence","true"),t.push(r)}if(t.push(s),null!=e.rightDelim){const r=new C("mo",[new N(e.rightDelim.replace("\\",""))]);r.setAttribute("fence","true"),t.push(r)}s=ce(t)}return"auto"!==e.scriptLevel&&(s=new C("mstyle",[s]),s.setAttribute("displaystyle",String("display"===e.scriptLevel)),s.setAttribute("scriptlevel",ir[e.scriptLevel])),s};g({type:"genfrac",names:["\\cfrac","\\dfrac","\\frac","\\tfrac","\\dbinom","\\binom","\\tbinom","\\\\atopfrac","\\\\bracefrac","\\\\brackfrac"],props:{numArgs:2,allowedInArgument:!0},handler:({parser:e,funcName:t},r)=>{const n=r[0],s=r[1];let o=!1,a=null,l=null,i="auto";switch(t){case"\\cfrac":case"\\dfrac":case"\\frac":case"\\tfrac":o=!0;break;case"\\\\atopfrac":o=!1;break;case"\\dbinom":case"\\binom":case"\\tbinom":a="(",l=")";break;case"\\\\bracefrac":a="\\{",l="\\}";break;case"\\\\brackfrac":a="[",l="]";break;default:throw new Error("Unrecognized genfrac command")}return"\\cfrac"===t||t.startsWith("\\d")?i="display":t.startsWith("\\t")&&(i="text"),{type:"genfrac",mode:e.mode,continued:!1,numer:n,denom:s,hasBarLine:o,leftDelim:a,rightDelim:l,scriptLevel:i,barSize:null}},mathmlBuilder:cr}),g({type:"infix",names:["\\over","\\choose","\\atop","\\brace","\\brack"],props:{numArgs:0,infix:!0},handler({parser:e,funcName:t,token:r}){let n;switch(t){case"\\over":n="\\frac";break;case"\\choose":n="\\binom";break;case"\\atop":n="\\\\atopfrac";break;case"\\brace":n="\\\\bracefrac";break;case"\\brack":n="\\\\brackfrac";break;default:throw new Error("Unrecognized infix genfrac command")}return{type:"infix",mode:e.mode,replaceWith:n,token:r}}});const mr=function(e){let t=null;return e.length>0&&(t=e,t="."===t?null:t),t};g({type:"genfrac",names:["\\genfrac"],props:{numArgs:6,allowedInArgument:!0,argTypes:["math","math","size","text","math","math"]},handler({parser:e},t){const r=t[4],n=t[5],s=b(t[0]),o="atom"===s.type&&"open"===s.family?mr(s.text):null,a=b(t[1]),l="atom"===a.type&&"close"===a.family?mr(a.text):null,i=Fe(t[2],"size");let c,m=null;i.isBlank?c=!0:(m=i.value,c=m.number>0);let p="auto",u=t[3];if("ordgroup"===u.type){if(u.body.length>0){const e=Fe(u.body[0],"textord");p=lr[Number(e.text)]}}else u=Fe(u,"textord"),p=lr[Number(u.text)];return{type:"genfrac",mode:e.mode,numer:r,denom:n,continued:!1,hasBarLine:c,barSize:m,leftDelim:o,rightDelim:l,scriptLevel:p}},mathmlBuilder:cr}),g({type:"infix",names:["\\above"],props:{numArgs:1,argTypes:["size"],infix:!0},handler:({parser:e,funcName:t,token:r},n)=>({type:"infix",mode:e.mode,replaceWith:"\\\\abovefrac",barSize:Fe(n[0],"size").value,token:r})}),g({type:"genfrac",names:["\\\\abovefrac"],props:{numArgs:3,argTypes:["math","size","math"]},handler:({parser:e,funcName:t},r)=>{const n=r[0],s=function(e){if(!e)throw new Error("Expected non-null, but got "+String(e));return e}(Fe(r[1],"infix").barSize),o=r[2],a=s.number>0;return{type:"genfrac",mode:e.mode,numer:n,denom:o,continued:!1,hasBarLine:a,barSize:s,leftDelim:null,rightDelim:null,scriptLevel:"auto"}},mathmlBuilder:cr}),g({type:"hbox",names:["\\hbox"],props:{numArgs:1,argTypes:["hbox"],allowedInArgument:!0,allowedInText:!1},handler:({parser:e},t)=>({type:"hbox",mode:e.mode,body:y(t[0])}),mathmlBuilder(e,t){const r=t.withLevel(Ze),n=he(e.body,r);return ie(n)}});g({type:"horizBracket",names:["\\overbrace","\\underbrace","\\overbracket","\\underbracket"],props:{numArgs:1},handler:({parser:e,funcName:t},r)=>({type:"horizBracket",mode:e.mode,label:t,isOver:/^\\over/.test(t),base:r[0]}),mathmlBuilder:(e,t)=>{const r=I(e.label);return r.style["math-depth"]=0,new C(e.isOver?"mover":"munder",[ge(e.base,t),r])}}),g({type:"html",names:["\\class","\\id","\\style","\\data"],props:{numArgs:2,argTypes:["raw","original"],allowedInText:!0},handler:({parser:t,funcName:r,token:n},s)=>{const o=Fe(s[0],"raw").string,a=s[1];if(t.settings.strict)throw new e(`Function "${r}" is disabled in strict mode`,n);let l;const i={};switch(r){case"\\class":i.class=o,l={command:"\\class",class:o};break;case"\\id":i.id=o,l={command:"\\id",id:o};break;case"\\style":i.style=o,l={command:"\\style",style:o};break;case"\\data":{const t=o.split(",");for(let r=0;r<t.length;r++){const n=t[r].split("=");if(2!==n.length)throw new e("Error parsing key-value for \\data");i["data-"+n[0].trim()]=n[1].trim()}l={command:"\\data",attributes:i};break}default:throw new Error("Unrecognized html command")}if(!t.settings.isTrusted(l))throw new e(`Function "${r}" is not trusted`,n);return{type:"html",mode:t.mode,attributes:i,body:y(a)}},mathmlBuilder:(e,t)=>{const r=he(e.body,t),n=[];e.attributes.class&&n.push(...e.attributes.class.trim().split(/\s+/)),r.classes=n;for(const t in e.attributes)"class"!==t&&Object.prototype.hasOwnProperty.call(e.attributes,t)&&r.setAttribute(t,e.attributes[t]);return r}});const pr=function(t){if(/^[-+]? *(\d+(\.\d*)?|\.\d+)$/.test(t))return{number:+t,unit:"bp"};{const r=/([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/.exec(t);if(!r)throw new e("Invalid size: '"+t+"' in \\includegraphics");const n={number:+(r[1]+r[2]),unit:r[3]};if(!Oe(n))throw new e("Invalid unit: '"+n.unit+"' in \\includegraphics.");return n}};g({type:"includegraphics",names:["\\includegraphics"],props:{numArgs:1,numOptionalArgs:1,argTypes:["raw","url"],allowedInText:!1},handler:({parser:t,token:r},n,s)=>{let o={number:0,unit:"em"},a={number:.9,unit:"em"},l={number:0,unit:"em"},i="";if(s[0]){const t=Fe(s[0],"raw").string.split(",");for(let r=0;r<t.length;r++){const n=t[r].split("=");if(2===n.length){const t=n[1].trim();switch(n[0].trim()){case"alt":i=t;break;case"width":o=pr(t);break;case"height":a=pr(t);break;case"totalheight":l=pr(t);break;default:throw new e("Invalid key: '"+n[0]+"' in \\includegraphics.")}}}}const c=Fe(n[0],"url").url;if(""===i&&(i=c,i=i.replace(/^.*[\\/]/,""),i=i.substring(0,i.lastIndexOf("."))),!t.settings.isTrusted({command:"\\includegraphics",url:c}))throw new e('Function "\\includegraphics" is not trusted',r);return{type:"includegraphics",mode:t.mode,alt:i,width:o,height:a,totalheight:l,src:c}},mathmlBuilder:(e,t)=>{const r=Be(e.height,t),n={number:0,unit:"em"};e.totalheight.number>0&&e.totalheight.unit===r.unit&&e.totalheight.number>r.number&&(n.number=e.totalheight.number-r.number,n.unit=r.unit);let s=0;e.width.number>0&&(s=Be(e.width,t));const o={height:r.number+n.number+"em"};s.number>0&&(o.width=s.number+s.unit),n.number>0&&(o.verticalAlign=-n.number+n.unit);const a=new q(e.src,e.alt,o);return a.height=r,a.depth=n,new C("mtext",[a])}}),g({type:"kern",names:["\\kern","\\mkern","\\hskip","\\mskip"],props:{numArgs:1,argTypes:["size"],primitive:!0,allowedInText:!0},handler({parser:t,funcName:r,token:n},s){const o=Fe(s[0],"size");if(t.settings.strict){const s="m"===r[1],a="mu"===o.value.unit;if(s){if(!a)throw new e(`LaTeX's ${r} supports only mu units, not ${o.value.unit} units`,n);if("math"!==t.mode)throw new e(`LaTeX's ${r} works only in math mode`,n)}else if(a)throw new e(`LaTeX's ${r} doesn't support mu units`,n)}return{type:"kern",mode:t.mode,dimension:o.value}},mathmlBuilder(e,t){const r=Be(e.dimension,t),n=r.number>0&&"em"===r.unit?ur(r.number):"";if("text"===e.mode&&n.length>0){const e=new N(n);return new C("mtext",[e])}if(r.number>=0){const e=new C("mspace");return e.setAttribute("width",r.number+r.unit),e}{const e=new C("mrow");return e.style.marginLeft=r.number+r.unit,e}}});const ur=function(e){return e>=.05555&&e<=.05556?" ":e>=.1666&&e<=.1667?" ":e>=.2222&&e<=.2223?" ":e>=.2777&&e<=.2778?"  ":""},dr=/[^A-Za-z_0-9-]/g;g({type:"label",names:["\\label"],props:{numArgs:1,argTypes:["raw"]},handler:({parser:e},t)=>({type:"label",mode:e.mode,string:t[0].string.replace(dr,"")}),mathmlBuilder(e,t){const r=new C("mrow",[],["tml-label"]);return e.string.length>0&&r.setLabel(e.string),r}});const hr=["\\clap","\\llap","\\rlap"];g({type:"lap",names:["\\mathllap","\\mathrlap","\\mathclap","\\clap","\\llap","\\rlap"],props:{numArgs:1,allowedInText:!0},handler:({parser:t,funcName:r,token:n},s)=>{if(hr.includes(r)){if(t.settings.strict&&"text"!==t.mode)throw new e(`{${r}} can be used only in text mode.\n Try \\math${r.slice(1)}`,n);r=r.slice(1)}else r=r.slice(5);const o=s[0];return{type:"lap",mode:t.mode,alignment:r,body:o}},mathmlBuilder:(e,t)=>{let r;if("llap"===e.alignment){const n=de(y(e.body),t),s=new C("mphantom",n);r=new C("mpadded",[s]),r.setAttribute("width","0.1px")}const n=ge(e.body,t);let s;if("llap"===e.alignment?(n.style.position="absolute",n.style.right="0",n.style.bottom="0",s=new C("mpadded",[r,n])):s=new C("mpadded",[n]),"rlap"===e.alignment)e.body.body.length>0&&"genfrac"===e.body.body[0].type&&s.setAttribute("lspace","0.16667em");else{const t="llap"===e.alignment?"-1":"-0.5";s.setAttribute("lspace",t+"width"),"llap"===e.alignment?s.style.position="relative":(s.style.display="flex",s.style.justifyContent="center")}return s.setAttribute("width","0.1px"),s}}),g({type:"ordgroup",names:["\\(","$"],props:{numArgs:0,allowedInText:!0,allowedInMath:!1},handler({funcName:e,parser:t},r){const n=t.mode;t.switchMode("math");const s="\\("===e?"\\)":"$",o=t.parseExpression(!1,s);return t.expect(s),t.switchMode(n),{type:"ordgroup",mode:t.mode,body:o}}}),g({type:"text",names:["\\)","\\]"],props:{numArgs:0,allowedInText:!0,allowedInMath:!1},handler(t,r){throw new e(`Mismatched ${t.funcName}`,r)}});g({type:"mathchoice",names:["\\mathchoice"],props:{numArgs:4,primitive:!0},handler:({parser:e},t)=>({type:"mathchoice",mode:e.mode,display:y(t[0]),text:y(t[1]),script:y(t[2]),scriptscript:y(t[3])}),mathmlBuilder:(e,t)=>{const r=((e,t)=>{switch(t.level){case Xe:return e.display;case Ze:return e.text;case Ye:return e.script;case Je:return e.scriptscript;default:return e.text}})(e,t);return he(r,t)}});const gr=["text","textord","mathord","atom"];function fr(e,t){let r;const n=de(e.body,t);if("minner"===e.mclass)r=new C("mpadded",n);else if("mord"===e.mclass)e.isCharacterBox||"mathord"===n[0].type?(r=n[0],r.type="mi",1===r.children.length&&r.children[0].text&&"∇"===r.children[0].text&&r.setAttribute("mathvariant","normal")):r=new C("mi",n);else{r=new C("mrow",n),e.mustPromote?(r=n[0],r.type="mo",e.isCharacterBox&&e.body[0].text&&/[A-Za-z]/.test(e.body[0].text)&&r.setAttribute("mathvariant","italic")):r=new C("mrow",n);const s=t.level<2;"mrow"===r.type?s&&("mbin"===e.mclass?(r.children.unshift(Ce(.2222)),r.children.push(Ce(.2222))):"mrel"===e.mclass?(r.children.unshift(Ce(.2778)),r.children.push(Ce(.2778))):"mpunct"===e.mclass?r.children.push(Ce(.1667)):"minner"===e.mclass&&(r.children.unshift(Ce(.0556)),r.children.push(Ce(.0556)))):"mbin"===e.mclass?(r.attributes.lspace=s?"0.2222em":"0",r.attributes.rspace=s?"0.2222em":"0"):"mrel"===e.mclass?(r.attributes.lspace=s?"0.2778em":"0",r.attributes.rspace=s?"0.2778em":"0"):"mpunct"===e.mclass?(r.attributes.lspace="0em",r.attributes.rspace=s?"0.1667em":"0"):"mopen"===e.mclass||"mclose"===e.mclass?(r.attributes.lspace="0em",r.attributes.rspace="0em"):"minner"===e.mclass&&s&&(r.attributes.lspace="0.0556em",r.attributes.width="+0.1111em"),"mopen"!==e.mclass&&"mclose"!==e.mclass&&(delete r.attributes.stretchy,delete r.attributes.form)}return r}g({type:"mclass",names:["\\mathord","\\mathbin","\\mathrel","\\mathopen","\\mathclose","\\mathpunct","\\mathinner"],props:{numArgs:1,primitive:!0},handler({parser:e,funcName:t},r){const n=r[0],s=i(n);let o=!0;const a={type:"mathord",text:"",mode:e.mode},l=n.body?n.body:[n];for(const t of l){if(!gr.includes(t.type)){o=!1;break}D[e.mode][t.text]?a.text+=D[e.mode][t.text].replace:t.text?a.text+=t.text:t.body&&t.body.map(e=>{a.text+=e.text})}return o&&"\\mathord"===t&&"mathord"===a.type&&a.text.length>1?a:{type:"mclass",mode:e.mode,mclass:"m"+t.slice(5),body:y(o?a:n),isCharacterBox:s,mustPromote:o}},mathmlBuilder:fr});const br=e=>{const t="ordgroup"===e.type&&e.body.length&&1===e.body.length?e.body[0]:e;if("atom"===t.type){const r=e.body.length>0&&e.body[0].text&&D.math[e.body[0].text]?D.math[e.body[0].text].group:t.family;return"bin"===r||"rel"===r?"m"+r:"mord"}return"mord"};g({type:"mclass",names:["\\@binrel"],props:{numArgs:2},handler:({parser:e},t)=>({type:"mclass",mode:e.mode,mclass:br(t[0]),body:y(t[1]),isCharacterBox:i(t[1])})}),g({type:"mclass",names:["\\stackrel","\\overset","\\underset"],props:{numArgs:2},handler({parser:e,funcName:t},r){const n=r[1],s=r[0];let o;o="\\stackrel"!==t?br(n):"mrel";const a={type:"mrel"===o||"mbin"===o?"op":"ordgroup",mode:n.mode,limits:!0,alwaysHandleSupSub:!0,parentIsSupSub:!1,symbol:!1,suppressBaseShift:"\\stackrel"!==t,body:y(n)};return{type:"supsub",mode:s.mode,stack:!0,base:a,sup:"\\underset"===t?null:s,sub:"\\underset"===t?s:null}},mathmlBuilder:fr});const yr=(e,t,r)=>{if(!e)return r;const n=ge(e,t);return"mrow"===n.type&&0===n.children.length?r:n};g({type:"multiscript",names:["\\sideset","\\pres@cript"],props:{numArgs:3},handler({parser:t,funcName:r,token:n},s){if(0===s[2].body.length)throw new e(r+"cannot parse an empty base.");const o=s[2].body[0];if(t.settings.strict&&"\\sideset"===r&&!o.symbol)throw new e("The base of \\sideset must be a big operator. Try \\prescript.");if(s[0].body.length>0&&"supsub"!==s[0].body[0].type||s[1].body.length>0&&"supsub"!==s[1].body[0].type)throw new e("\\sideset can parse only subscripts and superscripts in its first two arguments",n);const a=s[0].body.length>0?s[0].body[0]:null,l=s[1].body.length>0?s[1].body[0]:null;return a||l?a?{type:"multiscript",mode:t.mode,isSideset:"\\sideset"===r,prescripts:a,postscripts:l,base:o}:{type:"styling",mode:t.mode,scriptLevel:"text",body:[{type:"supsub",mode:t.mode,base:o,sup:l.sup,sub:l.sub}]}:o},mathmlBuilder(e,t){const r=ge(e.base,t),n=new C("mprescripts"),s=new C("none");let o=[];const a=yr(e.prescripts.sub,t,s),l=yr(e.prescripts.sup,t,s);if(e.isSideset&&(a.setAttribute("style","text-align: left;"),l.setAttribute("style","text-align: left;")),e.postscripts){o=[r,yr(e.postscripts.sub,t,s),yr(e.postscripts.sup,t,s),n,a,l]}else o=[r,n,a,l];return new C("mmultiscripts",o)}}),g({type:"not",names:["\\not"],props:{numArgs:1,primitive:!0,allowedInText:!1},handler({parser:e},t){const r=i(t[0]);let n;if(r)n=y(t[0]),"\\"===n[0].text.charAt(0)&&(n[0].text=D.math[n[0].text].replace),n[0].text=n[0].text.slice(0,1)+"̸"+n[0].text.slice(1);else{n=[{type:"textord",mode:"math",text:"̸"},{type:"kern",mode:"math",dimension:{number:-.6,unit:"em"}},t[0]]}return{type:"not",mode:e.mode,body:n,isCharacterBox:r}},mathmlBuilder(e,t){if(e.isCharacterBox){return de(e.body,t,!0)[0]}return he(e.body,t)}});const wr=["textord","mathord","atom"],xr=["\\smallint"],kr=["textord","mathord","ordgroup","close","leftright","font"],vr=e=>{e.attributes.lspace="0.1667em",e.attributes.rspace="0.1667em"},Ar=(e,t)=>{let r;if(e.symbol)r=new C("mo",[ae(e.name,e.mode)]),xr.includes(e.name)?r.setAttribute("largeop","false"):r.setAttribute("movablelimits","false"),e.fromMathOp&&vr(r);else if(e.body)r=new C("mo",de(e.body,t)),e.fromMathOp&&vr(r);else if(r=new C("mi",[new N(e.name.slice(1))]),!e.parentIsSupSub){const t=[r,new C("mo",[ae("⁡","text")])];if(e.needsLeadingSpace){const e=new C("mspace");e.setAttribute("width","0.1667em"),t.unshift(e)}if(!e.isFollowedByDelimiter){const e=new C("mspace");e.setAttribute("width","0.1667em"),t.push(e)}r=new C("mrow",t)}return r},Tr={"∏":"\\prod","∐":"\\coprod","∑":"\\sum","⋀":"\\bigwedge","⋁":"\\bigvee","⋂":"\\bigcap","⋃":"\\bigcup","⨀":"\\bigodot","⨁":"\\bigoplus","⨂":"\\bigotimes","⨄":"\\biguplus","⨅":"\\bigsqcap","⨆":"\\bigsqcup","⨃":"\\bigcupdot","⨇":"\\bigdoublevee","⨈":"\\bigdoublewedge","⨉":"\\bigtimes"};g({type:"op",names:["\\coprod","\\bigvee","\\bigwedge","\\biguplus","\\bigcupplus","\\bigcupdot","\\bigcap","\\bigcup","\\bigdoublevee","\\bigdoublewedge","\\intop","\\prod","\\sum","\\bigotimes","\\bigoplus","\\bigodot","\\bigsqcap","\\bigsqcup","\\bigtimes","\\smallint","∏","∐","∑","⋀","⋁","⋂","⋃","⨀","⨁","⨂","⨃","⨄","⨅","⨆","⨇","⨈","⨉"],props:{numArgs:0},handler:({parser:e,funcName:t},r)=>{let n=t;return 1===n.length&&(n=Tr[n]),{type:"op",mode:e.mode,limits:!0,parentIsSupSub:!1,symbol:!0,stack:!1,name:n}},mathmlBuilder:Ar}),g({type:"op",names:["\\mathop"],props:{numArgs:1,primitive:!0},handler:({parser:e},t)=>{const r=t[0],n=r.body?r.body:[r],s=1===n.length&&wr.includes(n[0].type);return{type:"op",mode:e.mode,limits:!0,parentIsSupSub:!1,symbol:s,fromMathOp:!0,stack:!1,name:s?n[0].text:null,body:s?null:y(r)}},mathmlBuilder:Ar});const Sr={"∫":"\\int","∬":"\\iint","∭":"\\iiint","∮":"\\oint","∯":"\\oiint","∰":"\\oiiint","∱":"\\intclockwise","∲":"\\varointclockwise","⨌":"\\iiiint","⨍":"\\intbar","⨎":"\\intBar","⨏":"\\fint","⨒":"\\rppolint","⨓":"\\scpolint","⨕":"\\pointint","⨖":"\\sqint","⨗":"\\intlarhk","⨘":"\\intx","⨙":"\\intcap","⨚":"\\intcup"};g({type:"op",names:["\\arcsin","\\arccos","\\arctan","\\arctg","\\arcctg","\\arg","\\ch","\\cos","\\cosec","\\cosh","\\cot","\\cotg","\\coth","\\csc","\\ctg","\\cth","\\deg","\\dim","\\exp","\\hom","\\ker","\\lg","\\ln","\\log","\\sec","\\sin","\\sinh","\\sh","\\sgn","\\tan","\\tanh","\\tg","\\th"],props:{numArgs:0},handler({parser:e,funcName:t}){const r=e.prevAtomType,n=e.gullet.future().text;return{type:"op",mode:e.mode,limits:!1,parentIsSupSub:!1,symbol:!1,stack:!1,isFollowedByDelimiter:Gt(n),needsLeadingSpace:r.length>0&&kr.includes(r),name:t}},mathmlBuilder:Ar}),g({type:"op",names:["\\det","\\gcd","\\inf","\\lim","\\max","\\min","\\Pr","\\sup"],props:{numArgs:0},handler({parser:e,funcName:t}){const r=e.prevAtomType,n=e.gullet.future().text;return{type:"op",mode:e.mode,limits:!0,parentIsSupSub:!1,symbol:!1,stack:!1,isFollowedByDelimiter:Gt(n),needsLeadingSpace:r.length>0&&kr.includes(r),name:t}},mathmlBuilder:Ar}),g({type:"op",names:["\\int","\\iint","\\iiint","\\iiiint","\\oint","\\oiint","\\oiiint","\\intclockwise","\\varointclockwise","\\intbar","\\intBar","\\fint","\\rppolint","\\scpolint","\\pointint","\\sqint","\\intlarhk","\\intx","\\intcap","\\intcup","∫","∬","∭","∮","∯","∰","∱","∲","⨌","⨍","⨎","⨏","⨒","⨓","⨕","⨖","⨗","⨘","⨙","⨚"],props:{numArgs:0,allowedInArgument:!0},handler({parser:e,funcName:t}){let r=t;return 1===r.length&&(r=Sr[r]),{type:"op",mode:e.mode,limits:!1,parentIsSupSub:!1,symbol:!0,stack:!1,name:r}},mathmlBuilder:Ar});g({type:"operatorname",names:["\\operatorname@","\\operatornamewithlimits"],props:{numArgs:1,allowedInArgument:!0},handler:({parser:e,funcName:t},r)=>{const n=r[0],s=e.prevAtomType,o=e.gullet.future().text;return{type:"operatorname",mode:e.mode,body:y(n),alwaysHandleSupSub:"\\operatornamewithlimits"===t,limits:!1,parentIsSupSub:!1,isFollowedByDelimiter:Gt(o),needsLeadingSpace:s.length>0&&kr.includes(s)}},mathmlBuilder:(e,t)=>{let r,n=de(e.body,t.withFont("mathrm")),s=!0;for(let e=0;e<n.length;e++){let t=n[e];if(t instanceof C)switch((("mrow"===t.type||"mpadded"===t.type)&&1===t.children.length&&t.children[0]instanceof C||"mrow"===t.type&&2===t.children.length&&t.children[0]instanceof C&&t.children[1]instanceof C&&"mspace"===t.children[1].type&&!t.children[1].attributes.width&&0===t.children[1].children.length)&&(t=t.children[0]),t.type){case"mi":case"mn":case"ms":case"mtext":break;case"mspace":if(t.attributes.width){const r=t.attributes.width.replace("em",""),o=ur(Number(r));""===o?s=!1:n[e]=new C("mtext",[new N(o)])}break;case"mo":{const e=t.children[0];1===t.children.length&&e instanceof N?e.text=e.text.replace(/\u2212/,"-").replace(/\u2217/,"*"):s=!1;break}default:s=!1}else s=!1}if(s){const e=n.map(e=>e.toText()).join("");n=[new N(e)]}else if(1===n.length&&["mover","munder"].includes(n[0].type)&&("mi"===n[0].children[0].type||"mtext"===n[0].children[0].type)){if(n[0].children[0].type="mi",e.parentIsSupSub)return new C("mrow",n);{const e=new C("mo",[ae("⁡","text")]);return B([n[0],e])}}if(s?(r=new C("mi",n),1===n[0].text.length&&r.setAttribute("mathvariant","normal")):r=new C("mrow",n),!e.parentIsSupSub){const t=[r,new C("mo",[ae("⁡","text")])];if(e.needsLeadingSpace){const e=new C("mspace");e.setAttribute("width","0.1667em"),t.unshift(e)}if(!e.isFollowedByDelimiter){const e=new C("mspace");e.setAttribute("width","0.1667em"),t.push(e)}return B(t)}return r}}),Qe("\\operatorname","\\@ifstar\\operatornamewithlimits\\operatorname@"),f({type:"ordgroup",mathmlBuilder:(e,t)=>he(e.body,t,e.semisimple)}),g({type:"phantom",names:["\\phantom"],props:{numArgs:1,allowedInText:!0},handler:({parser:e},t)=>{const r=t[0];return{type:"phantom",mode:e.mode,body:y(r)}},mathmlBuilder:(e,t)=>{const r=de(e.body,t);return new C("mphantom",r)}}),g({type:"hphantom",names:["\\hphantom"],props:{numArgs:1,allowedInText:!0},handler:({parser:e},t)=>{const r=t[0];return{type:"hphantom",mode:e.mode,body:r}},mathmlBuilder:(e,t)=>{const r=de(y(e.body),t),n=new C("mphantom",r),s=new C("mpadded",[n]);return s.setAttribute("height","0px"),s.setAttribute("depth","0px"),s}}),g({type:"vphantom",names:["\\vphantom"],props:{numArgs:1,allowedInText:!0},handler:({parser:e},t)=>{const r=t[0];return{type:"vphantom",mode:e.mode,body:r}},mathmlBuilder:(e,t)=>{const r=de(y(e.body),t),n=new C("mphantom",r),s=new C("mpadded",[n]);return s.setAttribute("width","0.1px"),s}}),g({type:"pmb",names:["\\pmb"],props:{numArgs:1,allowedInText:!0},handler:({parser:e},t)=>({type:"pmb",mode:e.mode,body:y(t[0])}),mathmlBuilder(e,t){const r=de(e.body,t),n=z(r);return n.setAttribute("style","font-weight:bold"),n}});const Or=(e,t)=>{const r=t.withLevel(Ze),n=new C("mpadded",[ge(e.body,r)]),s=Be(e.dy,t);return n.setAttribute("voffset",s.number+s.unit),s.number>0?n.style.padding=s.number+s.unit+" 0 0 0":n.style.padding="0 0 "+Math.abs(s.number)+s.unit+" 0",n};g({type:"raise",names:["\\raise","\\lower"],props:{numArgs:2,argTypes:["size","primitive"],primitive:!0},handler({parser:e,funcName:t},r){const n=Fe(r[0],"size").value;"\\lower"===t&&(n.number*=-1);const s=r[1];return{type:"raise",mode:e.mode,dy:n,body:s}},mathmlBuilder:Or}),g({type:"raise",names:["\\raisebox"],props:{numArgs:2,argTypes:["size","hbox"],allowedInText:!0},handler({parser:e,funcName:t},r){const n=Fe(r[0],"size").value,s=r[1];return{type:"raise",mode:e.mode,dy:n,body:s}},mathmlBuilder:Or}),g({type:"ref",names:["\\ref","\\eqref"],props:{numArgs:1,argTypes:["raw"]},handler:({parser:e,funcName:t},r)=>({type:"ref",mode:e.mode,funcName:t,string:r[0].string.replace(dr,"")}),mathmlBuilder(e,t){const r="\\ref"===e.funcName?["tml-ref"]:["tml-ref","tml-eqref"];return new O("#"+e.string,r,null)}}),g({type:"reflect",names:["\\reflectbox"],props:{numArgs:1,argTypes:["hbox"],allowedInText:!0},handler:({parser:e},t)=>({type:"reflect",mode:e.mode,body:t[0]}),mathmlBuilder(e,t){const r=ge(e.body,t);return r.style.transform="scaleX(-1)",r}}),g({type:"internal",names:["\\relax"],props:{numArgs:0,allowedInText:!0,allowedInArgument:!0},handler:({parser:e})=>({type:"internal",mode:e.mode})}),g({type:"rule",names:["\\rule"],props:{numArgs:2,numOptionalArgs:1,allowedInText:!0,allowedInMath:!0,argTypes:["size","size","size"]},handler({parser:e},t,r){const n=r[0],s=Fe(t[0],"size"),o=Fe(t[1],"size");return{type:"rule",mode:e.mode,shift:n&&Fe(n,"size").value,width:s.value,height:o.value}},mathmlBuilder(e,t){const r=Be(e.width,t),n=Be(e.height,t),s=e.shift?Be(e.shift,t):{number:0,unit:"em"},o=t.color&&t.getColor()||"black",a=new C("mspace");if(r.number>0&&n.number>0&&a.setAttribute("mathbackground",o),a.setAttribute("width",r.number+r.unit),a.setAttribute("height",n.number+n.unit),0===s.number)return a;const l=new C("mpadded",[a]);return s.number>=0?l.setAttribute("height","+"+s.number+s.unit):(l.setAttribute("height",s.number+s.unit),l.setAttribute("depth","+"+-s.number+s.unit)),l.setAttribute("voffset",s.number+s.unit),l}});const qr=/^[0-9]$/,Br={0:"₀",1:"₁",2:"₂",3:"₃",4:"₄",5:"₅",6:"₆",7:"₇",8:"₈",9:"₉"},Cr={0:"⁰",1:"¹",2:"²",3:"³",4:"⁴",5:"⁵",6:"⁶",7:"⁷",8:"⁸",9:"⁹"};g({type:"sfrac",names:["\\sfrac"],props:{numArgs:2,allowedInText:!0,allowedInMath:!0},handler({parser:t},r){let n="";for(const t of r[0].body){if("textord"!==t.type||!qr.test(t.text))throw new e("Numerator must be an integer.",t);n+=t.text}let s="";for(const t of r[1].body){if("textord"!==t.type||!qr.test(t.text))throw new e("Denominator must be an integer.",t);s+=t.text}return{type:"sfrac",mode:t.mode,numerator:n,denominator:s}},mathmlBuilder(e,t){const r=e.numerator.split("").map(e=>Cr[e]).join(""),n=e.denominator.split("").map(e=>Br[e]).join(""),s=new N(r+"⁄"+n,e.mode,t);return new C("mn",[s],["special-fraction"])}});const Nr={"\\tiny":.5,"\\sixptsize":.6,"\\Tiny":.6,"\\scriptsize":.7,"\\footnotesize":.8,"\\small":.9,"\\normalsize":1,"\\large":1.2,"\\Large":1.44,"\\LARGE":1.728,"\\huge":2.074,"\\Huge":2.488};g({type:"sizing",names:["\\tiny","\\sixptsize","\\Tiny","\\scriptsize","\\footnotesize","\\small","\\normalsize","\\large","\\Large","\\LARGE","\\huge","\\Huge"],props:{numArgs:0,allowedInText:!0},handler:({breakOnTokenText:e,funcName:t,parser:r},n)=>{r.settings.strict&&"math"===r.mode&&console.log(`Temml strict-mode warning: Command ${t} is invalid in math mode.`);const s=r.parseExpression(!1,e,!0);return{type:"sizing",mode:r.mode,funcName:t,body:s}},mathmlBuilder:(e,t)=>{const r=t.withFontSize(Nr[e.funcName]),n=de(e.body,r),s=z(n),o=(Nr[e.funcName]/t.fontSize).toFixed(4);return s.setAttribute("mathsize",o+"em"),s}}),g({type:"smash",names:["\\smash"],props:{numArgs:1,numOptionalArgs:1,allowedInText:!0},handler:({parser:e},t,r)=>{let n=!1,s=!1;const o=r[0]&&Fe(r[0],"ordgroup");if(o){let e="";for(let t=0;t<o.body.length;++t){if(e=o.body[t].text,"t"===e)n=!0;else{if("b"!==e){n=!1,s=!1;break}s=!0}}}else n=!0,s=!0;const a=t[0];return{type:"smash",mode:e.mode,body:a,smashHeight:n,smashDepth:s}},mathmlBuilder:(e,t)=>{const r=new C("mpadded",[ge(e.body,t)]);return e.smashHeight&&r.setAttribute("height","0px"),e.smashDepth&&r.setAttribute("depth","0px"),r}});const zr=["a","c","e","ı","m","n","o","r","s","u","v","w","x","z","α","ε","ι","κ","ν","ο","π","σ","τ","υ","ω","\\alpha","\\epsilon","\\iota","\\kappa","\\nu","\\omega","\\pi","\\tau","\\omega"];g({type:"sqrt",names:["\\sqrt"],props:{numArgs:1,numOptionalArgs:1},handler({parser:e},t,r){const n=r[0],s=t[0];return s.body&&1===s.body.length&&s.body[0].text&&zr.includes(s.body[0].text)&&s.body.push({type:"rule",mode:"math",shift:null,width:{number:0,unit:"pt"},height:{number:.5,unit:"em"}}),{type:"sqrt",mode:e.mode,body:s,index:n}},mathmlBuilder(e,t){const{body:r,index:n}=e;return n?new C("mroot",[ge(r,t),ge(n,t.incrementLevel())]):new C("msqrt",[ge(r,t)])}});const $r={display:0,text:1,script:2,scriptscript:3},Er={display:["0","true"],text:["0","false"],script:["1","false"],scriptscript:["2","false"]};g({type:"styling",names:["\\displaystyle","\\textstyle","\\scriptstyle","\\scriptscriptstyle"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler({breakOnTokenText:e,funcName:t,parser:r},n){const s=r.parseExpression(!0,e,!0),o=t.slice(1,t.length-5);return{type:"styling",mode:r.mode,scriptLevel:o,body:s}},mathmlBuilder(e,t){const r=t.withLevel($r[e.scriptLevel]),n=de(e.body,r),s=z(n),o=Er[e.scriptLevel];return s.setAttribute("scriptlevel",o[0]),s.setAttribute("displaystyle",o[1]),s}});const Ir=/^m(over|under|underover)$/;f({type:"supsub",mathmlBuilder(e,t){let r,n,s=!1,o=!1,a=!1,l=!1;e.base&&"horizBracket"===e.base.type&&(n=!!e.sup,n===e.base.isOver&&(s=!0,r=e.base.isOver)),!e.base||e.stack||"op"!==e.base.type&&"operatorname"!==e.base.type||(e.base.parentIsSupSub=!0,o=!e.base.symbol,a=o&&!e.isFollowedByDelimiter,l=e.base.needsLeadingSpace);const i=e.stack&&1===e.base.body.length?[ge(e.base.body[0],t)]:[ge(e.base,t)],c=t.inSubOrSup();if(e.sub){const r=ge(e.sub,c);3===t.level&&r.setAttribute("scriptlevel","2"),i.push(r)}if(e.sup){const r=ge(e.sup,c);if(3===t.level&&r.setAttribute("scriptlevel","2"),e.base&&e.base.text&&1===e.base.text.length){const t=e.base.text;"DHKLUcegorsuvxyzΠΥΨαδηιμνοτυχϵ".indexOf(t)>-1?r.classes.push("tml-sml-pad"):"BCEFGIMNOPQRSTXZlpqtwΓΘΞΣΦΩβεζθξρςφψϑϕϱ".indexOf(t)>-1?r.classes.push("tml-med-pad"):"AJdfΔΛ".indexOf(t)>-1&&r.classes.push("tml-lrg-pad")}i.push(r)}let m;if(s)m=r?"mover":"munder";else if(e.sub)if(e.sup){const r=e.base;m=r&&("op"===r.type&&r.limits||"multiscript"===r.type)&&(t.level===Xe||r.alwaysHandleSupSub)||r&&"operatorname"===r.type&&r.alwaysHandleSupSub&&(t.level===Xe||r.limits)?"munderover":"msubsup"}else{const r=e.base;m=e.stack||r&&"op"===r.type&&r.limits&&(t.level===Xe||r.alwaysHandleSupSub)||r&&"operatorname"===r.type&&r.alwaysHandleSupSub&&(r.limits||t.level===Xe)?"munder":"msub"}else{const r=e.base;m=r&&"op"===r.type&&r.limits&&(t.level===Xe||r.alwaysHandleSupSub)||r&&"operatorname"===r.type&&r.alwaysHandleSupSub&&(r.limits||t.level===Xe)?"mover":"msup"}let p=new C(m,i);if(o){const e=new C("mo",[ae("⁡","text")]);if(l){const t=new C("mspace");t.setAttribute("width","0.1667em"),p=B([t,p,e])}else p=B([p,e]);if(a){const e=new C("mspace");e.setAttribute("width","0.1667em"),p.children.push(e)}}else Ir.test(m)&&(p=new C("mrow",[p]));return p}});const Lr=["\\shortmid","\\nshortmid","\\shortparallel","\\nshortparallel","\\smallsetminus"],Fr=["\\Rsh","\\Lsh","\\restriction"];f({type:"atom",mathmlBuilder(e,t){if("inner"===e.family){const t="text"===e.mode?"mtext":"mi";return new C(t,[ae(e.text,e.mode)])}const r=new C("mo",[ae(e.text,e.mode)]);if("punct"===e.family)r.setAttribute("separator","true");else if("open"===e.family||"close"===e.family)"open"===e.family?(r.setAttribute("form","prefix"),r.setAttribute("stretchy","false")):"close"===e.family&&(r.setAttribute("form","postfix"),r.setAttribute("stretchy","false"));else if("\\mid"===e.text)r.setAttribute("lspace","0.22em"),r.setAttribute("rspace","0.22em"),r.setAttribute("stretchy","false");else if("rel"===e.family&&(e=>{if(1===e.length){const t=e.codePointAt(0);return 8591<t&&t<8704}return e.indexOf("arrow")>-1||e.indexOf("harpoon")>-1||Fr.includes(e)})(e.text))r.setAttribute("stretchy","false");else if(Lr.includes(e.text))r.setAttribute("mathsize","70%");else if(":"===e.text)r.attributes.lspace="0.2222em",r.attributes.rspace="0.2222em";else if(e.needsSpacing)return"bin"===e.family?new C("mrow",[Ce(.222),r,Ce(.222)]):new C("mrow",[Ce(.2778),r,Ce(.2778)]);return r}});const jr={mathbf:"bold",mathrm:"normal",textit:"italic",mathit:"italic",mathnormal:"italic",mathbb:"double-struck",mathcal:"script",mathfrak:"fraktur",mathscr:"script",mathsf:"sans-serif",mathtt:"monospace"},Mr=function(e,t){if("texttt"===t.fontFamily)return"monospace";if("textsc"===t.fontFamily)return"normal";if("textsf"===t.fontFamily)return"textit"===t.fontShape&&"textbf"===t.fontWeight?"sans-serif-bold-italic":"textit"===t.fontShape?"sans-serif-italic":"textbf"===t.fontWeight?"sans-serif-bold":"sans-serif";if("textit"===t.fontShape&&"textbf"===t.fontWeight)return"bold-italic";if("textit"===t.fontShape)return"italic";if("textbf"===t.fontWeight)return"bold";const r=t.font;if(!r||"mathnormal"===r)return null;const n=e.mode;switch(r){case"mathit":case"greekItalic":return"italic";case"mathrm":{const t=e.text.codePointAt(0);return 939<t&&t<975?"italic":"normal"}case"up@greek":return"normal";case"boldsymbol":case"mathboldsymbol":return"bold-italic";case"mathbf":return"bold";case"mathbb":return"double-struck";case"mathfrak":return"fraktur";case"mathscr":case"mathcal":return"script";case"mathsf":return"sans-serif";case"mathsfit":return"sans-serif-italic";case"mathtt":return"monospace"}let s=e.text;return D[n][s]&&D[n][s].replace&&(s=D[n][s].replace),Object.prototype.hasOwnProperty.call(jr,r)?jr[r]:null},Dr=/^\d(?:[\d,.]*\d)?$/,Gr=/[A-Ba-z]/,Pr=new Set(["\\prime","\\dprime","\\trprime","\\qprime","\\backprime","\\backdprime","\\backtrprime"]);f({type:"mathord",mathmlBuilder(e,t){const r=ae(e.text,e.mode,t),n=r.text.codePointAt(0),s=912<n&&n<938?"normal":"italic",o=Mr(e,t)||s;if("script"===o)return r.text=rr(r.text,o),new C("mi",[r],[t.font]);"italic"!==o&&(r.text=rr(r.text,o));let a=new C("mi",[r]);if("normal"===o&&(a.setAttribute("mathvariant","normal"),1===r.text.length)){const e=new C("mspace",[]);a=new C("mrow",[a,e])}return a}}),f({type:"textord",mathmlBuilder(e,t){let r=e.text;const n=r.codePointAt(0);"textsc"===t.fontFamily&&96<n&&n<123&&(r=nr[r]);const s=ae(r,e.mode,t),o=Mr(e,t)||"normal";let a;if(Dr.test(e.text)){const t="text"===e.mode?"mtext":"mn";if("italic"===o||"bold-italic"===o)return((e,t,r)=>{const n=new C(r,[e]),s=new C("mstyle",[n]);return s.style["font-style"]="italic",s.style["font-family"]="Cambria, 'Times New Roman', serif","bold-italic"===t&&(s.style["font-weight"]="bold"),s})(s,o,t);"normal"!==o&&(s.text=s.text.split("").map(e=>rr(e,o)).join("")),a=new C(t,[s])}else if("text"===e.mode)"normal"!==o&&(s.text=rr(s.text,o)),a=new C("mtext",[s]);else if(Pr.has(e.text))a=new C("mo",[s]),a.classes.push("tml-prime");else{const e=s.text;"italic"!==o&&(s.text=rr(s.text,o)),a=new C("mi",[s]),s.text===e&&Gr.test(e)&&a.setAttribute("mathvariant","italic")}return a}});const Rr={"\\nobreak":"nobreak","\\allowbreak":"allowbreak"},Ur={" ":{},"\\ ":{},"~":{className:"nobreak"},"\\space":{},"\\nobreakspace":{className:"nobreak"}};f({type:"spacing",mathmlBuilder(t,r){let n;if(Object.prototype.hasOwnProperty.call(Ur,t.text))n=new C("mtext",[new N(" ")]);else{if(!Object.prototype.hasOwnProperty.call(Rr,t.text))throw new e(`Unknown type of space "${t.text}"`);n=new C("mo"),"\\nobreak"===t.text&&n.setAttribute("linebreak","nobreak")}return n}}),f({type:"tag"});const Hr={"\\text":void 0,"\\textrm":"textrm","\\textsf":"textsf","\\texttt":"texttt","\\textnormal":"textrm","\\textsc":"textsc"},_r={"\\textbf":"textbf","\\textmd":"textmd"},Vr={"\\textit":"textit","\\textup":"textup"};g({type:"text",names:["\\text","\\textrm","\\textsf","\\texttt","\\textnormal","\\textsc","\\textbf","\\textmd","\\textit","\\textup","\\emph"],props:{numArgs:1,argTypes:["text"],allowedInArgument:!0,allowedInText:!0},handler({parser:e,funcName:t},r){const n=r[0];return{type:"text",mode:e.mode,body:y(n),font:t}},mathmlBuilder(e,t){const r=((e,t)=>{const r=e.font;return r?Hr[r]?t.withTextFontFamily(Hr[r]):_r[r]?t.withTextFontWeight(_r[r]):"\\emph"===r?"textit"===t.fontShape?t.withTextFontShape("textup"):t.withTextFontShape("textit"):t.withTextFontShape(Vr[r]):t})(e,t),n=he(e.body,r);return ie(n)}}),g({type:"vcenter",names:["\\vcenter"],props:{numArgs:1,argTypes:["original"],allowedInText:!1},handler:({parser:e},t)=>({type:"vcenter",mode:e.mode,body:t[0]}),mathmlBuilder(e,t){const r=new C("mtd",[ge(e.body,t)]);r.style.padding="0";const n=new C("mtr",[r]);return new C("mtable",[n])}}),g({type:"verb",names:["\\verb"],props:{numArgs:0,allowedInText:!0},handler(t,r,n){throw new e("\\verb ended by end of line instead of matching delimiter")},mathmlBuilder(e,t){const r=new N(Wr(e)),n=new C("mtext",[r]);return n.setAttribute("mathvariant","monospace"),n}});const Wr=e=>e.body.replace(/ /g,e.star?"␣":" "),Xr=d,Zr="[ \r\n\t]",Yr=`(\\\\[a-zA-Z@]+)${Zr}*`,Jr="[̀-ͯ]",Kr=new RegExp(`${Jr}+$`),Qr=`(${Zr}+)|\\\\(\n|[ \r\t]+\n?)[ \r\t]*|([!-\\[\\]-‧‪-퟿豈-￿]${Jr}*|[\ud800-\udbff][\udc00-\udfff]${Jr}*|\\\\verb\\*([^]).*?\\4|\\\\verb([^*a-zA-Z]).*?\\5|${Yr}|\\\\[^\ud800-\udfff])`;class en{constructor(e,t){this.input=e,this.settings=t,this.tokenRegex=new RegExp(Qr,"g"),this.catcodes={"%":14,"~":13}}setCatcode(e,t){this.catcodes[e]=t}lex(){const t=this.input,r=this.tokenRegex.lastIndex;if(r===t.length)return new We("EOF",new Ve(this,r,r));const n=this.tokenRegex.exec(t);if(null===n||n.index!==r)throw new e(`Unexpected character: '${t[r]}'`,new We(t[r],new Ve(this,r,r+1)));const s=n[6]||n[3]||(n[2]?"\\ ":" ");if(14===this.catcodes[s]){const r=t.indexOf("\n",this.tokenRegex.lastIndex);if(-1===r){if(this.tokenRegex.lastIndex=t.length,this.settings.strict)throw new e("% comment has no terminating newline; LaTeX would fail because of commenting the end of math mode")}else this.tokenRegex.lastIndex=r+1;return this.lex()}return new We(s,new Ve(this,r,this.tokenRegex.lastIndex))}}class tn{constructor(e=Object.create(null),t=Object.create(null)){this.current=t,this.builtins=e,this.undefStack=[]}beginGroup(){this.undefStack.push(Object.create(null))}endGroup(){if(0===this.undefStack.length)throw new e("Unbalanced namespace destruction: attempt to pop global namespace; please report this as a bug");const t=this.undefStack.pop();for(const e in t)Object.prototype.hasOwnProperty.call(t,e)&&(void 0===t[e]?delete this.current[e]:this.current[e]=t[e])}has(e){return Object.prototype.hasOwnProperty.call(this.current,e)||Object.prototype.hasOwnProperty.call(this.builtins,e)}get(e){return Object.prototype.hasOwnProperty.call(this.current,e)?this.current[e]:this.builtins[e]}set(e,t,r=!1){if(r){for(let t=0;t<this.undefStack.length;t++)delete this.undefStack[t][e];this.undefStack.length>0&&(this.undefStack[this.undefStack.length-1][e]=t)}else{const t=this.undefStack[this.undefStack.length-1];t&&!Object.prototype.hasOwnProperty.call(t,e)&&(t[e]=this.current[e])}this.current[e]=t}}const rn={"^":!0,_:!0,"\\limits":!0,"\\nolimits":!0};class nn{constructor(e,t,r){this.settings=t,this.expansionCount=0,this.feed(e),this.macros=new tn(et,t.macros),this.mode=r,this.stack=[]}feed(e){this.lexer=new en(e,this.settings)}switchMode(e){this.mode=e}beginGroup(){this.macros.beginGroup()}endGroup(){this.macros.endGroup()}future(){return 0===this.stack.length&&this.pushToken(this.lexer.lex()),this.stack[this.stack.length-1]}popToken(){return this.future(),this.stack.pop()}pushToken(e){this.stack.push(e)}pushTokens(e){this.stack.push(...e)}scanArgument(e){let t,r,n;if(e){if(this.consumeSpaces(),"["!==this.future().text)return null;t=this.popToken(),({tokens:n,end:r}=this.consumeArg(["]"]))}else({tokens:n,start:t,end:r}=this.consumeArg());return this.pushToken(new We("EOF",r.loc)),this.pushTokens(n),new We("",Ve.range(t,r))}consumeSpaces(){for(;;){if(" "!==this.future().text)break;this.stack.pop()}}consumeArg(t){const r=[],n=t&&t.length>0;n||this.consumeSpaces();const s=this.future();let o,a=0,l=0;do{if(o=this.popToken(),r.push(o),"{"===o.text)++a;else if("}"===o.text){if(--a,-1===a)throw new e("Extra }",o)}else if("EOF"===o.text)throw new e("Unexpected end of input in a macro argument, expected '"+(t&&n?t[l]:"}")+"'",o);if(t&&n)if((0===a||1===a&&"{"===t[l])&&o.text===t[l]){if(++l,l===t.length){r.splice(-l,l);break}}else l=0}while(0!==a||n);return"{"===s.text&&"}"===r[r.length-1].text&&(r.pop(),r.shift()),r.reverse(),{tokens:r,start:s,end:o}}consumeArgs(t,r){if(r){if(r.length!==t+1)throw new e("The length of delimiters doesn't match the number of args!");const n=r[0];for(let t=0;t<n.length;t++){const r=this.popToken();if(n[t]!==r.text)throw new e("Use of the macro doesn't match its definition",r)}}const n=[];for(let e=0;e<t;e++)n.push(this.consumeArg(r&&r[e+1]).tokens);return n}expandOnce(t){const r=this.popToken(),n=r.text,s=r.noexpand?null:this._getExpansion(n);if(null==s||t&&s.unexpandable){if(t&&null==s&&"\\"===n[0]&&!this.isDefined(n))throw new e("Undefined control sequence: "+n);return this.pushToken(r),!1}if(this.expansionCount++,this.expansionCount>this.settings.maxExpand)throw new e("Too many expansions: infinite loop or need to increase maxExpand setting");let o=s.tokens;const a=this.consumeArgs(s.numArgs,s.delimiters);if(s.numArgs){o=o.slice();for(let t=o.length-1;t>=0;--t){let r=o[t];if("#"===r.text){if(0===t)throw new e("Incomplete placeholder at end of macro body",r);if(r=o[--t],"#"===r.text)o.splice(t+1,1);else{if(!/^[1-9]$/.test(r.text))throw new e("Not a valid argument number",r);o.splice(t,2,...a[+r.text-1])}}}}return this.pushTokens(o),o.length}expandAfterFuture(){return this.expandOnce(),this.future()}expandNextToken(){for(;;)if(!1===this.expandOnce()){const e=this.stack.pop();return e.treatAsRelax&&(e.text="\\relax"),e}throw new Error}expandMacro(e){return this.macros.has(e)?this.expandTokens([new We(e)]):void 0}expandTokens(e){const t=[],r=this.stack.length;for(this.pushTokens(e);this.stack.length>r;)if(!1===this.expandOnce(!0)){const e=this.stack.pop();e.treatAsRelax&&(e.noexpand=!1,e.treatAsRelax=!1),t.push(e)}return t}expandMacroAsText(e){const t=this.expandMacro(e);return t?t.map(e=>e.text).join(""):t}_getExpansion(e){const t=this.macros.get(e);if(null==t)return t;if(1===e.length){const t=this.lexer.catcodes[e];if(null!=t&&13!==t)return}const r="function"==typeof t?t(this):t;if("string"==typeof r){let e=0;if(-1!==r.indexOf("#")){const t=r.replace(/##/g,"");for(;-1!==t.indexOf("#"+(e+1));)++e}const t=new en(r,this.settings),n=[];let s=t.lex();for(;"EOF"!==s.text;)n.push(s),s=t.lex();n.reverse();return{tokens:n,numArgs:e}}return r}isDefined(e){return this.macros.has(e)||Object.prototype.hasOwnProperty.call(Xr,e)||Object.prototype.hasOwnProperty.call(D.math,e)||Object.prototype.hasOwnProperty.call(D.text,e)||Object.prototype.hasOwnProperty.call(rn,e)}isExpandable(e){const t=this.macros.get(e);return null!=t?"string"==typeof t||"function"==typeof t||!t.unexpandable:Object.prototype.hasOwnProperty.call(Xr,e)&&!Xr[e].primitive}}const sn=/^[₊₋₌₍₎₀₁₂₃₄₅₆₇₈₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ]/,on=Object.freeze({"₊":"+","₋":"-","₌":"=","₍":"(","₎":")","₀":"0","₁":"1","₂":"2","₃":"3","₄":"4","₅":"5","₆":"6","₇":"7","₈":"8","₉":"9","ₐ":"a","ₑ":"e","ₕ":"h","ᵢ":"i","ⱼ":"j","ₖ":"k","ₗ":"l","ₘ":"m","ₙ":"n","ₒ":"o","ₚ":"p","ᵣ":"r","ₛ":"s","ₜ":"t","ᵤ":"u","ᵥ":"v","ₓ":"x","ᵦ":"β","ᵧ":"γ","ᵨ":"ρ","ᵩ":"ϕ","ᵪ":"χ","⁺":"+","⁻":"-","⁼":"=","⁽":"(","⁾":")","⁰":"0","¹":"1","²":"2","³":"3","⁴":"4","⁵":"5","⁶":"6","⁷":"7","⁸":"8","⁹":"9","ᴬ":"A","ᴮ":"B","ᴰ":"D","ᴱ":"E","ᴳ":"G","ᴴ":"H","ᴵ":"I","ᴶ":"J","ᴷ":"K","ᴸ":"L","ᴹ":"M","ᴺ":"N","ᴼ":"O","ᴾ":"P","ᴿ":"R","ᵀ":"T","ᵁ":"U","ⱽ":"V","ᵂ":"W","ᵃ":"a","ᵇ":"b","ᶜ":"c","ᵈ":"d","ᵉ":"e","ᶠ":"f","ᵍ":"g","ʰ":"h","ⁱ":"i","ʲ":"j","ᵏ":"k","ˡ":"l","ᵐ":"m","ⁿ":"n","ᵒ":"o","ᵖ":"p","ʳ":"r","ˢ":"s","ᵗ":"t","ᵘ":"u","ᵛ":"v","ʷ":"w","ˣ":"x","ʸ":"y","ᶻ":"z","ᵝ":"β","ᵞ":"γ","ᵟ":"δ","ᵠ":"ϕ","ᵡ":"χ","ᶿ":"θ"}),an=Object.freeze({"𝒜":"A","ℬ":"B","𝒞":"C","𝒟":"D","ℰ":"E","ℱ":"F","𝒢":"G","ℋ":"H","ℐ":"I","𝒥":"J","𝒦":"K","ℒ":"L","ℳ":"M","𝒩":"N","𝒪":"O","𝒫":"P","𝒬":"Q","ℛ":"R","𝒮":"S","𝒯":"T","𝒰":"U","𝒱":"V","𝒲":"W","𝒳":"X","𝒴":"Y","𝒵":"Z"});var ln={"́":{text:"\\'",math:"\\acute"},"̀":{text:"\\`",math:"\\grave"},"̈":{text:'\\"',math:"\\ddot"},"̃":{text:"\\~",math:"\\tilde"},"̄":{text:"\\=",math:"\\bar"},"̆":{text:"\\u",math:"\\breve"},"̌":{text:"\\v",math:"\\check"},"̂":{text:"\\^",math:"\\hat"},"̇":{text:"\\.",math:"\\dot"},"̊":{text:"\\r",math:"\\mathring"},"̋":{text:"\\H"},"̧":{text:"\\c"}},cn={"á":"á","à":"à","ä":"ä","ǟ":"ǟ","ã":"ã","ā":"ā","ă":"ă","ắ":"ắ","ằ":"ằ","ẵ":"ẵ","ǎ":"ǎ","â":"â","ấ":"ấ","ầ":"ầ","ẫ":"ẫ","ȧ":"ȧ","ǡ":"ǡ","å":"å","ǻ":"ǻ","ḃ":"ḃ","ć":"ć","č":"č","ĉ":"ĉ","ċ":"ċ","ď":"ď","ḋ":"ḋ","é":"é","è":"è","ë":"ë","ẽ":"ẽ","ē":"ē","ḗ":"ḗ","ḕ":"ḕ","ĕ":"ĕ","ě":"ě","ê":"ê","ế":"ế","ề":"ề","ễ":"ễ","ė":"ė","ḟ":"ḟ","ǵ":"ǵ","ḡ":"ḡ","ğ":"ğ","ǧ":"ǧ","ĝ":"ĝ","ġ":"ġ","ḧ":"ḧ","ȟ":"ȟ","ĥ":"ĥ","ḣ":"ḣ","í":"í","ì":"ì","ï":"ï","ḯ":"ḯ","ĩ":"ĩ","ī":"ī","ĭ":"ĭ","ǐ":"ǐ","î":"î","ǰ":"ǰ","ĵ":"ĵ","ḱ":"ḱ","ǩ":"ǩ","ĺ":"ĺ","ľ":"ľ","ḿ":"ḿ","ṁ":"ṁ","ń":"ń","ǹ":"ǹ","ñ":"ñ","ň":"ň","ṅ":"ṅ","ó":"ó","ò":"ò","ö":"ö","ȫ":"ȫ","õ":"õ","ṍ":"ṍ","ṏ":"ṏ","ȭ":"ȭ","ō":"ō","ṓ":"ṓ","ṑ":"ṑ","ŏ":"ŏ","ǒ":"ǒ","ô":"ô","ố":"ố","ồ":"ồ","ỗ":"ỗ","ȯ":"ȯ","ȱ":"ȱ","ő":"ő","ṕ":"ṕ","ṗ":"ṗ","ŕ":"ŕ","ř":"ř","ṙ":"ṙ","ś":"ś","ṥ":"ṥ","š":"š","ṧ":"ṧ","ŝ":"ŝ","ṡ":"ṡ","ẗ":"ẗ","ť":"ť","ṫ":"ṫ","ú":"ú","ù":"ù","ü":"ü","ǘ":"ǘ","ǜ":"ǜ","ǖ":"ǖ","ǚ":"ǚ","ũ":"ũ","ṹ":"ṹ","ū":"ū","ṻ":"ṻ","ŭ":"ŭ","ǔ":"ǔ","û":"û","ů":"ů","ű":"ű","ṽ":"ṽ","ẃ":"ẃ","ẁ":"ẁ","ẅ":"ẅ","ŵ":"ŵ","ẇ":"ẇ","ẘ":"ẘ","ẍ":"ẍ","ẋ":"ẋ","ý":"ý","ỳ":"ỳ","ÿ":"ÿ","ỹ":"ỹ","ȳ":"ȳ","ŷ":"ŷ","ẏ":"ẏ","ẙ":"ẙ","ź":"ź","ž":"ž","ẑ":"ẑ","ż":"ż","Á":"Á","À":"À","Ä":"Ä","Ǟ":"Ǟ","Ã":"Ã","Ā":"Ā","Ă":"Ă","Ắ":"Ắ","Ằ":"Ằ","Ẵ":"Ẵ","Ǎ":"Ǎ","Â":"Â","Ấ":"Ấ","Ầ":"Ầ","Ẫ":"Ẫ","Ȧ":"Ȧ","Ǡ":"Ǡ","Å":"Å","Ǻ":"Ǻ","Ḃ":"Ḃ","Ć":"Ć","Č":"Č","Ĉ":"Ĉ","Ċ":"Ċ","Ď":"Ď","Ḋ":"Ḋ","É":"É","È":"È","Ë":"Ë","Ẽ":"Ẽ","Ē":"Ē","Ḗ":"Ḗ","Ḕ":"Ḕ","Ĕ":"Ĕ","Ě":"Ě","Ê":"Ê","Ế":"Ế","Ề":"Ề","Ễ":"Ễ","Ė":"Ė","Ḟ":"Ḟ","Ǵ":"Ǵ","Ḡ":"Ḡ","Ğ":"Ğ","Ǧ":"Ǧ","Ĝ":"Ĝ","Ġ":"Ġ","Ḧ":"Ḧ","Ȟ":"Ȟ","Ĥ":"Ĥ","Ḣ":"Ḣ","Í":"Í","Ì":"Ì","Ï":"Ï","Ḯ":"Ḯ","Ĩ":"Ĩ","Ī":"Ī","Ĭ":"Ĭ","Ǐ":"Ǐ","Î":"Î","İ":"İ","Ĵ":"Ĵ","Ḱ":"Ḱ","Ǩ":"Ǩ","Ĺ":"Ĺ","Ľ":"Ľ","Ḿ":"Ḿ","Ṁ":"Ṁ","Ń":"Ń","Ǹ":"Ǹ","Ñ":"Ñ","Ň":"Ň","Ṅ":"Ṅ","Ó":"Ó","Ò":"Ò","Ö":"Ö","Ȫ":"Ȫ","Õ":"Õ","Ṍ":"Ṍ","Ṏ":"Ṏ","Ȭ":"Ȭ","Ō":"Ō","Ṓ":"Ṓ","Ṑ":"Ṑ","Ŏ":"Ŏ","Ǒ":"Ǒ","Ô":"Ô","Ố":"Ố","Ồ":"Ồ","Ỗ":"Ỗ","Ȯ":"Ȯ","Ȱ":"Ȱ","Ő":"Ő","Ṕ":"Ṕ","Ṗ":"Ṗ","Ŕ":"Ŕ","Ř":"Ř","Ṙ":"Ṙ","Ś":"Ś","Ṥ":"Ṥ","Š":"Š","Ṧ":"Ṧ","Ŝ":"Ŝ","Ṡ":"Ṡ","Ť":"Ť","Ṫ":"Ṫ","Ú":"Ú","Ù":"Ù","Ü":"Ü","Ǘ":"Ǘ","Ǜ":"Ǜ","Ǖ":"Ǖ","Ǚ":"Ǚ","Ũ":"Ũ","Ṹ":"Ṹ","Ū":"Ū","Ṻ":"Ṻ","Ŭ":"Ŭ","Ǔ":"Ǔ","Û":"Û","Ů":"Ů","Ű":"Ű","Ṽ":"Ṽ","Ẃ":"Ẃ","Ẁ":"Ẁ","Ẅ":"Ẅ","Ŵ":"Ŵ","Ẇ":"Ẇ","Ẍ":"Ẍ","Ẋ":"Ẋ","Ý":"Ý","Ỳ":"Ỳ","Ÿ":"Ÿ","Ỹ":"Ỹ","Ȳ":"Ȳ","Ŷ":"Ŷ","Ẏ":"Ẏ","Ź":"Ź","Ž":"Ž","Ẑ":"Ẑ","Ż":"Ż","ά":"ά","ὰ":"ὰ","ᾱ":"ᾱ","ᾰ":"ᾰ","έ":"έ","ὲ":"ὲ","ή":"ή","ὴ":"ὴ","ί":"ί","ὶ":"ὶ","ϊ":"ϊ","ΐ":"ΐ","ῒ":"ῒ","ῑ":"ῑ","ῐ":"ῐ","ό":"ό","ὸ":"ὸ","ύ":"ύ","ὺ":"ὺ","ϋ":"ϋ","ΰ":"ΰ","ῢ":"ῢ","ῡ":"ῡ","ῠ":"ῠ","ώ":"ώ","ὼ":"ὼ","Ύ":"Ύ","Ὺ":"Ὺ","Ϋ":"Ϋ","Ῡ":"Ῡ","Ῠ":"Ῠ","Ώ":"Ώ","Ὼ":"Ὼ"};const mn=["bin","op","open","punct","rel"],pn=/([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/,un=/^ *\\text/;class dn{constructor(e,t,r=!1){this.mode="math",this.gullet=new nn(e,t,this.mode),this.settings=t,this.isPreamble=r,this.leftrightDepth=0,this.prevAtomType=""}expect(t,r=!0){if(this.fetch().text!==t)throw new e(`Expected '${t}', got '${this.fetch().text}'`,this.fetch());r&&this.consume()}consume(){this.nextToken=null}fetch(){return null==this.nextToken&&(this.nextToken=this.gullet.expandNextToken()),this.nextToken}switchMode(e){this.mode=e,this.gullet.switchMode(e)}parse(){this.gullet.beginGroup(),this.settings.colorIsTextColor&&this.gullet.macros.set("\\color","\\textcolor");const e=this.parseExpression(!1);if(this.expect("EOF"),this.isPreamble){const e=Object.create(null);return Object.entries(this.gullet.macros.current).forEach(([t,r])=>{e[t]=r}),this.gullet.endGroup(),e}const t=this.gullet.macros.get("\\df@tag");return this.gullet.endGroup(),t&&(this.gullet.macros.current["\\df@tag"]=t),e}static get endOfExpression(){return["}","\\endgroup","\\end","\\right","\\endtoggle","&"]}subparse(e){const t=this.nextToken;this.consume(),this.gullet.pushToken(new We("}")),this.gullet.pushTokens(e);const r=this.parseExpression(!1);return this.expect("}"),this.nextToken=t,r}parseExpression(e,t,r){const n=[];for(this.prevAtomType="";;){"math"===this.mode&&this.consumeSpaces();const s=this.fetch();if(-1!==dn.endOfExpression.indexOf(s.text))break;if(t&&s.text===t)break;if(r&&"\\middle"===s.text)break;if(e&&Xr[s.text]&&Xr[s.text].infix)break;const o=this.parseAtom(t);if(!o)break;"internal"!==o.type&&(n.push(o),this.prevAtomType="atom"===o.type?o.family:o.type)}return"text"===this.mode&&this.formLigatures(n),this.handleInfixNodes(n)}handleInfixNodes(t){let r,n=-1;for(let s=0;s<t.length;s++)if("infix"===t[s].type){if(-1!==n)throw new e("only one infix operator per group",t[s].token);n=s,r=t[s].replaceWith}if(-1!==n&&r){let e,s;const o=t.slice(0,n),a=t.slice(n+1);let l;return e=1===o.length&&"ordgroup"===o[0].type?o[0]:{type:"ordgroup",mode:this.mode,body:o},s=1===a.length&&"ordgroup"===a[0].type?a[0]:{type:"ordgroup",mode:this.mode,body:a},l="\\\\abovefrac"===r?this.callFunction(r,[e,t[n],s],[]):this.callFunction(r,[e,s],[]),[l]}return t}handleSupSubscript(t){const r=this.fetch(),n=r.text;let s;this.consume(),this.consumeSpaces();do{s=this.parseGroup(t)}while(s.type&&"internal"===s.type);if(!s)throw new e("Expected group after '"+n+"'",r);return s}formatUnsupportedCmd(e){const t=[];for(let r=0;r<e.length;r++)t.push({type:"textord",mode:"text",text:e[r]});const r={type:"text",mode:this.mode,body:t};return{type:"color",mode:this.mode,color:this.settings.errorColor,body:[r]}}parseAtom(t){const r=this.parseGroup("atom",t);if(r&&"internal"===r.type)return r;if("text"===this.mode)return r;let n,s;for(;;){this.consumeSpaces();const t=this.fetch();if("\\limits"===t.text||"\\nolimits"===t.text){if(r&&"op"===r.type){const e="\\limits"===t.text;r.limits=e,r.alwaysHandleSupSub=!0}else{if(!r||"operatorname"!==r.type)throw new e("Limit controls must follow a math operator",t);r.alwaysHandleSupSub&&(r.limits="\\limits"===t.text)}this.consume()}else if("^"===t.text){if(n)throw new e("Double superscript",t);n=this.handleSupSubscript("superscript")}else if("_"===t.text){if(s)throw new e("Double subscript",t);s=this.handleSupSubscript("subscript")}else if("'"===t.text){if(n)throw new e("Double superscript",t);const r={type:"textord",mode:this.mode,text:"\\prime"},s=[r];for(this.consume();"'"===this.fetch().text;)s.push(r),this.consume();"^"===this.fetch().text&&s.push(this.handleSupSubscript("superscript")),n={type:"ordgroup",mode:this.mode,body:s}}else{if(!on[t.text])break;{const e=sn.test(t.text),r=[];for(r.push(new We(on[t.text])),this.consume();;){const t=this.fetch().text;if(!on[t])break;if(sn.test(t)!==e)break;r.unshift(new We(on[t])),this.consume()}const o=this.subparse(r);e?s={type:"ordgroup",mode:"math",body:o}:n={type:"ordgroup",mode:"math",body:o}}}}if(n||s){if(r&&"multiscript"===r.type&&!r.postscripts)return r.postscripts={sup:n,sub:s},r;{const e=!r||"op"!==r.type&&"operatorname"!==r.type?void 0:Gt(this.nextToken.text);return{type:"supsub",mode:this.mode,base:r,sup:n,sub:s,isFollowedByDelimiter:e}}}return r}parseFunction(t,r){const n=this.fetch(),s=n.text,o=Xr[s];if(!o)return null;if(this.consume(),r&&"atom"!==r&&!o.allowedInArgument)throw new e("Got function '"+s+"' with no arguments"+(r?" as "+r:""),n);if("text"===this.mode&&!o.allowedInText)throw new e("Can't use function '"+s+"' in text mode",n);if("math"===this.mode&&!1===o.allowedInMath)throw new e("Can't use function '"+s+"' in math mode",n);const a=this.prevAtomType,{args:l,optArgs:i}=this.parseArguments(s,o);return this.prevAtomType=a,this.callFunction(s,l,i,n,t)}callFunction(t,r,n,s,o){const a={funcName:t,parser:this,token:s,breakOnTokenText:o},l=Xr[t];if(l&&l.handler)return l.handler(a,r,n);throw new e(`No function handler for ${t}`)}parseArguments(t,r){const n=r.numArgs+r.numOptionalArgs;if(0===n)return{args:[],optArgs:[]};const s=[],o=[];for(let a=0;a<n;a++){let n=r.argTypes&&r.argTypes[a];const l=a<r.numOptionalArgs;(r.primitive&&null==n||"sqrt"===r.type&&1===a&&null==o[0])&&(n="primitive");const i=this.parseGroupOfType(`argument to '${t}'`,n,l);if(l)o.push(i);else{if(null==i)throw new e("Null argument, please report this as a bug");s.push(i)}}return{args:s,optArgs:o}}parseGroupOfType(t,r,n){switch(r){case"size":return this.parseSizeGroup(n);case"url":return this.parseUrlGroup(n);case"math":case"text":return this.parseArgumentGroup(n,r);case"hbox":{const e=this.parseArgumentGroup(n,"text");return null!=e?{type:"styling",mode:e.mode,body:[e],scriptLevel:"text"}:null}case"raw":{const e=this.parseStringGroup("raw",n);return null!=e?{type:"raw",mode:"text",string:e.text}:null}case"primitive":{if(n)throw new e("A primitive argument cannot be optional");const r=this.parseGroup(t);if(null==r)throw new e("Expected group as "+t,this.fetch());return r}case"original":case null:case void 0:return this.parseArgumentGroup(n);default:throw new e("Unknown group type as "+t,this.fetch())}}consumeSpaces(){for(;;){const e=this.fetch().text;if(" "!==e&&" "!==e&&"︎"!==e)break;this.consume()}}parseStringGroup(e,t){const r=this.gullet.scanArgument(t);if(null==r)return null;let n,s="";for(;"EOF"!==(n=this.fetch()).text;)s+=n.text,this.consume();return this.consume(),r.text=s,r}parseRegexGroup(t,r){const n=this.fetch();let s,o=n,a="";for(;"EOF"!==(s=this.fetch()).text&&t.test(a+s.text);)o=s,a+=o.text,this.consume();if(""===a)throw new e("Invalid "+r+": '"+n.text+"'",n);return n.range(o,a)}parseSizeGroup(t){let r,n=!1;if(this.gullet.consumeSpaces(),r=t||"{"===this.gullet.future().text?this.parseStringGroup("size",t):this.parseRegexGroup(/^[-+]? *(?:$|\d+|\d+\.\d*|\.\d*) *[a-z]{0,2} *$/,"size"),!r)return null;t||0!==r.text.length||(r.text="0pt",n=!0);const s=pn.exec(r.text);if(!s)throw new e("Invalid size: '"+r.text+"'",r);const o={number:+(s[1]+s[2]),unit:s[3]};if(!Oe(o))throw new e("Invalid unit: '"+o.unit+"'",r);return{type:"size",mode:this.mode,value:o,isBlank:n}}parseUrlGroup(e){this.gullet.lexer.setCatcode("%",13),this.gullet.lexer.setCatcode("~",12);const t=this.parseStringGroup("url",e);if(this.gullet.lexer.setCatcode("%",14),this.gullet.lexer.setCatcode("~",13),null==t)return null;let r=t.text.replace(/\\([#$%&~_^{}])/g,"$1");return r=t.text.replace(/{\u2044}/g,"/"),{type:"url",mode:this.mode,url:r}}parseArgumentGroup(e,t){const r=this.gullet.scanArgument(e);if(null==r)return null;const n=this.mode;t&&this.switchMode(t),this.gullet.beginGroup();const s=this.parseExpression(!1,"EOF");this.expect("EOF"),this.gullet.endGroup();const o={type:"ordgroup",mode:this.mode,loc:r.loc,body:s};return t&&this.switchMode(n),o}parseGroup(t,r){const n=this.fetch(),s=n.text;if("argument to '\\left'"===t)return this.parseSymbol();let o;if("{"===s||"\\begingroup"===s||"\\toggle"===s){this.consume();const e="{"===s?"}":"\\begingroup"===s?"\\endgroup":"\\endtoggle";this.gullet.beginGroup();const t=this.parseExpression(!1,e),r=this.fetch();this.expect(e),this.gullet.endGroup(),o={type:"\\endtoggle"===r.text?"toggle":"ordgroup",mode:this.mode,loc:Ve.range(n,r),body:t,semisimple:"\\begingroup"===s||void 0}}else if(o=this.parseFunction(r,t)||this.parseSymbol(),null==o&&"\\"===s[0]&&!Object.prototype.hasOwnProperty.call(rn,s)){if(this.settings.throwOnError)throw new e("Unsupported function name: "+s,n);o=this.formatUnsupportedCmd(s),this.consume()}return o}formLigatures(e){let t=e.length-1;for(let r=0;r<t;++r){const n=e[r],s=n.text;"-"===s&&"-"===e[r+1].text&&(r+1<t&&"-"===e[r+2].text?(e.splice(r,3,{type:"textord",mode:"text",loc:Ve.range(n,e[r+2]),text:"---"}),t-=2):(e.splice(r,2,{type:"textord",mode:"text",loc:Ve.range(n,e[r+1]),text:"--"}),t-=1)),"'"!==s&&"`"!==s||e[r+1].text!==s||(e.splice(r,2,{type:"textord",mode:"text",loc:Ve.range(n,e[r+1]),text:s+s}),t-=1)}}parseSymbol(){const t=this.fetch();let r=t.text;if(/^\\verb[^a-zA-Z]/.test(r)){this.consume();let t=r.slice(5);const n="*"===t.charAt(0);if(n&&(t=t.slice(1)),t.length<2||t.charAt(0)!==t.slice(-1))throw new e("\\verb assertion failed --\n                    please report what input caused this bug");return t=t.slice(1,-1),{type:"verb",mode:"text",body:t,star:n}}if(Object.prototype.hasOwnProperty.call(cn,r[0])&&"math"===this.mode&&!D[this.mode][r[0]]){if(this.settings.strict&&"math"===this.mode)throw new e(`Accented Unicode text character "${r[0]}" used in math mode`,t);r=cn[r[0]]+r.slice(1)}const n="math"===this.mode?Kr.exec(r):null;let s;if(n&&(r=r.substring(0,n.index),"i"===r?r="ı":"j"===r&&(r="ȷ")),D[this.mode][r]){let e=D[this.mode][r].group;"bin"!==e||!mn.includes(this.prevAtomType)&&""!==this.prevAtomType||(e="open");const n=Ve.range(t);let o;if(Object.prototype.hasOwnProperty.call(j,e)){const t=e;o={type:"atom",mode:this.mode,family:t,loc:n,text:r},"rel"!==t&&"bin"!==t||"text"!==this.prevAtomType||un.test(n.lexer.input.slice(n.end))&&(o.needsSpacing=!0)}else{if(an[r]){this.consume();const e=this.fetch().text.charCodeAt(0),t=65025===e?"mathscr":"mathcal";return 65024!==e&&65025!==e||this.consume(),{type:"font",mode:"math",font:t,body:{type:"mathord",mode:"math",loc:n,text:an[r]}}}o={type:e,mode:this.mode,loc:n,text:r}}s=o}else{if(!(r.charCodeAt(0)>=128||Kr.exec(r)))return null;if(this.settings.strict&&"math"===this.mode)throw new e(`Unicode text character "${r[0]}" used in math mode`,t);s={type:"textord",mode:"text",loc:Ve.range(t),text:r}}if(this.consume(),n)for(let r=0;r<n[0].length;r++){const o=n[0][r];if(!ln[o])throw new e(`Unknown accent ' ${o}'`,t);const a=ln[o][this.mode]||ln[o].text;if(!a)throw new e(`Accent ${o} unsupported in ${this.mode} mode`,t);s={type:"accent",mode:this.mode,loc:Ve.range(t),label:a,isStretchy:!1,base:s}}return s}}const hn=function(t,r){if(!("string"==typeof t||t instanceof String))throw new TypeError("Temml can only parse string typed expression");let n,s;try{s=new dn(t,r),delete s.gullet.macros.current["\\df@tag"],n=s.parse()}catch(e){if("ParseError:  Unmatched delimiter"!==e.toString())throw e;r.wrapDelimiterPairs=!1,s=new dn(t,r),delete s.gullet.macros.current["\\df@tag"],n=s.parse()}if(!(n.length>0&&n[0].type&&"array"===n[0].type&&n[0].addEqnNum)&&s.gullet.macros.get("\\df@tag")){if(!r.displayMode)throw new e("\\tag works only in display mode");s.gullet.feed("\\df@tag"),n=[{type:"tag",mode:"text",body:n,tag:s.parse()}]}return n},gn=[2,2,3,3];class fn{constructor(e){this.level=e.level,this.color=e.color,this.font=e.font||"",this.fontFamily=e.fontFamily||"",this.fontSize=e.fontSize||1,this.fontWeight=e.fontWeight||"",this.fontShape=e.fontShape||"",this.maxSize=e.maxSize}extend(e){const t={level:this.level,color:this.color,font:this.font,fontFamily:this.fontFamily,fontSize:this.fontSize,fontWeight:this.fontWeight,fontShape:this.fontShape,maxSize:this.maxSize};for(const r in e)Object.prototype.hasOwnProperty.call(e,r)&&(t[r]=e[r]);return new fn(t)}withLevel(e){return this.extend({level:e})}incrementLevel(){return this.extend({level:Math.min(this.level+1,3)})}inSubOrSup(){return this.extend({level:gn[this.level]})}withColor(e){return this.extend({color:e})}withFont(e){return this.extend({font:e})}withTextFontFamily(e){return this.extend({fontFamily:e,font:""})}withFontSize(e){return this.extend({fontSize:e})}withTextFontWeight(e){return this.extend({fontWeight:e,font:""})}withTextFontShape(e){return this.extend({fontShape:e,font:""})}getColor(){return this.color}}function bn(e){const t={};let r=0;const n=document.getElementsByClassName("tml-eqn");for(let e of n)for(r+=1,e.setAttribute("id","tml-eqn-"+String(r));"mtable"!==e.tagName;){if(e.getElementsByClassName("tml-label").length>0){const n=e.attributes.id.value;t[n]=String(r);break}e=e.parentElement}const s=document.getElementsByClassName("tml-tageqn");for(const e of s){if(e.getElementsByClassName("tml-label").length>0){const r=e.getElementsByClassName("tml-tag");if(r.length>0){const n=e.attributes.id.value;t[n]=r[0].textContent}}}[...e.getElementsByClassName("tml-ref")].forEach(e=>{const r=e.getAttribute("href");let n=t[r.slice(1)];-1===e.className.indexOf("tml-eqref")?(n=n.replace(/^\(/,""),n=n.replace(/\)$/,"")):("("!==n.charAt(0)&&(n="("+n),")"!==n.slice(-1)&&(n+=")"));const s=document.createElementNS("http://www.w3.org/1998/Math/MathML","mtext");s.appendChild(document.createTextNode(n));const o=document.createElementNS("http://www.w3.org/1998/Math/MathML","math");o.appendChild(s),e.textContent="",e.appendChild(o)})}const yn=function(e,t,r){let n=r,s=0;const o=e.length;for(;n<t.length;){const r=t[n];if(s<=0&&t.slice(n,n+o)===e)return n;"\\"===r?n++:"{"===r?s++:"}"===r&&s--,n++}return-1},wn=/^\\(?:begin|(?:eq)?ref){/,xn=[{left:"$$",right:"$$",display:!0},{left:"\\(",right:"\\)",display:!1},{left:"\\begin{equation}",right:"\\end{equation}",display:!0},{left:"\\begin{equation*}",right:"\\end{equation*}",display:!0},{left:"\\begin{align}",right:"\\end{align}",display:!0},{left:"\\begin{align*}",right:"\\end{align*}",display:!0},{left:"\\begin{alignat}",right:"\\end{alignat}",display:!0},{left:"\\begin{alignat*}",right:"\\end{alignat*}",display:!0},{left:"\\begin{gather}",right:"\\end{gather}",display:!0},{left:"\\begin{gather*}",right:"\\end{gather*}",display:!0},{left:"\\begin{CD}",right:"\\end{CD}",display:!0},{left:"\\ref{",right:"}",display:!1},{left:"\\eqref{",right:"}",display:!1},{left:"\\[",right:"\\]",display:!0}],kn={$:[{left:"$$",right:"$$",display:!0},{left:"$`",right:"`$",display:!1},{left:"$",right:"$",display:!1}],"(":[{left:"\\[",right:"\\]",display:!0},{left:"\\(",right:"\\)",display:!1}]},vn=[{left:"\\begin{equation}",right:"\\end{equation}",display:!0},{left:"\\begin{equation*}",right:"\\end{equation*}",display:!0},{left:"\\begin{align}",right:"\\end{align}",display:!0},{left:"\\begin{align*}",right:"\\end{align*}",display:!0},{left:"\\begin{alignat}",right:"\\end{alignat}",display:!0},{left:"\\begin{alignat*}",right:"\\end{alignat*}",display:!0},{left:"\\begin{gather}",right:"\\end{gather}",display:!0},{left:"\\begin{gather*}",right:"\\end{gather*}",display:!0},{left:"\\begin{CD}",right:"\\end{CD}",display:!0},{left:"\\ref{",right:"}",display:!1},{left:"\\eqref{",right:"}",display:!1}],An=function(t,r){const n=function(e,t){let r;const n=[],s=new RegExp("("+t.map(e=>e.left.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&")).join("|")+")");for(;r=e.search(s),-1!==r;){r>0&&(n.push({type:"text",data:e.slice(0,r)}),e=e.slice(r));const s=t.findIndex(t=>e.startsWith(t.left));if(r=yn(t[s].right,e,t[s].left.length),-1===r)break;const o=e.slice(0,r+t[s].right.length),a=wn.test(o)?o:e.slice(t[s].left.length,r);n.push({type:"math",data:a,rawData:o,display:t[s].display}),e=e.slice(r+t[s].right.length)}return""!==e&&n.push({type:"text",data:e}),n}(t,r.delimiters);if(1===n.length&&"text"===n[0].type)return null;const s=document.createDocumentFragment();for(let t=0;t<n.length;t++)if("text"===n[t].type)s.appendChild(document.createTextNode(n[t].data));else{const o=document.createElement("span");let a=n[t].data;r.displayMode=n[t].display;try{r.preProcess&&(a=r.preProcess(a)),temml.render(a,o,r)}catch(o){if(!(o instanceof e))throw o;r.errorCallback("Temml auto-render: Failed to parse `"+n[t].data+"` with ",o),s.appendChild(document.createTextNode(n[t].rawData));continue}s.appendChild(o)}return s},Tn=function(e,t){for(let r=0;r<e.childNodes.length;r++){const n=e.childNodes[r];if(3===n.nodeType){const s=An(n.textContent,t);s&&(r+=s.childNodes.length-1,e.replaceChild(s,n))}else if(1===n.nodeType){const e=" "+n.className+" ";-1===t.ignoredTags.indexOf(n.nodeName.toLowerCase())&&t.ignoredClasses.every(t=>-1===e.indexOf(" "+t+" "))&&Tn(n,t)}}};let Sn=function(e,t,r={}){t.textContent="";const n="math"===t.tagName.toLowerCase();n&&(r.wrap="none");const s=On(e,r);n||s.children.length>1?(t.textContent="",s.children.forEach(e=>{t.appendChild(e.toNode())})):t.appendChild(s.toNode())};"undefined"!=typeof document&&"CSS1Compat"!==document.compatMode&&("undefined"!=typeof console&&console.warn("Warning: Temml doesn't work in quirks mode. Make sure your website has a suitable doctype."),Sn=function(){throw new e("Temml doesn't work in quirks mode.")});const On=function(t,r){const n=new u(r);try{const e=hn(t,n);return we(e,t,new fn({level:n.displayMode?Xe:Ze,maxSize:n.maxSize}),n)}catch(r){return function(t,r,n){if(n.throwOnError||!(t instanceof e))throw t;const s=new T(["temml-error"],[new S(r+"\n\n"+t.toString())]);return s.style.color=n.errorColor,s.style.whiteSpace="pre-line",s}(r,t,n)}};return{version:"0.14.0",render:Sn,renderToString:function(e,t){return On(e,t).toMarkup()},renderMathInElement:function(e,t){if(!e)throw new Error("No element provided to render");const r={};for(const e in t)Object.prototype.hasOwnProperty.call(t,e)&&(r[e]=t[e]);r.fences?r.delimiters=(e=>{if("$"===e||"("===e)return kn[e];if("$+"===e||"(+"===e)return kn[e.slice(0,1)].concat(vn);return"ams"===e?vn:"all"===e?kn["("].concat(kn.$).concat(vn):xn})(r.fences):r.delimiters=r.delimiters||xn,r.ignoredTags=r.ignoredTags||["script","noscript","style","textarea","pre","code","option"],r.ignoredClasses=r.ignoredClasses||[],r.errorCallback=r.errorCallback||console.error,r.macros=r.macros||Object.create(null),Tn(e,r),bn(e)},postProcess:bn,ParseError:e,definePreamble:function(e,t){const r=new u(t);if(r.macros=Object.create(null),!("string"==typeof e||e instanceof String))throw new TypeError("Temml can only parse string typed expression");const n=new dn(e,r,!0);delete n.gullet.macros.current["\\df@tag"];return n.parse()},__parse:function(e,t){const r=new u(t);return hn(e,r)},__renderToMathMLTree:On,__defineSymbol:G,__defineMacro:Qe}}();
/*! arXiv Discovery packaging. The preceding Temml v0.14.0 browser build is unmodified.

The MIT License (MIT)

Copyright (c) 2020 Ron Kok

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

KaTeX portions
The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/


return {temml};
},
"src/exports.js": (__require) => {
function csvCell(value) { let text=String(value??''); if(/^[\s\u0000-\u001f]*[=+@\-]/.test(text)||/^[\t\r\n]/.test(text)) text=`'${text}`;return `"${text.replace(/"/g,'""')}"`; }
function feedbackCSV(state) {
  const rows=[['event_id','paper_id','version','timestamp','feedback','reason','mode','excluded','revision_of','title']];
  for(const e of state.events) rows.push([e.eventId,e.paperId,e.version,e.timestamp,e.value,e.reason,e.mode,e.excluded,e.revisionOf,e.paper?.title||state.papers[e.paperId]?.title||'']);
  return rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
}
function readingCSV(state) {
  return [['paper_id','read_at','title','abstract_url'],...Object.entries(state.reading).map(([id,at])=>[id,at,state.papers[id]?.title||'',state.papers[id]?.links?.abstract||`https://arxiv.org/abs/${id}`])].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
function bookmarksBibtex(state) {
  // Bibliography metadata is text, never a source of executable TeX commands.
  const tex={'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','%':'\\%','#':'\\#','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
  const esc=v=>String(v||'').replace(/[\\{}$&%#_~^]/g,c=>tex[c]).replace(/[\r\n]+/g,' ');
  return Object.keys(state.bookmarks).map(id=>state.papers[id]).filter(Boolean).map(p=>`@misc{arxiv${p.id.replace(/[^a-zA-Z0-9]/g,'')},\n  title = {${esc(p.title)}},\n  author = {${p.authors.map(a=>esc(a.name)).join(' and ')}},\n  eprint = {${esc(p.id)}},\n  archivePrefix = {arXiv},\n  primaryClass = {${esc(p.primaryCategory)}},\n  year = {${String(p.announcementDate||'').slice(0,4)}},\n  url = {https://arxiv.org/abs/${p.id}}\n}`).join('\n\n')+'\n';
}
function downloadText(filename,text,type='text/plain') {
  const blob=new Blob([text],{type:`${type};charset=utf-8`});const url=URL.createObjectURL(blob);
  // Never expose a private backup's Blob URL in arXiv's public DOM.
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}

return {csvCell,feedbackCSV,readingCSV,bookmarksBibtex,downloadText};
},
"src/transport.js": (__require) => {
let transportQueue=Promise.resolve();
let lastArxivRequest=0;
function backoffUntil(headers,now=Date.now()) {
  const value=String(headers||'').match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
  const delay=value&&/^\d+$/.test(value)?Number(value)*1000:value?Date.parse(value)-now:60000;
  return now+Math.max(15000,Number.isFinite(delay)?delay:60000);
}
function gmRequest(url,options={}) {
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

return {backoffUntil,gmRequest};
}
};
const __cache = Object.create(null);
function __require(name) { return __cache[name] || (__cache[name] = __factories[name](__require)); }
__require("src/main.js");
})();

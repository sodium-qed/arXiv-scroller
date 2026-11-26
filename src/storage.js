import {activeFeedback, paperFeatures} from './recommender.js';
import {SCHEMA_VERSION, DEFAULT_SETTINGS, COLLECTIONS, checkedRecord, recordKey, checkedPaper, checkRevisionGraph,
  mergedSettings, emptyState, validateImport, checkedPublicListing, publicListingKey} from './schema.js';

export {SCHEMA_VERSION, DEFAULT_SETTINGS, mergedSettings, emptyState, validateImport};

const PREFIX = 'arxiv-discovery:v1:';
const JOURNAL = PREFIX + 'transaction';
const GENERATION = PREFIX + 'generation';
const REVISION = PREFIX + 'revision';
const SETTINGS = PREFIX + 'settings';
const SCHEMA = PREFIX + 'schema';
const DIGEST = PREFIX + 'listing-digest:';
const LOCAL_QUEUES = new WeakMap();

export function makeId() {
  return globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
}

export function createGMAdapter() {
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

export class Store {
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
export class PublicCache {
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

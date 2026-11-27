import test from 'node:test';
import assert from 'node:assert/strict';
import {Store, emptyState, validateImport} from '../src/storage.js';
import {checkedPaper} from '../src/schema.js';
import {bookmarksBibtex} from '../src/exports.js';

const prefix = 'arxiv-discovery:v1:';
const savedAt = '2026-11-26T10:00:00Z';
const id = '2611.00001';
const rich = {
  id, version:2, versionedId:id+'v2', title:'The originally saved paper',
  authors:[{name:'Original Author', url:null, stableId:null}],
  categories:['math.NT'], primaryCategory:'math.NT',
  abstract:'The original abstract contains the saved theorem.', comments:'Original version comments.', journalRef:'Original journal reference.',
  announcementDate:'2026-11-25', section:'new',
  links:{abstract:'https://arxiv.org/abs/'+id+'v2', pdf:'https://arxiv.org/pdf/'+id+'v2', html:null}
};
const sparse = {
  ...rich, version:0, versionedId:id, title:'Current sparse listing title', abstract:'', comments:'', journalRef:'',
  announcementDate:'2026-11-26', section:null,
  links:{abstract:'https://arxiv.org/abs/'+id, pdf:'https://arxiv.org/pdf/'+id, html:null}
};

function adapter() {
  const values = new Map();
  return {
    values, get:async (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    set:async (key, value) => { values.set(key, structuredClone(value)); },
    remove:async key => { values.delete(key); }, keys:async () => [...values.keys()]
  };
}

function legacyBackup(paper = rich) {
  const state = emptyState();
  delete state.savedPapers;
  state.papers[paper.id] = paper;
  state.bookmarks[paper.id] = savedAt;
  return {format:'arxiv-discovery', schemaVersion:1, state};
}

test('legacy bookmarked rich v2 survives a sparse version-0 cache replacement and reload', async () => {
  const a = adapter();
  a.values.set(prefix+'papers:'+id, rich);
  a.values.set(prefix+'bookmarks:'+id, savedAt);
  const store = new Store(a);
  const legacy = await store.initialize();
  assert.deepEqual(legacy.savedPapers[id], checkedPaper(rich));
  legacy.papers[id].abstract = 'A caller mutated its mutable paper record';
  assert.equal(legacy.savedPapers[id].abstract, rich.abstract);
  await store.cachePapers([sparse]);
  const restored = await new Store(a).initialize();
  assert.deepEqual(restored.papers[id], checkedPaper(sparse));
  assert.deepEqual(restored.savedPapers[id], checkedPaper(rich));
  assert.deepEqual(a.values.get(prefix+'savedPapers:'+id), checkedPaper(rich));
  assert.equal(restored.bookmarks[id], savedAt);
});

test('bookmark writes pin canonical metadata until unbookmark, then rebookmark captures the current paper', async () => {
  const a = adapter(), store = new Store(a);
  await store.initialize();
  await store.cachePapers([rich]);
  await store.set('bookmarks', id, savedAt);
  await store.cachePapers([sparse]);
  await store.set('bookmarks', id, '2026-11-27T10:00:00Z');
  assert.deepEqual((await store.load()).savedPapers[id], checkedPaper(rich));
  await store.remove('bookmarks', id);
  assert.equal(a.values.has(prefix+'bookmarks:'+id), false);
  assert.equal(a.values.has(prefix+'savedPapers:'+id), false);
  assert.deepEqual((await store.load()).savedPapers, {});
  await store.set('bookmarks', id, savedAt);
  assert.deepEqual((await store.load()).savedPapers[id], checkedPaper(sparse));
});

test('atomic rebookmark pins the supplied Saved version without overwriting current sparse canonical metadata', async () => {
  const store = new Store(adapter());
  await store.initialize();
  await store.cachePapers([sparse]);
  await store.bookmarkPaper(sparse, savedAt);
  await store.remove('bookmarks', id);
  const pinned = await store.bookmarkPaper(rich, savedAt);
  assert.deepEqual(pinned, checkedPaper(rich));
  const later = await store.bookmarkPaper({...rich, title:'A later competing save'}, '2026-11-27T10:00:00Z');
  assert.deepEqual(later, pinned);
  const state = await store.load();
  assert.deepEqual(state.papers[id], checkedPaper(sparse));
  assert.deepEqual(state.savedPapers[id], checkedPaper(rich));
  assert.equal(state.bookmarks[id], '2026-11-27T10:00:00Z');
});

test('atomic bookmark creation preserves legacy originals and serializes competing first saves', async () => {
  const a = adapter(), first = new Store(a), second = new Store(a);
  await first.initialize();
  a.values.set(prefix+'papers:'+id, rich);
  a.values.set(prefix+'bookmarks:'+id, savedAt);
  assert.deepEqual(await first.bookmarkPaper(sparse, savedAt), checkedPaper(rich));
  await first.remove('bookmarks', id);
  const [winning, repeated] = await Promise.all([
    first.bookmarkPaper(rich, savedAt), second.bookmarkPaper(sparse, savedAt)
  ]);
  assert.deepEqual(winning, checkedPaper(rich));
  assert.deepEqual(repeated, winning);
  assert.deepEqual((await second.load()).savedPapers[id], winning);
  const empty = new Store(adapter());
  await empty.initialize();
  await empty.bookmarkPaper(rich, savedAt);
  assert.deepEqual((await empty.load()).papers[id], checkedPaper(rich));
});

test('atomic bookmarks validate before writing and roll back a snapshot if the bookmark write fails', async () => {
  const a = adapter(), store = new Store(a);
  await store.initialize();
  await store.cachePapers([sparse]);
  const before = structuredClone([...a.values]);
  assert.throws(() => store.bookmarkPaper(rich, 'not a timestamp'), /Invalid/);
  assert.throws(() => store.bookmarkPaper({...rich, versionedId:id+'v3'}, savedAt), /Invalid/);
  assert.deepEqual([...a.values], before);
  const set = a.set;
  a.set = async (key, value) => {
    if (key === prefix+'bookmarks:'+id) throw new Error('Simulated bookmark write failure');
    return set(key, value);
  };
  await assert.rejects(store.bookmarkPaper(rich, savedAt), /bookmark write failure/);
  a.set = set;
  const state = await new Store(a).initialize();
  assert.deepEqual(state.papers[id], checkedPaper(sparse));
  assert.deepEqual(state.bookmarks, {});
  assert.deepEqual(state.savedPapers, {});
  assert.equal(a.values.has(prefix+'transaction'), false);
});

test('clearing bookmarks erases all saved snapshots while retaining reading records and the public paper cache', async () => {
  const a = adapter(), store = new Store(a);
  await store.initialize();
  await store.cachePapers([rich]);
  await store.set('bookmarks', id, savedAt);
  await store.set('reading', id, savedAt);
  await store.clearCollection('bookmarks');
  const state = await store.load();
  assert.deepEqual(state.bookmarks, {});
  assert.deepEqual(state.savedPapers, {});
  assert.equal(state.reading[id], savedAt);
  assert.deepEqual(state.papers[id], checkedPaper(rich));
  assert.equal([...a.values.keys()].some(key => key.startsWith(prefix+'savedPapers:')), false);
});

test('legacy backups restore saved metadata and new backups round-trip original snapshots after cache changes', async () => {
  const legacy = legacyBackup();
  assert.doesNotThrow(() => validateImport(legacy));
  const first = new Store(adapter());
  await first.initialize();
  await first.import(legacy);
  await first.cachePapers([sparse]);
  const portable = await first.export();
  assert.deepEqual(portable.state.savedPapers[id], checkedPaper(rich));
  const restored = new Store(adapter());
  await restored.initialize();
  await restored.import(portable);
  assert.deepEqual((await restored.load()).savedPapers[id], checkedPaper(rich));
  assert.deepEqual((await restored.load()).papers[id], checkedPaper(sparse));
});

test('legacy import preserves an existing original snapshot and unrelated personal data; explicit snapshots restore intentionally', async () => {
  const store = new Store(adapter());
  await store.initialize();
  await store.cachePapers([rich]);
  await store.set('bookmarks', id, savedAt);
  await store.set('reading', id, savedAt);
  await store.set('knowledge', 'Limits', {level:'Comfortable', updatedAt:savedAt});
  await store.import(legacyBackup(sparse));
  let state = await store.load();
  assert.deepEqual(state.savedPapers[id], checkedPaper(rich));
  assert.deepEqual(state.papers[id], checkedPaper(sparse));
  assert.equal(state.reading[id], savedAt);
  assert.equal(state.knowledge.Limits.level, 'Comfortable');
  const explicit = legacyBackup(sparse);
  explicit.state.savedPapers = {[id]:{...rich, title:'An explicitly restored saved snapshot'}};
  await store.import(explicit);
  state = await store.load();
  assert.equal(state.savedPapers[id].title, 'An explicitly restored saved snapshot');
  assert.equal(state.reading[id], savedAt);
});

test('an import that only updates papers also preserves unsnapshotted legacy bookmarks before replacing metadata', async () => {
  const a = adapter(), store = new Store(a);
  a.values.set(prefix+'papers:'+id, rich);
  a.values.set(prefix+'bookmarks:'+id, savedAt);
  await store.import({format:'arxiv-discovery', schemaVersion:1, state:{papers:{[id]:sparse}}});
  const state = await store.load();
  assert.deepEqual(state.savedPapers[id], checkedPaper(rich));
  assert.deepEqual(state.papers[id], checkedPaper(sparse));
  assert.equal(state.bookmarks[id], savedAt);
});

test('saved snapshots are validated before import writes and BibTeX uses the saved title with legacy fallback', async () => {
  const a = adapter(), store = new Store(a);
  await store.initialize();
  const before = structuredClone([...a.values]);
  const invalid = legacyBackup();
  invalid.state.savedPapers = {[id]:{...rich, links:{...rich.links, abstract:'https://example.com/abs/'+id}}};
  await assert.rejects(store.import(invalid), /Invalid/);
  assert.deepEqual([...a.values], before);
  const state = emptyState();
  state.bookmarks[id] = savedAt;
  state.papers[id] = sparse;
  state.savedPapers[id] = rich;
  assert.match(bookmarksBibtex(state), /The originally saved paper/);
  assert.doesNotMatch(bookmarksBibtex(state), /Current sparse listing title/);
  delete state.savedPapers;
  assert.match(bookmarksBibtex(state), /Current sparse listing title/);
});

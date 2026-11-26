import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFeedback, analytics, conceptTerms, paperFeatures, predict, subscriptionMatches, trainModel } from '../src/recommender.js';

const date = '2026-05-15';
const now = '2026-05-15T12:00:00Z';
function paper(id, title, categories = ['math.CA'], abstract = '') {
  return {id, title, categories, abstract, authors: [], version: 1, primaryCategory: categories[0], announcementDate: date, section: 'new'};
}
function event(id, content, value, timestamp = now, patch = {}) {
  return {eventId: id, paperId: content.id, paper: content, value, timestamp, version: 1,
    mode: 'balanced', excluded: false, revisionOf: null, ...patch};
}
const inequalities = paper('p1', 'Weighted AM–GM inequalities');
const dynamics = paper('p2', 'Stability of ordinary differential equations');
const related = paper('p3', 'Arithmetic geometric mean bounds for positive vectors');
const unrelated = paper('p4', 'Long time asymptotics for nonlinear ODEs');

test('cold start, neutral, background, and removed feedback have no model estimate', () => {
  const noSignal = [event('a', inequalities, 'background'), event('b', dynamics, 'neutral'), event('c', related, 'removed')];
  for (const events of [[], noSignal]) {
    const model = trainModel(events, {});
    assert.equal(model.sampleCount, 0);
    assert.equal(predict(model, inequalities), null);
    assert.deepEqual(activeFeedback(events).excluded, []);
  }
});

test('the trained regularized classifier learns specific semantic concepts within one category', () => {
  const events = [event('a', inequalities, 'like'), event('b', dynamics, 'dislike')];
  const model = trainModel(events);
  assert.deepEqual([model.sampleCount, model.positiveCount, model.negativeCount], [2, 1, 1]);
  assert.ok(conceptTerms(inequalities).includes('arithmetic–geometric mean inequality'));
  assert.ok(conceptTerms(related).includes('arithmetic–geometric mean inequality'));
  const preferred = predict(model, related);
  const avoided = predict(model, unrelated);
  assert.ok(preferred > 0.5 && avoided < 0.5 && preferred - avoided > 0.15);
  assert.equal(preferred, predict(trainModel(events.toReversed()), related));
  const reversed = trainModel([event('a', inequalities, 'dislike'), event('b', dynamics, 'like')]);
  assert.ok(predict(reversed, related) < predict(reversed, unrelated));
});

test('titles, abstract vocabulary, and unknown phrases contribute features; snapshots cache by content', () => {
  const source = paper('p', 'Parking functions and Catalan paths', ['math.CO'], 'An explicit Catalan recurrence.');
  assert.ok(conceptTerms(source).some(term => term.includes('parking')));
  assert.ok(paperFeatures(source).entries.some(([key]) => key === 'word:recurrence'));
  assert.ok(paperFeatures(source).entries.some(([key]) => key === 'phrase:parking functions'));
  const copy = paperFeatures(source);
  copy.entries[0][1] = -999;
  assert.notEqual(paperFeatures(source).entries[0][1], -999);
  source.abstract = 'The Cauchy–Schwarz inequality.';
  assert.ok(conceptTerms(source).includes('Cauchy–Schwarz inequality'));
  source.categories = ['cs.IT'];
  source.primaryCategory = 'math-ph';
  assert.deepEqual(paperFeatures(source).entries.filter(([key]) => key.startsWith('subject:')).map(([key]) => key).sort(),
    ['subject:math.IT', 'subject:math.MP']);
  const like = event('l', source, 'like', now, {features: {schema: 'fake', entries: [['subject:math.LO', 1e9]]}});
  assert.equal(trainModel([like]).weights.has('subject:math.LO'), false);
});

test('supersession precedes time, collection-mode, individual, neutral, and removal filters', () => {
  const before = event('before', inequalities, 'like', '2026-04-01T00:00:00Z');
  const edit = event('edit', inequalities, 'dislike', '2026-05-05T00:00:00Z', {revisionOf: 'before'});
  const edits = [edit, before];
  for (const [events, settings] of [
    [edits, {history: {mode: 'after', end: '2026-04-30'}}],
    [[{...edit, mode: 'random'}, before], {trainRandom: false}],
    [[{...edit, excluded: true}, before], {}],
    [[{...edit, value: 'removed'}, before], {}],
    [[{...edit, value: 'neutral'}, before], {}],
    [[{...edit, value: 'background'}, before], {}],
  ]) {
    const {active, latest} = activeFeedback(events, settings, now);
    assert.deepEqual(active, []);
    assert.equal(latest[0].eventId, 'edit');
    assert.equal(trainModel(events, settings, now).sampleCount, 0);
  }
  const tied = {...edit, timestamp: before.timestamp};
  const rolledBack = {...edit, timestamp: '2026-03-31T12:00:00Z'};
  assert.equal(activeFeedback([tied, before]).active[0], tied);
  assert.equal(activeFeedback([rolledBack, before]).active[0], rolledBack);
});

test('all training-history controls use UTC day or rolling-hour boundaries, including exact cutoffs', () => {
  const times = ['2026-05-01T12:00:00Z', '2026-05-12T11:59:59Z', '2026-05-12T12:00:00Z', '2026-05-13T23:59:59Z', now];
  const events = times.map((stamp, i) => event(String(i), paper('item' + i, 'Finite element methods'), 'like', stamp));
  function ids(history, extra = {}) {
    return activeFeedback(events, {history, ...extra}, now).active.map(e => e.eventId);
  }
  assert.deepEqual(ids({mode: 'all'}), ['0', '1', '2', '3', '4']);
  assert.deepEqual(ids({mode: 'none'}), []);
  assert.deepEqual(ids({mode: 'lastDays', days: 3}), ['2', '3', '4']);
  assert.deepEqual(ids({mode: 'ignoreLastDays', days: 3}), ['0', '1']);
  assert.deepEqual(ids({mode: 'before', start: '2026-05-12'}), ['1', '2', '3', '4']);
  assert.deepEqual(ids({mode: 'after', end: '2026-05-12'}), ['0', '1', '2']);
  assert.deepEqual(ids({mode: 'excludeRange', start: '2026-05-13', end: '2026-05-12'}), ['0', '4']);
  assert.deepEqual(ids({mode: 'all'}, {resetAt: times[2]}), ['3', '4']);
  assert.deepEqual(ids({mode: 'all'}, {resetAt: null}), ['0', '1', '2', '3', '4']);
  const blocked = activeFeedback(events.map((e, i) => i === 1 ? {...e, mode: 'random'} : e), {trainRandom: false}, now);
  assert.deepEqual(blocked.excluded.map(e => e.eventId), ['1']);
});

test('rebuild after profile reset, restore, individual exclusion, and deletion uses only current snapshots', () => {
  const likes = event('a', inequalities, 'like', '2026-05-01T12:00:00Z');
  const dislikes = event('b', dynamics, 'dislike', '2026-05-02T12:00:00Z');
  const events = [likes, dislikes];
  const initial = predict(trainModel(events), related);
  assert.equal(predict(trainModel(events, {resetAt: now}), related), null);
  assert.equal(predict(trainModel(events, {resetAt: null}), related), initial);
  assert.equal(predict(trainModel(events, {history: {mode: 'none'}}), related), null);
  const excluded = trainModel([{...likes, excluded: true}, dislikes]);
  const deleted = trainModel([dislikes]);
  assert.equal(predict(excluded, related), predict(deleted, related));
  assert.equal(deleted.encounterPapers.some(p => p.id === inequalities.id), false);
  assert.equal(deleted.weights.has('concept:elementary inequalities'), false);
  assert.equal(predict(trainModel([]), related), null);
});

test('author matching verifies stable identifiers or explicit confirmation for exact name-only matches', () => {
  const name = 'Renée Example';
  const orcid = '0000-0002-1825-0097';
  const author = {name, stableId: 'https://orcid.org/' + orcid};
  assert.ok(subscriptionMatches(author, {name: 'Changed name', stableId: 'orcid:' + orcid}));
  assert.ok(!subscriptionMatches(author, {name, stableId: 'arxiv:other_1', confirmedNameOnly: true}));
  assert.ok(!subscriptionMatches({name}, {name}));
  assert.ok(subscriptionMatches({name: ' RENÉE  EXAMPLE '}, {name, confirmedNameOnly: true}));
  assert.ok(!subscriptionMatches({name: 'Renee Example'}, {name, confirmedNameOnly: true}));
  assert.ok(!subscriptionMatches({name: 'R. Example'}, {name, confirmedNameOnly: true}));
  assert.ok(!subscriptionMatches({name, url: '/search/math?query=Example'}, {name, url: '/search/math?query=Example'}));
});

test('analytics counts observed reviews, labels, sampling uncertainty, and independent interests separately', () => {
  const papers = [inequalities, dynamics, related, {...unrelated, categories: ['math.CA', 'math.CO']}];
  const events = [event('a', papers[0], 'like'), event('b', papers[1], 'dislike'),
    event('c', papers[2], 'like'), event('d', papers[3], 'background')];
  const state = {settings: {}, papers: Object.fromEntries(papers.map(p => [p.id, p])), events,
    reading: {[papers[0].id]: now}, subscriptions: [], knowledge: {}, glossary: {}};
  const data = analytics(state, {now});
  const category = data.categories.find(c => c.code === 'math.CA');
  assert.deepEqual([data.reviewedCount, data.activeCount, data.excludedCount, data.positiveCount, data.negativeCount, data.backgroundCount], [4, 3, 0, 2, 1, 1]);
  assert.deepEqual([category.reviewed, category.estimate, category.activeSamples, category.predictionSamples], [4, 2 / 3, 3, 4]);
  assert.ok(category.interval[0] < category.estimate && category.interval[1] > category.estimate);
  assert.ok(category.prediction > 0 && category.prediction < 1);
  const sparse = data.categories.find(c => c.code === 'math.CO');
  assert.equal(sparse.estimate, null);
  assert.equal(sparse.interval, null);
  assert.equal(data.timeline[0].categories['math.CO'].background, 1);
  assert.ok(data.likedConcepts.find(row => row.term === 'elementary inequalities').count === 2);
  const off = analytics({...state, settings: {history: {mode: 'none'}}}, {now});
  assert.deepEqual([off.activeCount, off.excludedCount, off.positiveCount], [0, 3, 2]);
  assert.ok(off.categories.every(row => row.prediction === null));
});

test('ranged analytics retains only dated visits and knowledge changes and never resurrects edited feedback', () => {
  const april = '2026-04-10T10:00:00Z';
  const may = '2026-05-10T10:00:00Z';
  const events = [event('a', inequalities, 'like', april), event('b', inequalities, 'removed', may, {revisionOf: 'a'})];
  const state = {settings: {}, events, papers: {[inequalities.id]: inequalities}, subscriptions: [], reading: {[inequalities.id]: april},
    glossary: {
      a: {term: 'Wasserstein distance', visits: 3, visitHistory: [april, may, may], updatedAt: may},
      b: {term: 'wasserstein distance', visits: 2, visitHistory: [april, may], updatedAt: may},
      c: {term: 'Legacy entry', visits: 12, updatedAt: april},
    },
    knowledge: {'optimal transport': {level: 'comfortable', updatedAt: may, history: [
      {level: 'introduced', updatedAt: april}, {level: 'comfortable', updatedAt: may}]}},
  };
  const data = analytics(state, {start: '2026-04-01', end: '2026-04-30', now});
  assert.deepEqual([data.positiveCount, data.activeCount, data.reviewedCount], [0, 0, 1]);
  assert.deepEqual(data.unfamiliarTerms, [{term: 'Wasserstein distance', count: 2}, {term: 'Legacy entry', count: 1}]);
  assert.deepEqual(data.knowledge.map(row => [row.term, row.level, row.history.length]), [['optimal transport', 'introduced', 1]]);
  assert.ok(data.categories.every(row => row.prediction === null && row.estimate === null));
  assert.equal(analytics(state, {now}).unfamiliarTerms[0].count, 12);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../src/categories.js';
import { generateSelection, replaceSelectionPaper } from '../src/sampling.js';
import { predict, trainModel } from '../src/recommender.js';

const date = '2026-05-15';
const codes = Object.keys(CATEGORIES).sort();
const options = {date, mode: 'random', seed: 'adaptive-tests', settings: {}};
function paper(id, categories, extra = {}) {
  return {id, version: 1, title: id, abstract: '', authors: [], primaryCategory: categories[0] || null,
    categories, announcementDate: date, section: 'new', ...extra};
}
function categoryCounts(entries) {
  return new Map(codes.map(code => [code, entries.filter(entry => entry.category === code).length]));
}
function assertAccounting(result, papers) {
  const byId = new Map(papers.map(p => [p.id, p]));
  assert.equal(result.samplingVersion, 2);
  assert.equal(result.entries.length, new Set(result.entries.map(entry => entry.paperId)).size);
  assert.equal(result.categoryDistribution.length, codes.length);
  const selected = categoryCounts(result.entries);
  for (const entry of result.entries) {
    assert.ok(byId.get(entry.paperId)?.categories.includes(entry.category), 'assignment must be an eligibility edge');
  }
  for (const row of result.categoryDistribution) {
    assert.equal(row.squareRootQuota, Math.ceil(Math.sqrt(row.eligibleCount)));
    assert.equal(row.quota, result.mode === 'discovery' ? Number(row.eligibleCount > 0) : row.squareRootQuota);
    assert.equal(row.selectedCount, selected.get(row.category));
    assert.ok(row.selectedCount <= row.quota);
    if (row.quota > row.selectedCount) {
      assert.equal(typeof row.reason, 'string');
      assert.ok(row.reason.length > 0);
      assert.ok(result.missing.some(missing => missing.category === row.category));
    }
  }
  assert.equal(result.targetSize, result.categoryDistribution.reduce((total, row) => total + row.quota, 0));
  assert.equal(result.shortfall, result.targetSize - result.entries.length);
}

// This oracle enumerates paper-to-category assignments directly. It does not
// use augmenting paths or duplicate category-slot vertices from the production
// algorithm. The objective is lexicographic: represented categories, then slots.
function bruteForceOptimum(papers, categoryCodes) {
  const quotas = categoryCodes.map(code => Math.ceil(Math.sqrt(papers.filter(p => p.categories.includes(code)).length)));
  const counts = new Array(categoryCodes.length).fill(0);
  let best = [0, 0];
  function visit(index, selected) {
    if (index === papers.length) {
      const breadth = counts.filter(Boolean).length;
      if (breadth > best[0] || (breadth === best[0] && selected > best[1])) best = [breadth, selected];
      return;
    }
    visit(index + 1, selected);
    for (let j = 0; j < categoryCodes.length; j++) {
      if (counts[j] >= quotas[j] || !papers[index].categories.includes(categoryCodes[j])) continue;
      counts[j]++;
      visit(index + 1, selected + 1);
      counts[j]--;
    }
  }
  visit(0, 0);
  return best;
}

test('adaptive matching attains the lexicographic optimum on all 4096 three-category/four-paper graphs', () => {
  const graphCodes = ['math.AC', 'math.AG', 'math.AP'];
  for (let mask = 0; mask < 4096; mask++) {
    const papers = Array.from({length: 4}, (_, i) =>
      paper('p' + i, graphCodes.filter((_, j) => mask & (1 << (3 * i + j)))));
    const expected = bruteForceOptimum(papers, graphCodes);
    const result = generateSelection(papers, {...options, seed: mask});
    assert.deepEqual([new Set(result.entries.map(entry => entry.category)).size, result.entries.length], expected, 'graph ' + mask);
    assertAccounting(result, papers);
  }
});

test('adaptive matching handles larger adversarial overlap graphs and randomized priorities', () => {
  const graphCodes = ['math.AC', 'math.AG', 'math.AP', 'math.AT'];
  const patterns = [
    [[0], [0], [0, 1], [1, 2], [2, 3], [3]],
    [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3], [0], [0]],
    [[0], [0], [0], [0], [1, 2, 3], [1, 2, 3]],
    [[0, 1], [0, 1], [0, 1], [0, 1], [2, 3], [2, 3]],
  ];
  for (const pattern of patterns) {
    const papers = pattern.map((indices, i) => paper('p' + i, indices.map(j => graphCodes[j])));
    const expected = bruteForceOptimum(papers, graphCodes);
    for (let seed = 0; seed < 24; seed++) {
      const result = generateSelection(papers, {...options, seed});
      assert.deepEqual([new Set(result.entries.map(entry => entry.category)).size, result.entries.length], expected);
      assertAccounting(result, papers);
    }
  }
});

test('empty pools and zero-eligible categories receive no quota and no artificial shortfall', () => {
  for (const mode of ['random', 'balanced', 'discovery']) {
    const result = generateSelection([], {...options, mode});
    assertAccounting(result, []);
    assert.equal(result.targetSize, 0);
    assert.equal(result.shortfall, 0);
    assert.equal(result.entries.length, 0);
    assert.ok(result.categoryDistribution.every(row => row.eligibleCount === 0 && row.quota === 0));
  }
  for (const mode of ['personalized', 'subscriptions']) {
    assert.equal(generateSelection([], {...options, mode}).entries.length, 0);
  }
});

test('square-root boundaries and uneven publication activity determine the complete daily size', () => {
  const sizes = [0, 1, 2, 3, 4, 5, 8, 9, 10, 15, 16, 17, 25, 100];
  const papers = sizes.flatMap((size, i) => Array.from({length: size}, (_, j) => paper(i + '-' + j, [codes[i]])));
  const expected = sizes.map(size => Math.ceil(Math.sqrt(size)));
  for (const mode of ['random', 'balanced']) {
    const result = generateSelection(papers, {...options, mode, settings: {personalizedCount: 1}});
    assertAccounting(result, papers);
    assert.equal(result.targetSize, expected.reduce((a, b) => a + b, 0));
    assert.ok(result.targetSize > 32, 'adaptive count must exceed the old fixed cap');
    assert.equal(result.shortfall, 0);
    for (let i = 0; i < sizes.length; i++) {
      const row = result.categoryDistribution.find(row => row.category === codes[i]);
      assert.deepEqual([row.eligibleCount, row.quota, row.selectedCount], [sizes[i], expected[i], expected[i]]);
    }
  }
});

test('coverage wins over extra slots when every candidate is cross-listed everywhere', () => {
  const papers = Array.from({length: 17}, (_, i) => paper('shared-' + i, codes));
  const result = generateSelection(papers, options);
  assertAccounting(result, papers);
  assert.equal(result.targetSize, 32 * 5);
  assert.equal(result.entries.length, 17);
  assert.equal(new Set(result.entries.map(entry => entry.category)).size, 17);
  assert.equal(result.shortfall, 143);
  assert.ok(result.entries.every(entry => entry.probability === null));
});

test('a local cross-list bottleneck reports unfilled quotas even when the whole pool is large enough', () => {
  const shared = ['a', 'b'].map(id => paper(id, ['math.AC', 'math.AG']));
  const unrelated = Array.from({length: 25}, (_, i) => paper('outside-' + i, ['math.NT']));
  const result = generateSelection([...shared, ...unrelated], options);
  assertAccounting(result, [...shared, ...unrelated]);
  assert.equal(result.targetSize, 9);
  assert.equal(result.entries.length, 7);
  assert.equal(result.shortfall, 2);
  for (const code of ['math.AC', 'math.AG']) {
    const row = result.categoryDistribution.find(row => row.category === code);
    assert.deepEqual([row.eligibleCount, row.quota, row.selectedCount], [2, 2, 1]);
    assert.match(row.reason, /cross|overlap|assigned|matching/i);
  }
  assert.equal(result.categoryDistribution.find(row => row.category === 'math.NT').selectedCount, 5);
});

test('duplicate versions and repeated categories are counted once and remain reproducible under input reordering', () => {
  const old = paper('same', ['math.AC', 'math.AC']);
  const newer = paper('same', ['math.AG'], {version: 2});
  const papers = [old, newer, old, paper('a', ['math.AC']), paper('b', ['math.AG']), paper('b', ['math.AG'])];
  const snapshot = structuredClone(papers);
  const result = generateSelection(papers, options);
  assert.deepEqual(result, generateSelection(papers.toReversed(), options));
  assert.equal(result.entries.length, 3);
  assert.equal(new Set(result.entries.map(entry => entry.paperId)).size, 3);
  for (const code of ['math.AC', 'math.AG']) {
    assert.equal(result.categoryDistribution.find(row => row.category === code).eligibleCount, 2);
  }
  assert.deepEqual(papers, snapshot);
});

test('balanced preferences and exploration change paper priorities without changing the quotas', () => {
  const papers = Array.from({length: 16}, (_, i) => paper('p' + i, [i < 9 ? 'math.CA' : 'math.NT'],
    {authors: [{name: i % 2 ? 'Followed' : 'Other'}]}));
  const subscriptions = [{id: 'followed', name: 'Followed', confirmedNameOnly: true}];
  const random = generateSelection(papers, options);
  for (const exploration of [0, 0.25, 0.7, 1]) {
    const result = generateSelection(papers, {...options, mode: 'balanced', subscriptions,
      settings: {exploration, useSubscriptions: true, personalizedCount: 200}});
    assert.deepEqual(result.categoryDistribution, random.categoryDistribution);
    assert.equal(result.targetSize, 6);
    if (exploration === 1) {
      assert.deepEqual(result.entries.map(({paperId, category, probability}) => ({paperId, category, probability})),
        random.entries.map(({paperId, category, probability}) => ({paperId, category, probability})));
    }
  }
});

test('all recommendation modes reproduce their selections from the same seed and logical pool', () => {
  const papers = Array.from({length: 80}, (_, i) => paper('p' + i.toString().padStart(2, '0'),
    i % 5 === 0 ? ['math.CA', 'math.NT'] : [i % 2 ? 'math.CA' : 'math.NT'],
    {title: i % 2 ? 'AM-GM inequalities' : 'Ordinary differential equations',
      authors: [{name: i % 3 ? 'Other' : 'Followed'}]}));
  const model = trainModel(papers.slice(0, 2).map((p, i) => ({eventId: 'r-' + i, timestamp: date + 'T12:00:00Z',
    value: i ? 'like' : 'dislike', paperId: p.id, paper: p, mode: 'balanced'})));
  const extra = {model, settings: {useSubscriptions: true}, subscriptions: [{name: 'Followed', confirmedNameOnly: true}],
    reading: {[papers[0].id]: date}, knownPapers: {[papers[0].id]: papers[0]}};
  for (const mode of ['random', 'balanced', 'personalized', 'discovery', 'subscriptions']) {
    const first = generateSelection(papers, {...options, ...extra, mode});
    assert.deepEqual(first, generateSelection(papers.toReversed(), {...options, ...extra, mode}), mode);
    if (mode !== 'subscriptions') {
      const next = generateSelection(papers, {...options, ...extra, mode, seed: 'different-seed'});
      assert.notDeepEqual(first.entries.map(entry => entry.paperId), next.entries.map(entry => entry.paperId), mode);
    }
  }
});

test('Personalized defaults to 50 and clamps configurable global sample sizes to 1 through 200', () => {
  const papers = Array.from({length: 250}, (_, i) => paper('p' + i, [codes[i % codes.length]]));
  assert.equal(generateSelection(papers, {...options, mode: 'personalized'}).entries.length, 50);
  for (const [setting, expected] of [[1, 1], [32, 32], [50, 50], [200, 200], [201, 200], [0, 1], [-5, 1], [3.9, 3], [NaN, 50]]) {
    const result = generateSelection(papers, {...options, mode: 'personalized', settings: {personalizedCount: setting}});
    assert.equal(result.entries.length, expected);
    assert.equal(new Set(result.entries.map(entry => entry.paperId)).size, expected);
    assert.ok(result.entries.every(entry => entry.category === null && entry.probability === expected / papers.length));
  }
});

test('cold-start Personalized is globally uniform and does not impose one paper from each category', () => {
  const papers = Array.from({length: 100}, (_, i) => paper('p' + i, [i < 91 ? 'math.CA' : 'math.NT']));
  const small = new Set(papers.slice(91).map(p => p.id));
  let selectedSmall = 0;
  for (let seed = 0; seed < 2000; seed++) {
    const result = generateSelection(papers, {...options, mode: 'personalized', seed, settings: {personalizedCount: 1}});
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0];
    assert.equal(entry.category, null);
    assert.equal(entry.probability, 1 / 100);
    if (small.has(entry.paperId)) selectedSmall++;
  }
  assert.ok(Math.abs(selectedSmall - 180) < 50);
});

test('global Personalized retains weighted sampling without replacement across categories', () => {
  const liked = paper('liked', ['math.CA'], {title: 'An AM-GM inequality'});
  const disliked = paper('disliked', ['math.CA'], {title: 'Ordinary differential equations'});
  const model = trainModel([liked, disliked].map((p, i) => ({eventId: 'rating-' + i, timestamp: date + 'T12:00:00Z',
    value: i ? 'dislike' : 'like', paperId: p.id, paper: p, mode: 'balanced'})));
  const papers = [paper('a', ['math.CA'], {title: 'Arithmetic geometric mean inequality'}),
    paper('b', ['math.CA'], {title: 'AM-GM and symmetric inequalities'}),
    paper('c', ['math.NT'], {title: 'Ordinary differential equations'}),
    paper('d', ['math.NT'], {title: 'Long-time ordinary differential equations'})];
  const weights = papers.map(p => Math.exp(5 * (predict(model, p) - 0.5)));
  const total = weights.reduce((a, b) => a + b, 0);
  const expected = weights.map((weight, i) => weight / total + weights.reduce((sum, other, j) =>
    i === j ? sum : sum + other / total * weight / (total - other), 0));
  const counts = new Map(papers.map(p => [p.id, 0]));
  for (let seed = 0; seed < 2400; seed++) {
    const result = generateSelection(papers, {...options, mode: 'personalized', model, seed, settings: {personalizedCount: 2}});
    assert.equal(result.entries.length, 2);
    assert.equal(new Set(result.entries.map(entry => entry.paperId)).size, 2);
    for (const entry of result.entries) {
      assert.equal(entry.category, null);
      assert.equal(entry.probability, null);
      counts.set(entry.paperId, counts.get(entry.paperId) + 1);
    }
  }
  for (let i = 0; i < papers.length; i++) assert.ok(Math.abs(counts.get(papers[i].id) / 2400 - expected[i]) < 0.04);
});

test('multi-slot replacement follows several cross-list moves while retaining every other paper and category count', () => {
  const papers = [paper('old', ['math.AC']), paper('a', ['math.AC']), paper('ab', ['math.AC', 'math.AG']),
    paper('b', ['math.AG']), paper('bc', ['math.AG', 'math.AP']), paper('c', ['math.AP']),
    paper('new', ['math.AP']), paper('held', ['math.DG'])];
  const assigned = [['old', 'math.AC'], ['a', 'math.AC'], ['ab', 'math.AG'], ['b', 'math.AG'],
    ['bc', 'math.AP'], ['c', 'math.AP'], ['held', 'math.DG']];
  const selection = {mode: 'random', date, seed: 4, missing: [], entries: assigned.map(([paperId, category]) =>
    ({paperId, category, reason: 'Historical choice', probability: null}))};
  const snapshot = structuredClone(selection);
  const replacement = replaceSelectionPaper(selection, 'old', papers, {...options, seed: 'chain'});
  assert.ok(replacement);
  assert.deepEqual(new Set(replacement.entries.map(entry => entry.paperId)), new Set(['a', 'ab', 'b', 'bc', 'c', 'new', 'held']));
  assert.deepEqual(categoryCounts(replacement.entries), categoryCounts(selection.entries));
  assert.equal(replacement.entries.find(entry => entry.paperId === 'ab').category, 'math.AC');
  assert.equal(replacement.entries.find(entry => entry.paperId === 'bc').category, 'math.AG');
  assert.equal(replacement.entries.find(entry => entry.paperId === 'new').category, 'math.AP');
  for (const id of ['a', 'b', 'c', 'held']) {
    assert.deepEqual(replacement.entries.find(entry => entry.paperId === id), selection.entries.find(entry => entry.paperId === id));
  }
  assert.deepEqual(selection, snapshot);
  assert.equal(replaceSelectionPaper(selection, 'old', papers.filter(p => p.id !== 'new'), options), null);
});

test('100,000-paper announcements keep the full uncapped adaptive target', {timeout: 30000}, t => {
  const papers = Array.from({length: 100000}, (_, i) => paper('p' + i.toString().padStart(6, '0'), [codes[i % codes.length]]));
  const start = performance.now();
  const result = generateSelection(papers, options);
  t.diagnostic('100,000 disjoint-category papers: ' + Math.round(performance.now() - start) + ' ms');
  assertAccounting(result, papers);
  assert.equal(result.targetSize, 32 * 56);
  assert.equal(result.entries.length, 1792);
  assert.equal(result.shortfall, 0);
});

test('10,000 papers cross-listed into all categories do not overflow a slot recursion or duplicate IDs', {timeout: 30000}, t => {
  const papers = Array.from({length: 10000}, (_, i) => paper('p' + i.toString().padStart(5, '0'), codes));
  const start = performance.now();
  const result = generateSelection(papers, options);
  t.diagnostic('10,000 papers, 320,000 category edges: ' + Math.round(performance.now() - start) + ' ms');
  assertAccounting(result, papers);
  assert.equal(result.targetSize, 3200);
  assert.equal(result.entries.length, 3200);
  assert.equal(result.shortfall, 0);
  assert.ok(result.categoryDistribution.every(row => row.selectedCount === 100));
});

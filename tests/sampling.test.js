import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSelection, replaceSelectionPaper } from '../src/sampling.js';
import { analytics, predict, trainModel } from '../src/recommender.js';

const date = '2026-05-15';
const options = {mode: 'random', date, seed: 'daily-seed', settings: {}};
function paper(id, codes, data = {}) {
  return {id, version: 1, title: id, abstract: '', authors: [], primaryCategory: codes[0] || null,
    categories: codes, announcementDate: date, section: 'new', ...data};
}
function feedback(p, value) {
  return {eventId: 'r-' + p.id, timestamp: date + 'T12:00:00Z', value, paperId: p.id, paper: p, mode: 'balanced'};
}
const positive = paper('rated-a', ['math.CA'], {title: 'An AM–GM inequality'});
const negative = paper('rated-b', ['math.CA'], {title: 'Nonlinear ordinary differential equations'});
const ratings = [feedback(positive, 'like'), feedback(negative, 'dislike')];
const model = trainModel(ratings);
const related = paper('new-a', ['math.CA'], {title: 'The arithmetic geometric mean inequality'});
const unrelated = paper('new-b', ['math.CA'], {title: 'Long-time stability of ordinary differential equations'});

test('cold category draws are seed-stable under page reordering and have equal first-choice probabilities', () => {
  const papers = ['x', 'y', 'z'].map(id => paper(id, ['math.CO']));
  assert.deepEqual(generateSelection(papers, options), generateSelection(papers.toReversed(), options));
  const counts = new Map(papers.map(p => [p.id, 0]));
  for (let seed = 0; seed < 2400; seed++) {
    const result = generateSelection(papers, {...options, seed});
    assert.equal(result.entries.length, 1);
    assert.equal(result.missing.length, 31);
    const [entry] = result.entries;
    assert.equal(entry.category, 'math.CO');
    assert.equal(entry.probability, 1 / 3);
    counts.set(entry.paperId, counts.get(entry.paperId) + 1);
  }
  for (const n of counts.values()) assert.ok(Math.abs(n - 800) < 95);
});

test('augmenting paths cover all possible categories, prevent duplicate paper IDs and omit joint marginals', () => {
  const papers = [paper('abc', ['math.AC', 'math.AG', 'math.AP']), paper('ab', ['math.AC', 'math.AG']), paper('a', ['math.AC'])];
  for (let seed = 0; seed < 36; seed++) {
    const result = generateSelection([...papers, {...papers[0], version: 2}], {...options, seed});
    assert.equal(result.entries.length, 3);
    assert.deepEqual(Object.fromEntries(result.entries.map(e => [e.category, e.paperId])), {'math.AC': 'a', 'math.AG': 'ab', 'math.AP': 'abc'});
    assert.ok(result.entries.every(entry => entry.probability === null));
  }
  const only = generateSelection([papers[0]], options);
  assert.equal(only.entries.length, 1);
  assert.equal(only.missing.filter(m => m.reason.includes('maximum-coverage')).length, 2);
});

test('the matcher reaches the true optimum on every 3-by-3 eligibility graph', () => {
  const codes = ['math.AC', 'math.AG', 'math.AP'];
  function optimum(papers, i = 0, taken = new Set()) {
    if (i === codes.length) return 0;
    let best = optimum(papers, i + 1, taken);
    for (const candidate of papers) {
      if (!taken.has(candidate.id) && candidate.categories.includes(codes[i])) {
        best = Math.max(best, 1 + optimum(papers, i + 1, new Set([...taken, candidate.id])));
      }
    }
    return best;
  }
  for (let mask = 0; mask < 512; mask++) {
    const papers = Array.from({length: 3}, (_, i) => paper(String(i), codes.filter((_, j) => (mask & (1 << (3 * i + j))) !== 0)));
    const {entries} = generateSelection(papers, {...options, seed: mask});
    assert.equal(entries.length, optimum(papers), 'graph ' + mask);
    assert.equal(entries.length, new Set(entries.map(entry => entry.paperId)).size);
    assert.equal(entries.length, new Set(entries.map(entry => entry.category)).size);
  }
});

test('eligibility uses the listing date, distinct section settings, math aliases and incomplete-listing reasons', () => {
  const papers = [
    paper('a', ['math.NT']), paper('b', ['cs.IT'], {section: 'cross'}),
    paper('c', ['math-ph'], {section: 'replacement'}), paper('d', ['math.CT'], {announcementDate: '2026-05-14'}),
    paper('nonmath', ['cs.AI']),
  ];
  const select = (settings, extra = {}) => generateSelection(papers, {...options, settings, ...extra});
  assert.deepEqual(select({}).entries.map(e => e.paperId), ['a']);
  assert.deepEqual(select({includeCross: true}).entries.map(e => e.paperId).sort(), ['a', 'b']);
  assert.deepEqual(select({includeReplacements: true}).entries.map(e => e.paperId).sort(), ['a', 'c']);
  assert.deepEqual(select({includeReplacements: true, includeCross: true}).entries.map(e => e.category).sort(), ['math.IT', 'math.MP', 'math.NT']);
  assert.match(select({}).missing.find(e => e.category === 'math.IT').reason, /cross-submissions/);
  assert.match(select({}).missing.find(e => e.category === 'math.MP').reason, /replacements/);
  assert.match(select({}, {complete: false}).missing.find(e => e.category === 'math.CT').reason, /loaded part/);
  assert.equal(select({}, {date: ''}).entries.length, 0);
});

test('Pure Random ignores profiles, subscriptions and exploration settings, and changes no state', () => {
  const papers = [related, unrelated];
  const baseline = generateSelection(papers, options);
  const altered = {model, settings: {exploration: 0, useSubscriptions: true}, reading: {[related.id]: date},
    subscriptions: [{name: 'Followed', confirmedNameOnly: true}]};
  assert.deepEqual(generateSelection(papers, {...options, ...altered}), baseline);
  for (let seed = 0; seed < 35; seed++) {
    const neutral = generateSelection(papers, {...options, seed});
    const balanced = generateSelection(papers, {...options, seed, mode: 'balanced', settings: {exploration: 1}, model});
    assert.deepEqual(neutral.entries.map(e => [e.paperId, e.probability]), balanced.entries.map(e => [e.paperId, e.probability]));
    const cold = generateSelection(papers, {...options, seed, mode: 'balanced', model: trainModel(ratings, {history: {mode: 'none'}})});
    assert.deepEqual(neutral.entries.map(e => e.paperId), cold.entries.map(e => e.paperId));
  }
  assert.deepEqual(generateSelection(papers, {...options, mode: 'original'}).entries, []);
  assert.equal(model.sampleCount, 2);
});

test('Balanced Exploration mixes uniform and learned within-category draws with known probability in isolated categories', () => {
  const papers = [related, unrelated];
  const e = 0.3;
  const weights = new Map(papers.map(p => [p.id, Math.exp(5 * (predict(model, p) - 0.5))]));
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  let preferred = 0;
  for (let seed = 0; seed < 600; seed++) {
    const selection = generateSelection(papers, {...options, mode: 'balanced', model, seed, settings: {exploration: e}});
    const [entry] = selection.entries;
    assert.ok(Math.abs(entry.probability - (e / papers.length + (1 - e) * weights.get(entry.paperId) / sum)) < 1e-12);
    if (entry.paperId === related.id) preferred++;
  }
  assert.ok(preferred > 360 && preferred < 570);
});

test('Personalized respects its finite count with or without a model, including several entries from one category', () => {
  const papers = [related, unrelated, paper('c', ['math.CA']), paper('d', ['math.CA']), paper('e', ['math.CA'])];
  const base = {...options, mode: 'personalized', settings: {personalizedCount: 3}};
  const cold = generateSelection(papers, base);
  assert.equal(cold.entries.length, 3);
  assert.ok(cold.entries.every(e => Math.abs(e.probability - 3 / 5) < 1e-12));
  const learned = generateSelection(papers, {...base, model});
  assert.equal(learned.entries.length, 3);
  assert.equal(new Set(learned.entries.map(e => e.paperId)).size, 3);
  assert.ok(learned.entries.every(e => e.probability === null && e.category === null));
  const all = generateSelection(papers, {...base, model, settings: {personalizedCount: 32}});
  assert.ok(all.entries.every(e => e.probability === 1));
  const large = Array.from({length: 50}, (_, i) => paper(String(i), ['math.CA']));
  assert.equal(generateSelection(large, {...base, settings: {personalizedCount: 200}}).entries.length, 32);
});

test('Discovery favors unseen topics and author labels without interpreting reading as ordinary preference', () => {
  const prior = {...positive, authors: [{name: 'Existing Name'}]};
  const familiar = {...related, authors: [{name: 'Existing Name'}]};
  const novel = {...unrelated, authors: [{name: 'New Name'}]};
  const papers = [familiar, novel];
  const history = {reading: {[prior.id]: date}, knownPapers: {[prior.id]: prior}};
  const discovery = {...options, ...history, mode: 'discovery'};
  let firstSeen = 0;
  for (let seed = 0; seed < 450; seed++) {
    const [entry] = generateSelection(papers, {...discovery, seed}).entries;
    if (entry.paperId === novel.id) firstSeen++;
    assert.match(entry.reason, /author IDs or names were unseen/);
  }
  assert.ok(firstSeen > 300);
  const withoutHistory = generateSelection(papers, {...options, mode: 'discovery'});
  assert.deepEqual(withoutHistory.entries.map(e => [e.paperId, e.probability]), generateSelection(papers, options).entries.map(e => [e.paperId, e.probability]));
  assert.deepEqual(generateSelection(papers, {...options, ...history}), generateSelection(papers, options));
});

test('Subscriptions shows only confirmed matches; optional subscription weighting changes only preference modes', () => {
  const name = 'A. Example';
  const a = {...related, authors: [{name, stableId: 'arxiv:a_1'}]};
  const b = {...unrelated, authors: [{name, stableId: 'arxiv:b_1'}]};
  const c = paper('c', ['math.CA'], {authors: [{name}]});
  const stable = {id: 'a', name, stableId: 'arxiv:a_1'};
  const papers = [a, b, c];
  const subscriptions = [stable];
  const filtered = generateSelection(papers, {...options, mode: 'subscriptions', subscriptions});
  assert.deepEqual(filtered.entries.map(e => [e.paperId, e.probability]), [[a.id, 1]]);
  assert.match(filtered.entries[0].reason, /stable ID/);
  const unconfirmed = generateSelection(papers, {...options, mode: 'subscriptions', subscriptions: [{name, id: 'other'}]});
  assert.equal(unconfirmed.entries.length, 0);
  const identityFree = generateSelection([c], {...options, mode: 'subscriptions', subscriptions: [{name, id: 'other', confirmedNameOnly: true}]});
  assert.match(identityFree.entries[0].reason, /confirmed name-only/);
  const optIn = {settings: {useSubscriptions: true, exploration: 0}, subscriptions};
  const [weighted] = generateSelection(papers, {...options, mode: 'balanced', ...optIn}).entries;
  assert.equal(weighted.probability, weighted.paperId === a.id ? 0.5 : 0.25);
  assert.deepEqual(generateSelection(papers, {...options, ...optIn}), generateSelection(papers, options));
  const [off] = generateSelection(papers, {...options, mode: 'balanced', subscriptions}).entries;
  assert.equal(off.probability, 1 / 3);
  const dashboard = analytics({events: [], settings: {}, papers: Object.fromEntries(papers.map(p => [p.id, p])), subscriptions, reading: {[a.id]: date}});
  assert.deepEqual(dashboard.followedResearchers[0].recent.map(p => p.id), [a.id]);
  assert.equal(dashboard.followedResearchers[0].unread.length, 0);
});

test('replacement retains other papers, reports a genuine single-draw probability, and preserves the source selection', () => {
  const papers = ['a', 'b', 'c'].map(id => paper(id, ['math.PR'])).concat(paper('d', ['math.LO']));
  const original = generateSelection(papers, options);
  const target = original.entries.find(e => e.category === 'math.PR');
  const replacement = replaceSelectionPaper(original, target.paperId, papers, {...options, seed: 'replacement'});
  assert.equal(replacement.entries.length, 2);
  assert.equal(replacement.entries.find(e => e.category === 'math.PR').probability, 0.5);
  assert.ok(!replacement.entries.some(e => e.paperId === target.paperId));
  assert.deepEqual(replacement.entries.find(e => e.paperId === 'd'), original.entries.find(e => e.paperId === 'd'));
  assert.ok(original.entries.some(e => e.paperId === target.paperId));
  assert.equal(replaceSelectionPaper(original, 'd', papers, options), null);
  assert.equal(replaceSelectionPaper(original, 'unknown', papers, options), null);
});

test('single replacement can follow a cross-list augmenting path while keeping other paper IDs and maximum coverage', () => {
  const papers = [paper('old', ['math.AC']), paper('shared', ['math.AC', 'math.AG']), paper('new', ['math.AG']), paper('held', ['math.DG'])];
  const selection = {mode: 'random', date, seed: 4, missing: [], entries: [
    {paperId: 'old', category: 'math.AC', reason: 'Original', probability: null},
    {paperId: 'shared', category: 'math.AG', reason: 'Original', probability: null},
    {paperId: 'held', category: 'math.DG', reason: 'Original', probability: 1},
  ]};
  const newer = replaceSelectionPaper(selection, 'old', papers, {...options, seed: 8});
  assert.deepEqual(newer.entries.map(e => [e.paperId, e.category]), [['new', 'math.AG'], ['shared', 'math.AC'], ['held', 'math.DG']]);
  assert.deepEqual(newer.entries.at(-1), selection.entries.at(-1));
  assert.ok(newer.entries.slice(0, 2).every(e => e.probability === null));
  assert.equal(replaceSelectionPaper(selection, 'old', papers.filter(p => p.id !== 'new'), options), null);
});

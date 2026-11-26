import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, normalizeCategory } from '../src/categories.js';
import { listingUrl } from '../src/parser.js';
import { mergeListingPages } from '../src/network.js';

test('all 32 mathematical subjects retain their canonical codes', () => {
  const expected = 'AC AG AP AT CA CO CT CV DG DS FA GM GN GR GT HO IT KT LO MG MP NA NT OA OC PR QA RA RT SG SP ST'.split(' ').map(s => 'math.' + s);
  assert.deepEqual(Object.keys(CATEGORIES), expected);
  for (const field of expected) assert.equal(normalizeCategory(field.toLowerCase()), field);
  assert.equal(normalizeCategory('cs.IT'), 'math.IT');
  assert.equal(normalizeCategory('cs.NA'), 'math.NA');
  assert.equal(normalizeCategory('math-ph'), 'math.MP');
  assert.equal(normalizeCategory('stat.TH'), 'math.ST');
  assert.equal(normalizeCategory('physics.flu-dyn'), 'physics.flu-dyn');
  assert.equal(normalizeCategory('cond-mat.stat-mech'), 'cond-mat.stat-mech');
  assert.equal(normalizeCategory('cs.LO'), 'cs.LO');
  assert.equal(normalizeCategory('missing.subject'), null);
  assert.equal(normalizeCategory(null), null);
});

test('pagination accepts only numeric controls on the same daily listing', () => {
  const base = 'https://arxiv.org/list/math/new';
  assert.equal(listingUrl('?skip=100&show=50', base), base + '?show=50&skip=100');
  for (const url of ['https://example.invalid/list/math/new?show=25', '/list/math/recent',
    '/list/cs/new?skip=0', '?show=0', '?show=1&show=2', '?skip=-1', '?token=x',
    'https://arxiv.org:3000/list/math/new', 'https://visitor@arxiv.org/list/math/new']) {
    assert.equal(listingUrl(url, base), null);
  }
});

test('an overlap can complete a day only with consistent identifiers, section totals and date', () => {
  const baseUrl = 'https://arxiv.org/list/math/new';
  const paper = { id: '2601.00001', version: 1, section: 'new', title: 'First' };
  const other = { id: '2601.00002', version: 1, section: 'cross', title: 'Second' };
  const first = { baseUrl, announcementDate: '2026-03-02', advertisedTotal: 2, papers: [paper],
    sectionTotals: { new: 1, cross: 1 }, integrityWarnings: [], nextUrls: [baseUrl + '?skip=1'] };
  const second = { ...first, baseUrl: baseUrl + '?skip=1', papers: [paper, other], nextUrls: [] };
  assert.equal(mergeListingPages([first, second]).complete, true);
  assert.equal(mergeListingPages([first, { ...second, papers: [{ ...paper, section: 'cross' }, other] }]).complete, false);
  assert.equal(mergeListingPages([first, { ...second, advertisedTotal: 3 }]).complete, false);
  assert.equal(mergeListingPages([first, { ...second, sectionTotals: { new: 2 } }]).complete, false);
  const changed = mergeListingPages([first, { ...second, announcementDate: '2026-03-03' }]);
  assert.equal(changed.complete, false);
  assert.deepEqual(changed.papers, [paper]);
});

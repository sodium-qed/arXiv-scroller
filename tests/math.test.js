import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mathFragment, mathParts} from '../src/math.js';

// A deliberately small sink for the adapter's three DOM construction calls.
// Browser layout is covered separately. This records exactly what would be inserted.
class Sink {
  constructor(name, namespace = '', text = '') {
    this.name = name;
    this.namespace = namespace;
    this.text = text;
    this.children = [];
    this.attributes = Object.create(null);
    this.style = Object.create(null);
  }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  *walk() { yield this; for (const child of this.children) yield* child.walk(); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
}
const doc = {
  createDocumentFragment:() => new Sink('#fragment'),
  createTextNode:text => new Sink('#text', '', text),
  createElementNS:(ns, name) => new Sink(name, ns)
};

test('the pinned renderer matches the upstream tagged artifact including its exact byte length', () => {
  const bytes = readFileSync(new URL('../vendor/temml.js', import.meta.url));
  const upstream = bytes.subarray(0, bytes.indexOf('\n/*! arXiv Discovery packaging.'));
  assert.equal(upstream.length, 167881);
  assert.equal(createHash('sha256').update(upstream).digest('hex'), '56b4338176d39170692503b8b7ec630d3edf8e10861895658deb74aefb66af9d');
});

test('four delimiters, currency, escaped delimiters and unmatched input preserve source boundaries', () => {
  const text = 'Pay $10 or $20. Study \\(x\\), $y$, $$z$$, and \\[q\\]. Leave \\$5 and $open.';
  const parts = mathParts(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.tex !== undefined).map(part => [part.tex, part.display]),
    [['x', false], ['y', false], ['z', true], ['q', true]]);
});

test('a real TeX renderer emits native fractions, scripts, radicals, sums, matrices and exact annotations', () => {
  const formula = '\\frac{a_2}{\\sqrt{b^3}} + \\sum_{i=0}^n x_i';
  const matrix = '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}';
  const result = mathFragment(doc, 'Before $$' + formula + '$$ and \\(' + matrix + '\\) after.');
  assert.equal(result.children.filter(node => node.name === 'math').length, 2);
  for (const tag of ['math', 'mfrac', 'msub', 'msup', 'msqrt', 'munderover', 'mtable', 'mtr', 'mtd']) {
    const node = [...result.walk()].find(node => node.name === tag);
    assert.ok(node, 'missing ' + tag);
    assert.equal(node.namespace, 'http://www.w3.org/1998/Math/MathML');
  }
  assert.equal(result.children[1].attributes.display, 'block');
  assert.deepEqual([...result.walk()].filter(node => node.name === 'annotation').map(node => node.textContent), [formula, matrix]);
});

test('unsupported or resource-limited formulas fall back to the exact delimited text', () => {
  for (const formula of ['$\\UndefinedCustomMacro{x}$', '\\[\\url{https://example.invalid}\\]',
    '$' + 'x'.repeat(4097) + '$', '$' + 'x+'.repeat(900) + 'x$']) {
    const nodes = mathFragment(doc, formula).children;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].name, '#text');
    assert.equal(nodes[0].text, formula);
  }
  const long = 'x'.repeat(96_001) + '$z$';
  assert.deepEqual(mathParts(long), [{text:long}]);
});

test('ordinary markup-like text stays text and separate formulas do not share custom definitions', () => {
  const input = '<b>source</b> $\\gdef\\uniqueLocalTerm{x}\\uniqueLocalTerm$ then $\\uniqueLocalTerm$.';
  const result = mathFragment(doc, input);
  assert.equal(result.children[0].text, '<b>source</b> ');
  assert.ok(result.children.some(node => node.text === '$\\uniqueLocalTerm$'));
  assert.ok([...result.walk()].every(node => node.name.startsWith('#') || node.namespace === 'http://www.w3.org/1998/Math/MathML'));
});

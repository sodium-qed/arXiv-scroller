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
  const marker = bytes.indexOf('\n/*! arXiv Discovery packaging.');
  const upstream = bytes.subarray(0, bytes[marker - 1] === 13 ? marker - 1 : marker);
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

test('AI explanations recover recognizable bare TeX alongside normal delimited formulas', () => {
  const input = String.raw`In L^{p}(\mathbb{T}), take \Omega\subset\mathbb{C}, solve \Delta f = 0, and write f=h+\overline{g}. Also \(x^2\).`;
  const result = mathFragment(doc, input, {recoverBareTex:true});
  const annotations = [...result.walk()].filter(node => node.name === 'annotation').map(node => node.textContent);
  assert.deepEqual(annotations, [String.raw`L^{p}(\mathbb{T})`, String.raw`\Omega\subset\mathbb{C}`, String.raw`\Delta f = 0`, String.raw`f=h+\overline{g}`, 'x^2']);
  assert.equal(result.children.at(-1).text, '.');
  assert.equal(mathFragment(doc, input).children.filter(node => node.name === 'math').length, 1);
});

test('bare TeX recovery preserves ordinary text, escaped backslashes, and unsupported commands', () => {
  const input = String.raw`Visit C:\Users\reader and \\alpha; keep \UndefinedCustomMacro{x} and <b>text</b>.`;
  const result = mathFragment(doc, input, {recoverBareTex:true});
  assert.equal(result.textContent, input);
  assert.equal(result.children.filter(node => node.name === 'math').length, 0);
});

test('recovers a bare mapping with an integral and TeX spacing as one formula', () => {
  const formula = String.raw`t\mapsto\int_{0}^{t}f^{2}(s)\mathop{}\!ds`;
  const result = mathFragment(doc, 'Rescale by ' + formula + '. End.', {recoverBareTex:true});
  const annotations = [...result.walk()].filter(node => node.name === 'annotation').map(node => node.textContent);
  assert.deepEqual(annotations, [formula]);
  assert.equal(result.children.at(-1).text, '. End.');
});

test('AI explanations render compact undelimited scripted notation without swallowing prose', () => {
  const input = String.raw`Take q_{i}, components B_{j,k}, |M(G)|_{j,k}, and |M|=(MM^{*})^{1/2}. Already \(z_{r}\). Keep snake_case and identifier_{text}.`;
  const result = mathFragment(doc, input, {recoverBareTex:true});
  const annotations = [...result.walk()].filter(node => node.name === 'annotation').map(node => node.textContent);
  assert.deepEqual(annotations, [String.raw`q_{i}`, String.raw`B_{j,k}`, String.raw`|M(G)|_{j,k}`, String.raw`|M|=(MM^{*})^{1/2}`, String.raw`z_{r}`]);
  assert.equal(result.children.at(-1).text, '. Keep snake_case and identifier_{text}.');
  assert.equal(mathFragment(doc, input).children.filter(node => node.name === 'math').length, 1);
});

test('recovers a bare equation with derivatives, Greek letters and sized brackets', () => {
  const formula = String.raw`\ddot{q}(s)=α\bigl[q(s)-q(-s)\bigr]+β\bigl[\dot{q}(s)-\dot{q}(-s)\bigr]`;
  const result = mathFragment(doc, 'Consider ' + formula + '. Done.', {recoverBareTex:true});
  const annotations = [...result.walk()].filter(node => node.name === 'annotation').map(node => node.textContent);
  assert.deepEqual(annotations, [formula]);
  assert.equal(result.children.at(-1).text, '. Done.');
});

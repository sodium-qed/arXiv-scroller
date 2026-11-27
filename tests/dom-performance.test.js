import test from 'node:test';
import assert from 'node:assert/strict';
import {applyShadowStyles, STYLES} from '../src/dom.js';
import {DiscoveryApp} from '../src/app.js';

test('large listings reuse one stylesheet, with a safe fallback when unavailable', () => {
  let constructed = 0;
  class Sheet {
    constructor() { constructed++; }
    replaceSync(css) { this.css = css; }
  }
  const doc = {defaultView:{CSSStyleSheet:Sheet}, createElement:tag => ({tagName:tag})};
  const roots = Array.from({length:1000}, () => ({ownerDocument:doc, adoptedStyleSheets:[], append() { throw Error('unexpected fallback'); }}));
  for (const root of roots) applyShadowStyles(root);
  assert.equal(constructed, 1);
  assert.ok(roots.every(root => root.adoptedStyleSheets[0] === roots[0].adoptedStyleSheets[0]));
  assert.equal(roots[0].adoptedStyleSheets[0].css, STYLES);

  const fallbackDoc = {defaultView:{}, createElement:tag => ({tagName:tag})};
  const fallback = {ownerDocument:fallbackDoc, children:[], append(node) { this.children.push(node); }};
  applyShadowStyles(fallback);
  assert.equal(fallback.children[0].tagName, 'style');
  assert.equal(fallback.children[0].textContent, STYLES);
});

test('paper menus create their controls only on first opening', () => {
  const oldDocument = globalThis.document, oldNode = globalThis.Node;
  class MockNode {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.open = false; }
    append(node) { this.children.push(node); }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    querySelector(selector) { return selector === '.more-actions' ? this.children.find(child => child.className === 'more-actions') : null; }
  }
  globalThis.Node = MockNode;
  globalThis.document = {createElement:tag => new MockNode(tag), createTextNode:text => Object.assign(new MockNode('#text'), {text})};
  try {
    let buttons = 0;
    const context = {button(label) { buttons++; return Object.assign(new MockNode('button'), {label}); }};
    const details = DiscoveryApp.prototype.moreTools.call(context);
    assert.equal(buttons, 0);
    assert.equal(details.children.length, 1);
    details.open = true;
    details.listeners.toggle();
    assert.equal(buttons, 11);
    assert.equal(details.querySelector('.more-actions').children.length, 11);
    details.listeners.toggle();
    assert.equal(buttons, 11);
  } finally {
    globalThis.document = oldDocument;
    globalThis.Node = oldNode;
  }
});

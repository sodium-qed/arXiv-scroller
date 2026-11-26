import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeListing} from '../src/native-list.js';

function node(parentElement, position, attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  return {
    parentElement, position, attrs, isConnected: true, layoutVisible: true,
    hasAttribute: name => attrs.has(name),
    getAttribute: name => attrs.has(name) ? attrs.get(name) : null,
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name),
    closest(selector) {
      assert.equal(selector, '[hidden]');
      return attrs.has('hidden') ? this : parentElement?.closest(selector) || null;
    },
    checkVisibility() { return this.layoutVisible; },
    compareDocumentPosition(other) {
      if (this.position === other.position) return 0;
      return this.position < other.position ? 4 : 2;
    }
  };
}

function pair(parent, position, headerAttrs, bodyAttrs) {
  const dt = node(parent, position * 2, headerAttrs);
  const dd = node(parent, position * 2 + 1, bodyAttrs);
  dt.nextElementSibling = dd;
  return {dt, dd};
}

test('native filtering preserves node identity, individual hidden values and all original attributes', () => {
  const list = node(null, 0);
  const a = pair(list, 1, {id:'item1'}, {lang:'en'});
  const b = pair(list, 2, {hidden:'until-found', id:'item2'}, {});
  const c = pair(list, 3, {}, {hidden:'native-value'});
  const rows = new Map([['a', a], ['b', b], ['c', c]]);
  const before = [...rows.values()].flatMap(({dt, dd}) => [[...dt.attrs], [...dd.attrs]]);
  const filter = new NativeListing(rows);
  filter.apply(new Set(['a']));
  assert.deepEqual(filter.visibleIds(), ['a']);
  assert.equal(b.dt.getAttribute('hidden'), 'until-found');
  assert.equal(c.dd.getAttribute('hidden'), 'native-value');
  filter.apply(['b']);
  assert.equal(a.dt.getAttribute('hidden'), '');
  assert.equal(a.dd.getAttribute('hidden'), '');
  assert.equal(b.dd.hasAttribute('hidden'), false);
  assert.deepEqual(filter.visibleIds(), []);
  filter.restore();
  filter.restore();
  assert.equal(filter.applied, false);
  assert.deepEqual([...rows.values()].flatMap(({dt, dd}) => [[...dt.attrs], [...dd.attrs]]), before);
  assert.equal(a.dt.parentElement, list);
  assert.equal(a.dt.nextElementSibling, a.dd);
});

test('a missing, disconnected or newly unpaired selection has no effect on the active native view', () => {
  const list = node(null, 0);
  const a = pair(list, 1), b = pair(list, 2);
  const filter = new NativeListing(new Map([['a', a], ['b', b]]));
  filter.apply(['a']);
  assert.throws(() => filter.apply(['b', 'absent']), /missing/);
  assert.throws(() => filter.apply(null), /required/);
  assert.deepEqual(filter.visibleIds(), ['a']);
  b.dd.isConnected = false;
  assert.throws(() => filter.apply(['b']), /missing/);
  b.dd.isConnected = true;
  b.dt.nextElementSibling = null;
  assert.throws(() => filter.apply(['b']), /missing/);
  assert.deepEqual(filter.visibleIds(), ['a']);
  assert.equal(b.dt.getAttribute('hidden'), '');
  filter.restore();
  assert.equal(b.dt.hasAttribute('hidden'), false);
});

test('navigation uses current native order and excludes hidden ancestors and CSS-hidden rows', () => {
  const firstList = node(null, 0), secondList = node(null, 1);
  const a = pair(firstList, 1), b = pair(secondList, 2), c = pair(secondList, 3);
  const filter = new NativeListing(new Map([['c', c], ['a', a], ['b', b]]));
  assert.deepEqual(filter.visibleIds(), ['a', 'b', 'c']);
  a.dt.position = 20;
  assert.deepEqual(filter.visibleIds(), ['b', 'c', 'a']);
  b.dd.layoutVisible = false;
  assert.deepEqual(filter.visibleIds(), ['c', 'a']);
  secondList.setAttribute('hidden', 'until-found');
  assert.deepEqual(filter.visibleIds(), ['a']);
});

test('an empty selection is valid and restore respects visibility changes made by the host page', () => {
  const list = node(null, 0);
  const a = pair(list, 1), b = pair(list, 2);
  const filter = new NativeListing(new Map([['a', a], ['b', b]]));
  filter.apply([]);
  assert.equal(filter.applied, true);
  assert.deepEqual(filter.visibleIds(), []);
  a.dt.setAttribute('hidden', 'until-found');
  b.dt.removeAttribute('hidden');
  filter.apply(['b']);
  a.dt.setAttribute('hidden', '');
  filter.restore();
  assert.equal(a.dt.getAttribute('hidden'), '');
  assert.equal(a.dd.hasAttribute('hidden'), false);
  assert.deepEqual(filter.visibleIds(), ['b']);
});

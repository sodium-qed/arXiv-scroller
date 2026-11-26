import test from 'node:test';
import assert from 'node:assert/strict';
import {backoffUntil,gmRequest} from '../src/transport.js';

test('arXiv Retry-After seconds and dates are honored with a conservative fallback',()=>{
  const now=Date.parse('2026-11-26T12:00:00Z');
  assert.equal(backoffUntil('Retry-After: 120\r\nX-Test: 1',now),now+120000);
  assert.equal(backoffUntil('retry-after: Thu, 26 Nov 2026 12:05:00 GMT',now),now+300000);
  assert.equal(backoffUntil('Retry-After: invalid',now),now+60000);
  assert.equal(backoffUntil('Retry-After: 0',now),now+15000);
});
test('transport rejects arbitrary hosts, embedded credentials, and unpaired loopback endpoints',async()=>{
  await assert.rejects(gmRequest('https://evil.example/source'),/outside/);
  await assert.rejects(gmRequest('https://name:secret@arxiv.org/list/math/new'),/outside/);
  await assert.rejects(gmRequest('http://127.0.0.1:4317/private'),/Only the paired/);
  await assert.rejects(gmRequest('http://127.0.0.1:4317/v1/explain'),/Only the paired/);
});

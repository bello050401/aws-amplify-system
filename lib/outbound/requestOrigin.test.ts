import assert from 'node:assert/strict';
import test from 'node:test';
import {isOutboundRequestOriginAllowed} from './requestOrigin';

const publicOrigin = 'https://bello.example';
const request = (origin?: string, url = 'https://internal.example/api/inventory/outbound') =>
  new Request(url, {headers: origin ? {origin} : {}});

test('accepts the configured public origin when Amplify uses an internal URL', () => {
  assert.equal(isOutboundRequestOriginAllowed(request(publicOrigin), publicOrigin), true);
});
test('rejects other, missing, null and internal origins under public configuration', () => {
  for (const origin of ['https://other.example', undefined, 'null', 'https://internal.example', publicOrigin + '.attacker.example']) {
    assert.equal(isOutboundRequestOriginAllowed(request(origin), publicOrigin), false);
  }
});
test('local preview uses its own origin when no public origin is configured', () => {
  assert.equal(isOutboundRequestOriginAllowed(request('http://localhost:8126', 'http://localhost:8126/api/inventory/outbound'), ''), true);
  assert.equal(isOutboundRequestOriginAllowed(request(publicOrigin, 'http://localhost:8126/api/inventory/outbound'), ''), false);
});
test('invalid configured origins fail closed', () => {
  for (const invalid of ['invalid', 'null', 'file:///tmp', 'https://bello.example/path', 'https://user@bello.example']) {
    assert.equal(isOutboundRequestOriginAllowed(request(publicOrigin), invalid), false);
  }
});

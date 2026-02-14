// test/capture/body-variables.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectBodyVariables, substituteBodyVariables } from '../../src/capture/body-variables.js';

describe('detectBodyVariables', () => {
  it('detects numeric IDs in JSON body', () => {
    const body = { userId: 12345, action: 'update', count: 1 };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('userId'));
    assert.ok(vars.includes('count'));
  });

  it('detects UUIDs in JSON body', () => {
    const body = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'test' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('id'));
  });

  it('detects cursor-like strings', () => {
    const body = { cursor: 'eyJsYXN0X2lkIjoxMjM0NX0=', label: 'posts' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('cursor'));
    assert.ok(!vars.includes('label')); // Short static string
  });

  it('handles nested objects', () => {
    const body = { input: { userId: 123, data: { itemId: 456 } } };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('input.userId'));
    assert.ok(vars.includes('input.data.itemId'));
  });

  it('returns empty array for non-object body', () => {
    assert.deepEqual(detectBodyVariables('string body'), []);
    assert.deepEqual(detectBodyVariables(null), []);
  });
});

describe('detectBodyVariables — name-based (Strategy 2)', () => {
  it('flags timestamp-related keys', () => {
    const body = { createdAt: 'some-value', name: 'Alice' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('createdAt'));
    assert.ok(!vars.includes('name'));
  });

  it('flags pagination keys', () => {
    const body = { cursor: 'opaque-string', query: 'posts' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('cursor'));
  });

  it('flags identity keys', () => {
    const body = { requestId: 'some-val', data: 'payload' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('requestId'));
  });

  it('flags session/CSRF keys', () => {
    const body = { csrf: 'token123', action: 'submit' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('csrf'));
  });

  it('handles snake_case key patterns', () => {
    const body = { created_at: '2026-01-01', session_id: 'abc', label: 'test' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('created_at'));
    assert.ok(vars.includes('session_id'));
    assert.ok(!vars.includes('label'));
  });

  it('does not flag unrelated keys', () => {
    const body = { username: 'alice', email: 'alice@example.com', bio: 'hello' };
    const vars = detectBodyVariables(body);
    assert.ok(!vars.includes('username'));
    assert.ok(!vars.includes('bio'));
  });

  it('flags nested dynamic keys', () => {
    const body = { data: { page_number: 1, color: 'recent' } };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('data.page_number'));
    assert.ok(!vars.includes('data.color'));
  });

  it('flags geolocation keys', () => {
    const body = { geocode: '47.61,-122.33', language: 'en-US' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('geocode'));
  });

  it('flags latitude/longitude keys', () => {
    const body = { lat: 47.61, lng: -122.33, label: 'Seattle' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('lat'));
    assert.ok(vars.includes('lng'));
    assert.ok(!vars.includes('label'));
  });

  it('flags coordinate and zip keys', () => {
    const body = { coords: '47.61,-122.33', zip: '98101' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('coords'));
    assert.ok(vars.includes('zip'));
  });

  it('flags search/query keys', () => {
    const body = { query: 'weather seattle', format: 'json' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('query'));
    assert.ok(!vars.includes('format'));
  });

  it('flags keyword and filter keys', () => {
    const body = { keyword: 'react', filter: 'recent', mode: 'list' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('keyword'));
    assert.ok(vars.includes('filter'));
    assert.ok(!vars.includes('mode'));
  });

  it('flags nested geolocation keys (weather.com pattern)', () => {
    const body = { '0': { name: 'getSunV3', params: { geocode: '47.61,-122.33', language: 'en-US' } } };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('0.params.geocode'));
  });
});

describe('detectBodyVariables — pattern-based (Strategy 3)', () => {
  it('detects ISO 8601 datetime strings', () => {
    const body = { ts: '2026-02-07T18:15:00Z', label: 'test' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('ts'));
    assert.ok(!vars.includes('label'));
  });

  it('detects ISO 8601 date-only strings', () => {
    const body = { day: '2026-02-07', color: 'blue' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('day'));
    assert.ok(!vars.includes('color'));
  });

  it('detects Unix epoch seconds (number)', () => {
    const body = { ts: 1738944900, count: 5 };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('ts'));
  });

  it('detects Unix epoch milliseconds (number)', () => {
    const body = { ts: 1738944900000, count: 5 };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('ts'));
  });

  it('does not flag small numbers as epochs', () => {
    // Small numbers are still flagged as numeric IDs (existing behavior)
    // but NOT as timestamps
    const body = { status: 200 };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('status')); // flagged as numeric, not as timestamp
  });

  it('detects prefixed IDs', () => {
    const body = { rid: 'req_abc123def456', name: 'test' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('rid'));
    assert.ok(!vars.includes('name'));
  });

  it('detects txn/msg/evt prefixed IDs', () => {
    const body = { transaction: 'txn_xyz789', event: 'evt_abc123' };
    const vars = detectBodyVariables(body);
    assert.ok(vars.includes('transaction'));
    assert.ok(vars.includes('event'));
  });
});

describe('substituteBodyVariables', () => {
  it('substitutes values at simple paths', () => {
    const template = { userId: 123, action: 'update' };
    const result = substituteBodyVariables(template, { userId: '999' });
    assert.deepEqual(result, { userId: '999', action: 'update' });
  });

  it('substitutes values at nested paths', () => {
    const template = { input: { userId: 123, name: 'test' } };
    const result = substituteBodyVariables(template, { 'input.userId': '999' });
    assert.deepEqual(result, { input: { userId: '999', name: 'test' } });
  });

  it('preserves unsubstituted fields', () => {
    const template = { a: 1, b: 2, c: 3 };
    const result = substituteBodyVariables(template, { a: '10' });
    assert.deepEqual(result, { a: '10', b: 2, c: 3 });
  });

  it('handles string templates with :param placeholders', () => {
    const template = 'id=:id&name=:name';
    const result = substituteBodyVariables(template, { id: '123', name: 'test' });
    assert.equal(result, 'id=123&name=test');
  });
});

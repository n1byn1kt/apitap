// test/capture/body-diff.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffBodies } from '../../src/capture/body-diff.js';

describe('diffBodies', () => {
  it('returns empty for single body', () => {
    assert.deepEqual(diffBodies(['{"a":1}']), []);
  });

  it('returns empty for empty array', () => {
    assert.deepEqual(diffBodies([]), []);
  });

  it('detects changed top-level fields', () => {
    const a = JSON.stringify({ cursor: 'abc123', query: 'posts', limit: 10 });
    const b = JSON.stringify({ cursor: 'def456', query: 'posts', limit: 10 });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('cursor'));
    assert.ok(!result.includes('query'));
    assert.ok(!result.includes('limit'));
  });

  it('detects changed nested fields with dot paths', () => {
    const a = JSON.stringify({ data: { pagination: { cursor: 'abc' }, filter: 'recent' } });
    const b = JSON.stringify({ data: { pagination: { cursor: 'xyz' }, filter: 'recent' } });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('data.pagination.cursor'));
    assert.ok(!result.includes('data.filter'));
  });

  it('detects multiple changed fields', () => {
    const a = JSON.stringify({ timestamp: 1000, requestId: 'r1', apiKey: 'same' });
    const b = JSON.stringify({ timestamp: 2000, requestId: 'r2', apiKey: 'same' });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('timestamp'));
    assert.ok(result.includes('requestId'));
    assert.ok(!result.includes('apiKey'));
  });

  it('handles three or more bodies', () => {
    const a = JSON.stringify({ cursor: 'a', page: 1, query: 'test' });
    const b = JSON.stringify({ cursor: 'b', page: 2, query: 'test' });
    const c = JSON.stringify({ cursor: 'c', page: 3, query: 'test' });
    const result = diffBodies([a, b, c]);
    assert.ok(result.includes('cursor'));
    assert.ok(result.includes('page'));
    assert.ok(!result.includes('query'));
  });

  it('marks array as dynamic when lengths differ', () => {
    const a = JSON.stringify({ items: [1, 2], query: 'test' });
    const b = JSON.stringify({ items: [1, 2, 3], query: 'test' });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('items'));
    assert.ok(!result.includes('query'));
  });

  it('diffs array elements when same length', () => {
    const a = JSON.stringify({ ids: [100, 200] });
    const b = JSON.stringify({ ids: [100, 300] });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('ids[1]'));
    assert.ok(!result.includes('ids[0]'));
  });

  it('detects keys present in only one body', () => {
    const a = JSON.stringify({ cursor: 'abc', extra: true });
    const b = JSON.stringify({ cursor: 'def' });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('cursor'));
    assert.ok(result.includes('extra'));
  });

  it('handles form-encoded bodies', () => {
    const a = 'cursor=abc123&query=posts&limit=10';
    const b = 'cursor=def456&query=posts&limit=10';
    const result = diffBodies([a, b]);
    assert.ok(result.includes('cursor'));
    assert.ok(!result.includes('query'));
    assert.ok(!result.includes('limit'));
  });

  it('handles form-encoded with URL encoding', () => {
    const a = 'token=abc+123&name=hello+world';
    const b = 'token=def+456&name=hello+world';
    const result = diffBodies([a, b]);
    assert.ok(result.includes('token'));
    assert.ok(!result.includes('name'));
  });

  it('returns empty for identical bodies', () => {
    const body = JSON.stringify({ a: 1, b: 'hello' });
    assert.deepEqual(diffBodies([body, body]), []);
  });

  it('handles deeply nested changes', () => {
    const a = JSON.stringify({ a: { b: { c: { d: 'old' } } } });
    const b = JSON.stringify({ a: { b: { c: { d: 'new' } } } });
    const result = diffBodies([a, b]);
    assert.deepEqual(result, ['a.b.c.d']);
  });

  it('handles type changes at same path', () => {
    const a = JSON.stringify({ val: 'string' });
    const b = JSON.stringify({ val: 123 });
    const result = diffBodies([a, b]);
    assert.ok(result.includes('val'));
  });

  it('returns sorted paths', () => {
    const a = JSON.stringify({ z: 1, a: 2, m: 3 });
    const b = JSON.stringify({ z: 9, a: 8, m: 7 });
    const result = diffBodies([a, b]);
    assert.deepEqual(result, ['a', 'm', 'z']);
  });
});

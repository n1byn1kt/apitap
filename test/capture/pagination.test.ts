// test/capture/pagination.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPagination } from '../../src/capture/pagination.js';

describe('detectPagination', () => {
  it('detects offset/limit pagination', () => {
    const result = detectPagination({
      offset: { type: 'string', example: '0' },
      limit: { type: 'string', example: '20' },
    });
    assert.deepEqual(result, { type: 'offset', paramName: 'offset', limitParam: 'limit' });
  });

  it('detects skip/limit pagination', () => {
    const result = detectPagination({
      skip: { type: 'string', example: '0' },
      limit: { type: 'string', example: '10' },
    });
    assert.deepEqual(result, { type: 'offset', paramName: 'skip', limitParam: 'limit' });
  });

  it('detects cursor-based pagination', () => {
    const result = detectPagination({
      cursor: { type: 'string', example: 'abc123' },
    });
    assert.deepEqual(result, { type: 'cursor', paramName: 'cursor' });
  });

  it('detects after/before cursor pagination', () => {
    const result = detectPagination({
      after: { type: 'string', example: 'xyz789' },
    });
    assert.deepEqual(result, { type: 'cursor', paramName: 'after' });
  });

  it('detects next_cursor pagination', () => {
    const result = detectPagination({
      next_cursor: { type: 'string', example: 'token_abc' },
    });
    assert.deepEqual(result, { type: 'cursor', paramName: 'next_cursor' });
  });

  it('detects page-based pagination', () => {
    const result = detectPagination({
      page: { type: 'string', example: '1' },
    });
    assert.deepEqual(result, { type: 'page', paramName: 'page' });
  });

  it('detects page with per_page limit', () => {
    const result = detectPagination({
      page: { type: 'string', example: '2' },
      per_page: { type: 'string', example: '25' },
    });
    assert.deepEqual(result, { type: 'page', paramName: 'page', limitParam: 'per_page' });
  });

  it('returns null when no pagination detected', () => {
    const result = detectPagination({
      q: { type: 'string', example: 'bitcoin' },
      sort: { type: 'string', example: 'desc' },
    });
    assert.equal(result, null);
  });

  it('returns null for empty query params', () => {
    assert.equal(detectPagination({}), null);
  });
});

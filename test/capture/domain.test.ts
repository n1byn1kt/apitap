// test/capture/domain.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDomainMatch } from '../../src/capture/domain.js';

describe('isDomainMatch', () => {
  it('matches exact domain', () => {
    assert.equal(isDomainMatch('example.com', 'example.com'), true);
    assert.equal(isDomainMatch('api.example.com', 'api.example.com'), true);
  });

  it('matches subdomains of target', () => {
    assert.equal(isDomainMatch('api.example.com', 'example.com'), true);
    assert.equal(isDomainMatch('v2.api.example.com', 'example.com'), true);
  });

  it('does NOT match unrelated domains with same suffix', () => {
    assert.equal(isDomainMatch('evil-example.com', 'example.com'), false);
    assert.equal(isDomainMatch('notexample.com', 'example.com'), false);
  });

  it('does NOT match parent domains', () => {
    assert.equal(isDomainMatch('example.com', 'api.example.com'), false);
  });

  it('handles domains with many subdomains', () => {
    assert.equal(isDomainMatch('a.b.c.example.com', 'example.com'), true);
    assert.equal(isDomainMatch('a.b.c.example.com', 'c.example.com'), true);
    assert.equal(isDomainMatch('a.b.c.example.com', 'b.c.example.com'), true);
  });

  it('extracts target domain from URL', () => {
    assert.equal(isDomainMatch('api.example.com', 'https://example.com/path'), true);
    assert.equal(isDomainMatch('api.example.com', 'https://www.example.com'), true);
  });
});

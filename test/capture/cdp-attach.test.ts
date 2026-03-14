// test/capture/cdp-attach.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesDomainGlob, parseDomainPatterns } from '../../src/capture/cdp-attach.js';

describe('matchesDomainGlob', () => {
  it('matches exact domain', () => {
    assert.equal(matchesDomainGlob('api.github.com', ['api.github.com']), true);
  });

  it('rejects non-matching exact domain', () => {
    assert.equal(matchesDomainGlob('api.stripe.com', ['api.github.com']), false);
  });

  it('*.domain matches subdomains', () => {
    assert.equal(matchesDomainGlob('api.github.com', ['*.github.com']), true);
    assert.equal(matchesDomainGlob('raw.github.com', ['*.github.com']), true);
  });

  it('*.domain matches bare domain (zero or more subdomains)', () => {
    assert.equal(matchesDomainGlob('github.com', ['*.github.com']), true);
  });

  it('*.domain does NOT match unrelated domain with same suffix', () => {
    assert.equal(matchesDomainGlob('notgithub.com', ['*.github.com']), false);
  });

  it('matches any pattern in a list', () => {
    assert.equal(matchesDomainGlob('api.stripe.com', ['*.github.com', '*.stripe.com']), true);
  });

  it('returns true when pattern list is empty (no filter)', () => {
    assert.equal(matchesDomainGlob('anything.com', []), true);
  });
});

describe('parseDomainPatterns', () => {
  it('splits comma-separated patterns', () => {
    assert.deepEqual(parseDomainPatterns('*.github.com,api.stripe.com'), ['*.github.com', 'api.stripe.com']);
  });

  it('trims whitespace', () => {
    assert.deepEqual(parseDomainPatterns(' *.github.com , api.stripe.com '), ['*.github.com', 'api.stripe.com']);
  });

  it('returns empty array for undefined', () => {
    assert.deepEqual(parseDomainPatterns(undefined), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseDomainPatterns(''), []);
  });
});

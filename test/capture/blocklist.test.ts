// test/capture/blocklist.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBlocklisted } from '../../src/capture/blocklist.js';

describe('isBlocklisted', () => {
  it('blocks known analytics domains', () => {
    assert.equal(isBlocklisted('google-analytics.com'), true);
    assert.equal(isBlocklisted('www.google-analytics.com'), true);
    assert.equal(isBlocklisted('googletagmanager.com'), true);
  });

  it('blocks subdomains of blocklisted domains', () => {
    assert.equal(isBlocklisted('api.segment.io'), true);
    assert.equal(isBlocklisted('us.i.posthog.com'), true);
    assert.equal(isBlocklisted('o123.ingest.sentry.io'), true);
  });

  it('allows non-blocklisted domains', () => {
    assert.equal(isBlocklisted('polymarket.com'), false);
    assert.equal(isBlocklisted('api.github.com'), false);
    assert.equal(isBlocklisted('example.com'), false);
  });

  it('does not block TLDs that happen to match', () => {
    // "io" alone should not be blocked just because "sentry.io" is
    assert.equal(isBlocklisted('io'), false);
    assert.equal(isBlocklisted('com'), false);
  });
});

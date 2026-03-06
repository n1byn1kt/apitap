// test/read/decoders/reddit-third-party.test.ts
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { redditDecoder } from '../../../src/read/decoders/reddit.js';

describe('Reddit decoder third-party disclosure', () => {
  const originalThirdParty = process.env.APITAP_THIRD_PARTY;

  afterEach(() => {
    if (originalThirdParty === undefined) {
      delete process.env.APITAP_THIRD_PARTY;
    } else {
      process.env.APITAP_THIRD_PARTY = originalThirdParty;
    }
  });

  it('does not call pullpush.io by default (opt-in, not opt-out)', async () => {
    delete process.env.APITAP_THIRD_PARTY;

    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      fetchedUrls.push(url);
      return originalFetch(input, init);
    };

    try {
      // This will fail because Reddit's API isn't available in tests,
      // but we can verify no pullpush.io calls were made
      await redditDecoder.decode('https://www.reddit.com/r/test/comments/abc123/test_post/');
    } catch {
      // Expected — no real Reddit API in tests
    } finally {
      globalThis.fetch = originalFetch;
    }

    const pullpushCalls = fetchedUrls.filter(u => u.includes('pullpush.io'));
    assert.equal(pullpushCalls.length, 0, 'Should not call pullpush.io unless APITAP_THIRD_PARTY=1');
  });
});

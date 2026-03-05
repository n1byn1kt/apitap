// test/read/decoders/reddit-third-party.test.ts
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { redditDecoder } from '../../../src/read/decoders/reddit.js';

describe('Reddit decoder third-party disclosure', () => {
  const originalEnv = process.env.APITAP_NO_THIRD_PARTY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.APITAP_NO_THIRD_PARTY;
    } else {
      process.env.APITAP_NO_THIRD_PARTY = originalEnv;
    }
  });

  it('does not call pullpush.io when APITAP_NO_THIRD_PARTY=1', async () => {
    process.env.APITAP_NO_THIRD_PARTY = '1';

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
    assert.equal(pullpushCalls.length, 0, 'Should not call pullpush.io when APITAP_NO_THIRD_PARTY=1');
  });
});

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('F5: Replay fetch timeout', () => {
  it('passes AbortSignal.timeout to fetch', async () => {
    // Track fetch calls
    const fetchCalls: any[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url: url.toString(), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      // Dynamically import to use our mocked fetch
      // We need to construct the call manually since the module caches
      const { replayEndpoint } = await import('../../src/replay/engine.js');

      const skill = {
        version: '1.1' as const,
        domain: 'api.example.com',
        baseUrl: 'https://api.example.com',
        capturedAt: '2026-02-04T12:00:00.000Z',
        endpoints: [{
          id: 'get-data',
          method: 'GET',
          path: '/data',
          queryParams: {},
          headers: {},
          responseShape: { type: 'object' },
          examples: { request: { url: 'https://api.example.com/data', headers: {} }, responsePreview: null },
        }],
        metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
        provenance: 'unsigned' as const,
      };

      await replayEndpoint(skill as any, 'get-data', { _skipSsrfCheck: true });

      assert.ok(fetchCalls.length > 0, 'fetch should have been called');
      const lastCall = fetchCalls[fetchCalls.length - 1];
      assert.ok(lastCall.init.signal, 'fetch should have signal option');
      assert.ok(lastCall.init.signal instanceof AbortSignal, 'signal should be an AbortSignal');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

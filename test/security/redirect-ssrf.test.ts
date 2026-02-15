import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(baseUrl: string): SkillFile {
  return {
    version: '1.1',
    domain: new URL(baseUrl).hostname,
    baseUrl,
    capturedAt: '2026-02-14T12:00:00.000Z',
    endpoints: [{
      id: 'get-data',
      method: 'GET',
      path: '/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: `${baseUrl}/data`, headers: {} }, responsePreview: null },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'unsigned',
  } as SkillFile;
}

describe('F12: Redirect SSRF validation', () => {
  it('blocks redirect to private IP', async () => {
    const skill = makeSkill('http://93.184.216.34');  // Public IP

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      // First request returns redirect
      return new Response(null, {
        status: 302,
        headers: { 'location': 'http://192.168.1.1/internal' },
      });
    }) as any;

    try {
      await assert.rejects(
        () => replayEndpoint(skill, 'get-data'),
        /Redirect blocked \(SSRF\)/,
        'Should block redirect to private IP'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks redirect to AWS metadata endpoint', async () => {
    const skill = makeSkill('http://93.184.216.34');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      return new Response(null, {
        status: 301,
        headers: { 'location': 'http://169.254.169.254/latest/meta-data' },
      });
    }) as any;

    try {
      await assert.rejects(
        () => replayEndpoint(skill, 'get-data'),
        /Redirect blocked \(SSRF\)/,
        'Should block redirect to cloud metadata'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('follows redirect to valid public URL', async () => {
    const skill = makeSkill('http://93.184.216.34');
    let fetchCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCount++;
      if (fetchCount === 1) {
        // First request returns redirect
        return new Response(null, {
          status: 302,
          headers: { 'location': 'http://93.184.216.35/redirected' },
        });
      } else {
        // Second request (after redirect) returns data
        return new Response(JSON.stringify({ redirected: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }) as any;

    try {
      const result = await replayEndpoint(skill, 'get-data');
      assert.equal(result.status, 200, 'Should follow valid redirect');
      assert.deepEqual(result.data, { redirected: true }, 'Should return redirected data');
      assert.equal(fetchCount, 2, 'Should make exactly 2 fetch calls');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops after 1 hop (prevents redirect chains)', async () => {
    const skill = makeSkill('http://93.184.216.34');
    let fetchCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCount++;
      if (fetchCount === 1) {
        // First request returns redirect
        return new Response(null, {
          status: 302,
          headers: { 'location': 'http://93.184.216.35/hop1' },
        });
      } else if (fetchCount === 2) {
        // Second request also returns redirect (chain attempt)
        return new Response(null, {
          status: 302,
          headers: { 'location': 'http://93.184.216.36/hop2' },
        });
      } else {
        // Should never reach here
        return new Response(JSON.stringify({ hop: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }) as any;

    try {
      const result = await replayEndpoint(skill, 'get-data');
      assert.equal(fetchCount, 2, 'Should stop after 1 redirect hop');
      assert.equal(result.status, 302, 'Should return redirect status when chain stopped');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

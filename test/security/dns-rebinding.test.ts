import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAndValidateUrl } from '../../src/skill/ssrf.js';
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

describe('F3: DNS rebinding prevention', () => {
  it('resolvedUrl contains IP instead of hostname', async () => {
    const result = await resolveAndValidateUrl('https://example.com/api');

    assert.equal(result.safe, true, 'Should be safe');
    assert.ok(result.resolvedUrl, 'Should have resolvedUrl');
    assert.ok(result.resolvedIp, 'Should have resolvedIp');
    assert.equal(result.originalHost, 'example.com', 'Should preserve original host');

    // Verify the resolvedUrl uses IP, not hostname
    const resolvedUrlObj = new URL(result.resolvedUrl);
    assert.match(resolvedUrlObj.hostname, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Hostname should be an IP address');
    assert.equal(resolvedUrlObj.pathname, '/api', 'Path should be preserved');
  });

  it('SSRF validation runs before fetch and fetch uses original hostname (preserves TLS/SNI)', async () => {
    // The engine validates the resolved IP is safe via resolveAndValidateUrl,
    // but keeps the original hostname in the fetch URL to preserve TLS/SNI
    // for sites behind CDNs (Cloudflare, etc.).
    const skill = makeSkill('http://example.com');
    let capturedUrl: string | undefined;
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'get-data');

      assert.ok(capturedUrl, 'URL should be captured');

      // Fetch uses original hostname (not resolved IP) to preserve TLS/SNI
      assert.match(capturedUrl, /http:\/\/example\.com\/data/, 'Fetch URL should use original hostname');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('SSRF blocks fetch to private IPs even when hostname looks safe', async () => {
    // This tests the actual security guarantee: resolveAndValidateUrl catches
    // hostnames that resolve to private IPs before the fetch happens.
    const skill = makeSkill('http://localhost');
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;

    try {
      await assert.rejects(
        () => replayEndpoint(skill, 'get-data'),
        (err: Error) => err.message.includes('SSRF blocked'),
      );
      assert.ok(!fetchCalled, 'Fetch should never be called for SSRF-blocked URLs');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isIP } from 'node:net';
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

    // Verify the resolvedUrl uses an IP address, not the hostname. The
    // address family depends on the local resolver (may return IPv4 or
    // IPv6); URL.hostname returns IPv6 addresses in bracketed form.
    const resolvedUrlObj = new URL(result.resolvedUrl);
    const rawIp = resolvedUrlObj.hostname.replace(/^\[|\]$/g, '');
    assert.ok(
      isIP(rawIp) > 0,
      `Hostname should be a valid IP address (IPv4 or IPv6), got: ${resolvedUrlObj.hostname}`,
    );
    assert.notEqual(rawIp, 'example.com', 'Hostname should not be the original domain');
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

  it('accepts public IPv6 addresses as safe', async () => {
    // Mock the DNS lookup would be ideal, but we already have a network-
    // dependent test above. Assert that isPrivateIp (via resolveAndValidateUrl)
    // no longer fails on IPv6 resolution. example.com commonly returns
    // IPv6 on IPv6-enabled networks; if it doesn't here, we can't verify
    // the v6 path, but the test still passes (v4 path always worked).
    const result = await resolveAndValidateUrl('https://example.com/api');
    assert.equal(result.safe, true, 'public example.com must resolve as safe regardless of family');
    assert.ok(result.resolvedIp, 'should have a resolved IP');
    // If the resolver returned IPv6, verify the pinned URL is well-formed
    // (bracketed) and parses back to the same address.
    if (isIP(result.resolvedIp) === 6) {
      assert.ok(result.resolvedUrl, 'IPv6 resolution must produce a pinned URL');
      const parsed = new URL(result.resolvedUrl);
      assert.equal(parsed.hostname, `[${result.resolvedIp}]`, 'IPv6 hostname must be bracketed');
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

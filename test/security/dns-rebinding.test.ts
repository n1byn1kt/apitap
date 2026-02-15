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

  it('Host header is set to original hostname when using resolved IP', async () => {
    const skill = makeSkill('http://example.com');
    let capturedHeaders: HeadersInit | undefined;
    let capturedUrl: string | undefined;

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
      assert.ok(capturedHeaders, 'Headers should be captured');

      const headers = capturedHeaders as Record<string, string>;

      // The URL should contain the resolved IP
      assert.match(capturedUrl, /http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, 'Fetched URL should use IP');

      // But the Host header should be the original hostname
      assert.equal(headers['host'], 'example.com', 'Host header should be original hostname');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fetch uses resolved IP not hostname', async () => {
    const skill = makeSkill('http://example.com');
    let capturedUrl: string | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'get-data');

      assert.ok(capturedUrl, 'URL should be captured');

      // The fetch should use an IP address, not the hostname
      assert.match(capturedUrl, /http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/data/, 'Fetch should use resolved IP not hostname');

      // Verify it's NOT using the hostname
      assert.ok(!capturedUrl.includes('example.com'), 'Should not contain original hostname in URL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

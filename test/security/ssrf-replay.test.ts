import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(baseUrl: string): SkillFile {
  return {
    version: '1.1',
    domain: new URL(baseUrl).hostname,
    baseUrl,
    capturedAt: '2026-02-04T12:00:00.000Z',
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

describe('F1: SSRF validation in replay path', () => {
  it('blocks 127.0.0.1', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill('http://127.0.0.1'), 'get-data'),
      /SSRF blocked/,
    );
  });

  it('blocks 169.254.169.254 (cloud metadata)', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill('http://169.254.169.254'), 'get-data'),
      /SSRF blocked/,
    );
  });

  it('blocks [::1]', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill('http://[::1]'), 'get-data'),
      /SSRF blocked/,
    );
  });

  it('blocks ::ffff:127.0.0.1 (IPv4-mapped)', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill('http://[::ffff:127.0.0.1]'), 'get-data'),
      /SSRF blocked/,
    );
  });

  it('blocks fd00::1 (unique-local)', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill('http://[fd00::1]'), 'get-data'),
      /SSRF blocked/,
    );
  });

  it('blocks 0.0.0.0', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill('http://0.0.0.0'), 'get-data'),
      /SSRF blocked/,
    );
  });

  it('allows public IP with mocked fetch', async () => {
    // Use a raw public IP — skips DNS resolution in resolveAndValidateUrl
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;

    try {
      const result = await replayEndpoint(makeSkill('http://93.184.216.34'), 'get-data');
      assert.equal(result.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

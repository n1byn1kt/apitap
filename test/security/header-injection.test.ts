import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

function makeSkillWithHeaders(headers: Record<string, string>): SkillFile {
  return {
    version: '1.1',
    domain: 'example.com',
    baseUrl: 'http://93.184.216.34',  // Public IP to bypass SSRF
    capturedAt: '2026-02-14T12:00:00.000Z',
    endpoints: [{
      id: 'test-endpoint',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers,  // Skill file headers to test
      responseShape: { type: 'object' },
      examples: {
        request: { url: 'http://93.184.216.34/api/data', headers: {} },
        responsePreview: null
      },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'unsigned',
  } as SkillFile;
}

describe('F8: Header injection prevention', () => {
  it('blocks Host header from skill file', async () => {
    const skill = makeSkillWithHeaders({ 'Host': 'evil.com' });
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'test-endpoint', { _skipSsrfCheck: true });
      assert.ok(capturedHeaders, 'Headers should be captured');
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['Host'], undefined, 'Host header should be blocked');
      assert.equal(headers['host'], undefined, 'host header should be blocked');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks X-Forwarded-For from skill file', async () => {
    const skill = makeSkillWithHeaders({ 'X-Forwarded-For': '127.0.0.1' });
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'test-endpoint', { _skipSsrfCheck: true });
      assert.ok(capturedHeaders, 'Headers should be captured');
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['X-Forwarded-For'], undefined, 'X-Forwarded-For should be blocked');
      assert.equal(headers['x-forwarded-for'], undefined, 'x-forwarded-for should be blocked');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks Cookie header from skill file', async () => {
    const skill = makeSkillWithHeaders({ 'Cookie': 'session=abc123' });
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'test-endpoint', { _skipSsrfCheck: true });
      assert.ok(capturedHeaders, 'Headers should be captured');
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['Cookie'], undefined, 'Cookie should be blocked');
      assert.equal(headers['cookie'], undefined, 'cookie should be blocked');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks Authorization header from skill file (must come via auth manager)', async () => {
    const skill = makeSkillWithHeaders({ 'Authorization': 'Bearer fake-token' });
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'test-endpoint', { _skipSsrfCheck: true });
      assert.ok(capturedHeaders, 'Headers should be captured');
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['Authorization'], undefined, 'Authorization should be blocked');
      assert.equal(headers['authorization'], undefined, 'authorization should be blocked');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows safe headers: Accept, Content-Type, User-Agent', async () => {
    const skill = makeSkillWithHeaders({
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ApiTap/1.0',
    });
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'test-endpoint', { _skipSsrfCheck: true });
      assert.ok(capturedHeaders, 'Headers should be captured');
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['Accept'], 'application/json', 'Accept should be allowed');
      assert.equal(headers['Content-Type'], 'application/json', 'Content-Type should be allowed');
      assert.equal(headers['User-Agent'], 'ApiTap/1.0', 'User-Agent should be allowed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows custom X-* headers', async () => {
    const skill = makeSkillWithHeaders({
      'X-Custom-Header': 'custom-value',
      'X-Api-Key': 'abc123',
    });
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    try {
      await replayEndpoint(skill, 'test-endpoint', { _skipSsrfCheck: true });
      assert.ok(capturedHeaders, 'Headers should be captured');
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['X-Custom-Header'], 'custom-value', 'X-Custom-Header should be allowed');
      assert.equal(headers['X-Api-Key'], 'abc123', 'X-Api-Key should be allowed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

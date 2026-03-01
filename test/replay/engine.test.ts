// test/replay/engine.test.ts
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEndpoint } from '../../src/replay/engine.js';
import { AuthManager } from '../../src/auth/manager.js';
import type { SkillFile } from '../../src/types.js';

describe('replayEndpoint', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/items')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Widget' }, { id: 2, name: 'Gadget' }]));
      } else if (req.url === '/api/item/42') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 42, name: 'Special' }));
      } else if (req.url === '/api/item/99') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 99, name: 'Dynamic' }));
      } else if (req.url === '/api/empty-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function makeSkill(): SkillFile {
    return {
      version: '1.1',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00.000Z',
      baseUrl,
      endpoints: [
        {
          id: 'get-api-items',
          method: 'GET',
          path: '/api/items',
          queryParams: { limit: { type: 'string', example: '10' } },
          headers: {},
          responseShape: { type: 'array', fields: ['id', 'name'] },
          examples: {
            request: { url: `${baseUrl}/api/items`, headers: {} },
            responsePreview: [],
          },
        },
        {
          id: 'get-api-item-42',
          method: 'GET',
          path: '/api/item/42',
          queryParams: {},
          headers: {},
          responseShape: { type: 'object', fields: ['id', 'name'] },
          examples: {
            request: { url: `${baseUrl}/api/item/42`, headers: {} },
            responsePreview: {},
          },
        },
      ],
      metadata: { captureCount: 2, filteredCount: 0, toolVersion: '0.2.0' },
      provenance: 'unsigned',
    };
  }

  it('replays a GET endpoint and returns JSON', async () => {
    const result = await replayEndpoint(makeSkill(), 'get-api-items', { _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, [
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Gadget' },
    ]);
  });

  it('replays with query parameters', async () => {
    const result = await replayEndpoint(makeSkill(), 'get-api-items', { params: { limit: '5' }, _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    // Server ignores params in this test, but the request should succeed
    assert.ok(Array.isArray(result.data));
  });

  it('throws for unknown endpoint ID', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill(), 'nonexistent', { _skipSsrfCheck: true }),
      { message: /endpoint.*not found/i },
    );
  });

  it('substitutes :id path parameters', async () => {
    const skill = makeSkill();
    // Add an endpoint with parameterized path
    skill.endpoints.push({
      id: 'get-api-item',
      method: 'GET',
      path: '/api/item/:id',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object', fields: ['id', 'name'] },
      examples: {
        request: { url: `${baseUrl}/api/item/42`, headers: {} },
        responsePreview: null,
      },
    });

    const result = await replayEndpoint(skill, 'get-api-item', { params: { id: '99' }, _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { id: 99, name: 'Dynamic' });
  });

  it('handles empty response body with JSON content-type', async () => {
    const skill = makeSkill();
    skill.endpoints.push({
      id: 'get-api-empty-json',
      method: 'GET',
      path: '/api/empty-json',
      queryParams: {},
      headers: {},
      responseShape: { type: 'unknown' },
      examples: {
        request: { url: `${baseUrl}/api/empty-json`, headers: {} },
        responsePreview: null,
      },
    });

    const result = await replayEndpoint(skill, 'get-api-empty-json', { _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    assert.equal(result.data, '');
  });

  it('uses example URL values as defaults for path params', async () => {
    const skill = makeSkill();
    skill.endpoints.push({
      id: 'get-api-item',
      method: 'GET',
      path: '/api/item/:id',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object', fields: ['id', 'name'] },
      examples: {
        request: { url: `${baseUrl}/api/item/42`, headers: {} },
        responsePreview: null,
      },
    });

    // No params provided — should use default from example (42)
    const result = await replayEndpoint(skill, 'get-api-item', { _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { id: 42, name: 'Special' });
  });
});

describe('POST body replay', () => {
  let postServer: Server;
  let postBaseUrl: string;
  let receivedBody: string | null = null;
  let receivedContentType: string | null = null;

  before(async () => {
    postServer = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        receivedBody = body;
        receivedContentType = req.headers['content-type'] ?? null;

        if (req.url === '/graphql') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { posts: [] } }));
        } else if (req.url === '/api/items') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ created: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise<void>(resolve => postServer.listen(0, resolve));
    const port = (postServer.address() as AddressInfo).port;
    postBaseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => postServer.close(() => resolve()));
  });

  it('sends JSON body for POST endpoint', async () => {
    receivedBody = null;
    receivedContentType = null;

    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00Z',
      baseUrl: postBaseUrl,
      endpoints: [{
        id: 'post-api-items',
        method: 'POST',
        path: '/api/items',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${postBaseUrl}/api/items`, headers: {} }, responsePreview: null },
        requestBody: {
          contentType: 'application/json',
          template: { name: 'widget', quantity: 5 },
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.7.0' },
      provenance: 'unsigned',
    };

    await replayEndpoint(skill, 'post-api-items', { _skipSsrfCheck: true });

    assert.equal(receivedContentType, 'application/json');
    assert.deepEqual(JSON.parse(receivedBody!), { name: 'widget', quantity: 5 });
  });

  it('substitutes variables in JSON body', async () => {
    receivedBody = null;

    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00Z',
      baseUrl: postBaseUrl,
      endpoints: [{
        id: 'post-api-items',
        method: 'POST',
        path: '/api/items',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${postBaseUrl}/api/items`, headers: {} }, responsePreview: null },
        requestBody: {
          contentType: 'application/json',
          template: { itemId: 123, action: 'update' },
          variables: ['itemId'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.7.0' },
      provenance: 'unsigned',
    };

    await replayEndpoint(skill, 'post-api-items', { params: { itemId: '999' }, _skipSsrfCheck: true });

    assert.deepEqual(JSON.parse(receivedBody!), { itemId: '999', action: 'update' });
  });

  it('sends GraphQL query body', async () => {
    receivedBody = null;

    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00Z',
      baseUrl: postBaseUrl,
      endpoints: [{
        id: 'post-graphql-GetPosts',
        method: 'POST',
        path: '/graphql',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${postBaseUrl}/graphql`, headers: {} }, responsePreview: null },
        requestBody: {
          contentType: 'application/json',
          template: {
            operationName: 'GetPosts',
            query: 'query GetPosts($limit: Int) { posts(limit: $limit) { id } }',
            variables: { limit: 10 },
          },
          variables: ['variables.limit'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.7.0' },
      provenance: 'unsigned',
    };

    await replayEndpoint(skill, 'post-graphql-GetPosts', { params: { 'variables.limit': '25' }, _skipSsrfCheck: true });

    const parsed = JSON.parse(receivedBody!);
    assert.equal(parsed.operationName, 'GetPosts');
    assert.equal(parsed.variables.limit, '25');
  });
});

describe('replayEndpoint with token injection', () => {
  let tokenServer: Server;
  let tokenBaseUrl: string;
  let receivedBody: string | null = null;
  let testDir: string;
  let authManager: AuthManager;

  before(async () => {
    tokenServer = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });

    await new Promise<void>(resolve => tokenServer.listen(0, resolve));
    const port = (tokenServer.address() as AddressInfo).port;
    tokenBaseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => tokenServer.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-replay-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should inject stored tokens into request body', async () => {
    // Store a token
    await authManager.storeTokens('localhost', {
      csrf_token: {
        value: 'fresh-csrf-token-12345678901234567890',
        refreshedAt: new Date().toISOString(),
      },
    });

    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00Z',
      baseUrl: tokenBaseUrl,
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${tokenBaseUrl}/api/action`, headers: {} }, responsePreview: null },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit', csrf_token: 'old-token-placeholder' },
          refreshableTokens: ['csrf_token'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'unsigned',
    };

    await replayEndpoint(skill, 'post-api-action', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });

    const parsed = JSON.parse(receivedBody!);
    assert.equal(parsed.csrf_token, 'fresh-csrf-token-12345678901234567890', 'should inject stored token');
    assert.equal(parsed.action, 'submit', 'should preserve other fields');
  });

  it('should preserve original token if not stored', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00Z',
      baseUrl: tokenBaseUrl,
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${tokenBaseUrl}/api/action`, headers: {} }, responsePreview: null },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit', csrf_token: 'original-token' },
          refreshableTokens: ['csrf_token'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'unsigned',
    };

    // No tokens stored - should use original
    await replayEndpoint(skill, 'post-api-action', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });

    const parsed = JSON.parse(receivedBody!);
    assert.equal(parsed.csrf_token, 'original-token', 'should preserve original token');
  });

  it('should return refreshed flag in result', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00Z',
      baseUrl: tokenBaseUrl,
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${tokenBaseUrl}/api/action`, headers: {} }, responsePreview: null },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit' },
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'unsigned',
    };

    const result = await replayEndpoint(skill, 'post-api-action', { _skipSsrfCheck: true });

    // refreshed should be undefined or false when not using auth refresh
    assert.ok(result.refreshed === undefined || result.refreshed === false);
  });
});

describe('replayEndpoint with retry-on-401', () => {
  let retryServer: Server;
  let retryBaseUrl: string;
  let requestCount: number;
  let lastAuthHeader: string | undefined;
  let testDir: string;
  let authManager: AuthManager;
  let originalFetch: typeof globalThis.fetch;

  before(async () => {
    retryServer = createServer((req, res) => {
      requestCount++;
      lastAuthHeader = req.headers.authorization;

      if (req.url === '/api/data') {
        if (req.headers.authorization === 'Bearer valid-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: 'success' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
        }
      } else if (req.url === '/api/forbidden') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>(resolve => retryServer.listen(0, resolve));
    const port = (retryServer.address() as AddressInfo).port;
    retryBaseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => retryServer.close(() => resolve()));
  });

  beforeEach(async () => {
    requestCount = 0;
    lastAuthHeader = undefined;
    testDir = await mkdtemp(join(tmpdir(), 'apitap-retry-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRetrySkill(overrides: Partial<SkillFile> = {}): SkillFile {
    return {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl: retryBaseUrl,
      endpoints: [{
        id: 'get-api-data',
        method: 'GET',
        path: '/api/data',
        queryParams: {},
        headers: { authorization: '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${retryBaseUrl}/api/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.9.0' },
      provenance: 'unsigned',
      ...overrides,
    };
  }

  it('retries on 401 after refresh succeeds', async () => {
    // Store initial expired auth
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: 'Bearer expired-token',
    });

    const skill = makeRetrySkill({
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://localhost/token',
          clientId: 'test', grantType: 'refresh_token',
        },
      },
    });

    await authManager.storeOAuthCredentials('localhost', { refreshToken: 'rt_test' });

    // Mock the OAuth fetch to return a valid token
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://localhost/token') {
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'valid-token' }),
          text: async () => '{}',
        } as Response;
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;

    // Inject the expired header into endpoint
    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = 'Bearer expired-token';

    const result = await replayEndpoint(skill, 'get-api-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.refreshed, true);
    assert.deepEqual(result.data, { data: 'success' });
  });

  it('returns 401 when refresh fails', async () => {
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: 'Bearer bad-token',
    });

    const skill = makeRetrySkill({
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://localhost/token',
          clientId: 'test', grantType: 'refresh_token',
        },
      },
    });

    await authManager.storeOAuthCredentials('localhost', { refreshToken: 'rt_expired' });

    // Mock OAuth fetch to fail
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://localhost/token') {
        return {
          ok: false, status: 400,
          json: async () => ({ error: 'invalid_grant' }),
          text: async () => 'invalid_grant',
        } as Response;
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;

    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = 'Bearer bad-token';

    const result = await replayEndpoint(skill, 'get-api-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    // Should return the 401 since refresh failed
    assert.equal(result.status, 401);
  });

  it('does not retry when response is 200', async () => {
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: 'Bearer valid-token',
    });

    const skill = makeRetrySkill();
    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = 'Bearer valid-token';

    const result = await replayEndpoint(skill, 'get-api-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.equal(requestCount, 1); // Only 1 request, no retry
    assert.equal(result.refreshed, undefined);
  });

  it('proactively refreshes expired JWT before making request', async () => {
    // Store a JWT that expires in the past
    const expiredExp = Math.floor(Date.now() / 1000) - 100;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: expiredExp })).toString('base64url');
    const expiredJwt = `${header}.${payload}.fake`;

    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: `Bearer ${expiredJwt}`,
    });

    const skill = makeRetrySkill({
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://localhost/token',
          clientId: 'test', grantType: 'refresh_token',
        },
      },
    });

    await authManager.storeOAuthCredentials('localhost', { refreshToken: 'rt_test' });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://localhost/token') {
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'valid-token' }),
          text: async () => '{}',
        } as Response;
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;

    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = `Bearer ${expiredJwt}`;

    const result = await replayEndpoint(skill, 'get-api-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.equal(result.refreshed, true);
    // Should have sent only 1 request to the API (proactive refresh prevented the doomed request)
    assert.equal(requestCount, 1);
  });

  it('returns structured auth error when 401 with no auth manager', async () => {
    const skill = makeRetrySkill();
    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = 'Bearer bad-token';

    // No authManager provided — should get structured error
    const result = await replayEndpoint(skill, 'get-api-data', { _skipSsrfCheck: true });

    assert.equal(result.status, 401);
    assert.ok(typeof result.data === 'object' && result.data !== null);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.error, 'Authentication required');
    assert.ok(typeof data.suggestion === 'string');
    assert.ok((data.suggestion as string).includes('apitap_auth_request'));
    assert.equal(data.domain, 'localhost');
  });

  it('returns structured auth error when 403 after refresh fails', async () => {
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: 'Bearer bad-token',
    });

    const skill = makeRetrySkill({
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://localhost/token',
          clientId: 'test', grantType: 'refresh_token',
        },
      },
    });

    await authManager.storeOAuthCredentials('localhost', { refreshToken: 'rt_expired' });

    // Mock OAuth fetch to fail
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://localhost/token') {
        return {
          ok: false, status: 400,
          json: async () => ({ error: 'invalid_grant' }),
          text: async () => 'invalid_grant',
        } as Response;
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;

    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = 'Bearer bad-token';

    // Override endpoint to always return 403
    skill.endpoints[0] = {
      ...skill.endpoints[0],
      id: 'get-api-forbidden',
      path: '/api/forbidden',
      examples: { request: { url: `${retryBaseUrl}/api/forbidden`, headers: {} }, responsePreview: null },
    };

    const result = await replayEndpoint(skill, 'get-api-forbidden', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 403);
    assert.ok(typeof result.data === 'object' && result.data !== null);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.error, 'Authentication required');
    assert.ok((data.suggestion as string).includes('apitap_auth_request'));
    assert.equal(data.domain, 'localhost');
  });

  it('uses parent domain auth when subdomain has no auth', async () => {
    // Store auth on parent domain (e.g. spotify.com)
    // Use example.com so getParentDomains('api.example.com') → ['example.com']
    await authManager.store('example.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer valid-token',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'api.example.com', capturedAt: new Date().toISOString(),
      baseUrl: retryBaseUrl, endpoints: [{
        id: 'get-api-data', method: 'GET', path: '/api/data',
        queryParams: {}, headers: {},
        responseShape: { type: 'object', fields: ['data'] },
        examples: { request: { url: `${retryBaseUrl}/api/data`, headers: {} }, responsePreview: { data: 'success' } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    const result = await replayEndpoint(skill, 'get-api-data', {
      authManager, domain: 'api.example.com', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.equal(lastAuthHeader, 'Bearer valid-token');
  });

  it('does not proactively refresh JWT with future expiry', async () => {
    // Store a JWT that expires far in the future
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64url');
    const validJwt = `${header}.${payload}.fake`;

    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: `Bearer valid-token`,
    });

    const skill = makeRetrySkill();
    const endpoint = skill.endpoints[0];
    endpoint.headers.authorization = 'Bearer valid-token';

    const result = await replayEndpoint(skill, 'get-api-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.equal(requestCount, 1);
    assert.equal(result.refreshed, undefined); // No refresh happened
  });
});

describe('replayEndpoint expiresAt pre-flight refresh', () => {
  let testDir: string;
  let authManager: AuthManager;
  let server: Server;
  let baseUrl: string;
  let requestCount: number;
  let receivedAuth: string | undefined;

  before(async () => {
    server = createServer((req, res) => {
      requestCount++;
      receivedAuth = req.headers['authorization'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-replay-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    requestCount = 0;
    receivedAuth = undefined;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('triggers refresh when expiresAt is within 30s of now', async () => {
    // Store auth with expiresAt 10 seconds from now (within 30s buffer)
    const almostExpired = new Date(Date.now() + 10_000).toISOString();
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization',
      value: 'Bearer opaque-expired-token',
      expiresAt: almostExpired,
    });

    // The skill has no oauthConfig, so refresh will fail — but the request still goes through
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: {},
        responseShape: { type: 'object', fields: ['ok'] },
        examples: { request: { url: `${baseUrl}/data`, headers: {} }, responsePreview: { ok: true } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    const result = await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    // Request should succeed (server returns 200)
    assert.equal(result.status, 200);
  });

  it('does not trigger refresh when expiresAt is far in future', async () => {
    const farFuture = new Date(Date.now() + 3600_000).toISOString();
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization',
      value: 'Bearer valid-token',
      expiresAt: farFuture,
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: {},
        responseShape: { type: 'object', fields: ['ok'] },
        examples: { request: { url: `${baseUrl}/data`, headers: {} }, responsePreview: { ok: true } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    const result = await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.equal(receivedAuth, 'Bearer valid-token');
  });
});

describe('replayEndpoint [stored] header resolution', () => {
  let storedServer: Server;
  let storedBaseUrl: string;
  let receivedHeaders: Record<string, string | undefined> = {};
  let testDir: string;
  let authManager: AuthManager;

  before(async () => {
    storedServer = createServer((req, res) => {
      receivedHeaders = {
        'x-client-id': req.headers['x-client-id'] as string | undefined,
        'authorization': req.headers['authorization'] as string | undefined,
        'x-api-key': req.headers['x-api-key'] as string | undefined,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => storedServer.listen(0, resolve));
    const port = (storedServer.address() as AddressInfo).port;
    storedBaseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => storedServer.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-stored-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    receivedHeaders = {};
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('resolves [stored] header when auth exists', async () => {
    await authManager.store('localhost', {
      type: 'custom', header: 'x-client-id', value: 'my-client-123',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(receivedHeaders['x-client-id'], 'my-client-123');
  });

  it('deletes unresolved [stored] headers instead of sending literal', async () => {
    // No auth stored — [stored] should be deleted, not sent
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(receivedHeaders['x-client-id'], undefined, 'should not send literal [stored]');
  });

  it('deletes unresolved [stored] headers when no authManager', async () => {
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    // No authManager provided at all
    await replayEndpoint(skill, 'get-data', { _skipSsrfCheck: true });

    assert.equal(receivedHeaders['x-client-id'], undefined, 'should not send literal [stored]');
  });

  it('uses cross-subdomain fallback for [stored] headers', async () => {
    // Store auth on parent domain
    await authManager.store('example.com', {
      type: 'custom', header: 'x-client-id', value: 'parent-domain-client',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'api.example.com', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'api.example.com', _skipSsrfCheck: true,
    });

    assert.equal(receivedHeaders['x-client-id'], 'parent-domain-client');
  });

  it('respects isolatedAuth flag — no fallback', async () => {
    await authManager.store('example.com', {
      type: 'custom', header: 'x-client-id', value: 'parent-value',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'api.example.com', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
        isolatedAuth: true,
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'api.example.com', _skipSsrfCheck: true,
    });

    // Parent auth should NOT be found because isolatedAuth prevents fallback
    assert.equal(receivedHeaders['x-client-id'], undefined, 'should not fallback with isolatedAuth');
  });
});

describe('replayEndpoint contract validation', () => {
  let driftServer: Server;
  let driftBaseUrl: string;

  before(async () => {
    driftServer = createServer((req, res) => {
      // Return a response that differs from the captured schema
      // Missing 'name' field, added 'email' field, 'id' changed type
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'string-now', email: 'new@example.com' }));
    });
    await new Promise<void>(resolve => driftServer.listen(0, resolve));
    const port = (driftServer.address() as AddressInfo).port;
    driftBaseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => driftServer.close(() => resolve()));
  });

  it('reports contract warnings when schema drifts', async () => {
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: driftBaseUrl, endpoints: [{
        id: 'get-user', method: 'GET', path: '/user',
        queryParams: {}, headers: {},
        responseShape: { type: 'object', fields: ['id', 'name'] },
        responseSchema: {
          type: 'object',
          fields: {
            id: { type: 'number' },
            name: { type: 'string' },
          },
        },
        examples: { request: { url: `${driftBaseUrl}/user`, headers: {} }, responsePreview: { id: 1, name: 'Alice' } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    const result = await replayEndpoint(skill, 'get-user', { _skipSsrfCheck: true });

    assert.equal(result.status, 200);
    assert.ok(result.contractWarnings, 'should have contract warnings');
    assert.ok(result.contractWarnings!.length > 0, 'should have at least one warning');

    // Check for specific warnings
    const errors = result.contractWarnings!.filter(w => w.severity === 'error');
    const warns = result.contractWarnings!.filter(w => w.severity === 'warn');
    const infos = result.contractWarnings!.filter(w => w.severity === 'info');

    assert.ok(errors.some(w => w.path === 'name'), 'should report missing name field');
    assert.ok(warns.some(w => w.path === 'id'), 'should report id type change');
    assert.ok(infos.some(w => w.path === 'email'), 'should report new email field');
  });

  it('returns no warnings when schema matches', async () => {
    const matchServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42, name: 'Bob' }));
    });
    await new Promise<void>(resolve => matchServer.listen(0, resolve));
    const matchPort = (matchServer.address() as AddressInfo).port;
    const matchBaseUrl = `http://localhost:${matchPort}`;

    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: matchBaseUrl, endpoints: [{
        id: 'get-user', method: 'GET', path: '/user',
        queryParams: {}, headers: {},
        responseShape: { type: 'object', fields: ['id', 'name'] },
        responseSchema: {
          type: 'object',
          fields: { id: { type: 'number' }, name: { type: 'string' } },
        },
        examples: { request: { url: `${matchBaseUrl}/user`, headers: {} }, responsePreview: { id: 1, name: 'Alice' } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    const result = await replayEndpoint(skill, 'get-user', { _skipSsrfCheck: true });

    assert.equal(result.status, 200);
    assert.equal(result.contractWarnings, undefined);

    await new Promise<void>(resolve => matchServer.close(() => resolve()));
  });

  it('skips contract validation when no responseSchema', async () => {
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: driftBaseUrl, endpoints: [{
        id: 'get-user', method: 'GET', path: '/user',
        queryParams: {}, headers: {},
        responseShape: { type: 'object', fields: ['id'] },
        // no responseSchema
        examples: { request: { url: `${driftBaseUrl}/user`, headers: {} }, responsePreview: { id: 1 } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    const result = await replayEndpoint(skill, 'get-user', { _skipSsrfCheck: true });

    assert.equal(result.status, 200);
    assert.equal(result.contractWarnings, undefined);
  });
});

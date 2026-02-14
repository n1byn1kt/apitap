// test/e2e/auth-refresh.test.ts
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillGenerator } from '../../src/skill/generator.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import { AuthManager } from '../../src/auth/manager.js';
import { writeSkillFile, readSkillFile } from '../../src/skill/store.js';
import type { CapturedExchange, SkillFile } from '../../src/types.js';

describe('E2E: Auth Refresh Flow', () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  // Use hex format that matches token detection pattern (32-64 hex chars)
  let currentToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  let testDir: string;

  before(async () => {
    // Create test server with rotating CSRF tokens
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/action') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.csrf_token === currentToken) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid CSRF token' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad request' }));
          }
        });
        return;
      }

      // Serve page that would trigger POST with current token
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>Test page</body></html>`);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as AddressInfo;
        port = addr.port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-e2e-'));
    currentToken = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should capture endpoint with refreshableTokens', async () => {
    // Simulate capture by creating a generator and adding an exchange
    const generator = new SkillGenerator();

    const exchange: CapturedExchange = {
      request: {
        url: `${baseUrl}/api/action`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          action: 'submit',
          csrf_token: currentToken,
        }),
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ success: true }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    };

    generator.addExchange(exchange);
    const skill = generator.toSkillFile('localhost');

    // Verify skill file has refreshableTokens
    assert.equal(skill.endpoints.length, 1);
    assert.deepEqual(
      skill.endpoints[0].requestBody?.refreshableTokens,
      ['csrf_token'],
      'should detect csrf_token as refreshable'
    );

    // Verify auth config is set (because refreshable tokens present)
    assert.ok(skill.auth, 'should have auth config');
    assert.equal(skill.auth?.browserMode, 'headless');
  });

  it('should succeed replay with correct token', async () => {
    const authManager = new AuthManager(testDir, 'test-machine-id');

    // Store the current token
    await authManager.storeTokens('localhost', {
      csrf_token: {
        value: currentToken,
        refreshedAt: new Date().toISOString(),
      },
    });

    // Create skill file
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: {
          request: { url: `${baseUrl}/api/action`, headers: {} },
          responsePreview: null,
        },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit', csrf_token: 'placeholder' },
          refreshableTokens: ['csrf_token'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'self',
    };

    // Replay with token injection
    const result = await replayEndpoint(skill, 'post-api-action', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200, 'should succeed with correct token');
    assert.deepEqual(result.data, { success: true });
  });

  it('should fail replay with stale token', async () => {
    const authManager = new AuthManager(testDir, 'test-machine-id');

    // Store an OLD token
    await authManager.storeTokens('localhost', {
      csrf_token: {
        value: '99999999999999999999999999999999',
        refreshedAt: new Date().toISOString(),
      },
    });

    // Create skill file
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: {
          request: { url: `${baseUrl}/api/action`, headers: {} },
          responsePreview: null,
        },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit', csrf_token: 'placeholder' },
          refreshableTokens: ['csrf_token'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'self',
    };

    // Replay should get 403 because token is stale
    const result = await replayEndpoint(skill, 'post-api-action', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });

    assert.equal(result.status, 403, 'should fail with stale token');
  });

  it('should succeed after token update', async () => {
    const authManager = new AuthManager(testDir, 'test-machine-id');

    // Start with stale token
    await authManager.storeTokens('localhost', {
      csrf_token: {
        value: '99999999999999999999999999999999',
        refreshedAt: new Date().toISOString(),
      },
    });

    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: {
          request: { url: `${baseUrl}/api/action`, headers: {} },
          responsePreview: null,
        },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit', csrf_token: 'placeholder' },
          refreshableTokens: ['csrf_token'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'self',
    };

    // First replay fails
    const firstResult = await replayEndpoint(skill, 'post-api-action', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });
    assert.equal(firstResult.status, 403, 'first replay should fail');

    // Simulate token refresh by updating stored token
    await authManager.storeTokens('localhost', {
      csrf_token: {
        value: currentToken,
        refreshedAt: new Date().toISOString(),
      },
    });

    // Second replay succeeds
    const secondResult = await replayEndpoint(skill, 'post-api-action', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });
    assert.equal(secondResult.status, 200, 'second replay should succeed after refresh');
  });

  it('should write and read skill file with auth config', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'test-domain.example.com',
      capturedAt: new Date().toISOString(),
      baseUrl: 'https://test-domain.example.com',
      endpoints: [{
        id: 'post-api-action',
        method: 'POST',
        path: '/api/action',
        queryParams: {},
        headers: { 'content-type': 'application/json' },
        responseShape: { type: 'object' },
        examples: {
          request: { url: 'https://test-domain.example.com/api/action', headers: {} },
          responsePreview: null,
        },
        requestBody: {
          contentType: 'application/json',
          template: { action: 'submit', csrf_token: 'placeholder' },
          refreshableTokens: ['csrf_token'],
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'self',
      auth: {
        browserMode: 'visible',
        captchaRisk: true,
      },
    };

    // Write skill file
    await writeSkillFile(skill, testDir);

    // Read it back
    const loaded = await readSkillFile('test-domain.example.com', testDir);

    assert.ok(loaded, 'should load skill file');
    assert.ok(loaded?.auth, 'should preserve auth config');
    assert.equal(loaded?.auth?.captchaRisk, true);
    assert.equal(loaded?.auth?.browserMode, 'visible');
    assert.deepEqual(loaded?.endpoints[0].requestBody?.refreshableTokens, ['csrf_token']);
  });
});

// test/e2e/oauth-e2e.test.ts
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
import type { CapturedExchange, SkillFile } from '../../src/types.js';

describe('E2E: OAuth Capture → Refresh → Replay', () => {
  let apiServer: Server;
  let tokenServer: Server;
  let apiPort: number;
  let tokenPort: number;
  let apiBaseUrl: string;
  let tokenBaseUrl: string;
  let testDir: string;
  let authManager: AuthManager;
  let currentAccessToken = 'initial-access-token';
  let currentRefreshToken = 'initial-refresh-token';
  let tokenRequestCount = 0;

  before(async () => {
    // API server: requires valid Bearer token
    apiServer = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth === `Bearer ${currentAccessToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 1 }] }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    });

    await new Promise<void>(resolve => apiServer.listen(0, resolve));
    apiPort = (apiServer.address() as AddressInfo).port;
    apiBaseUrl = `http://localhost:${apiPort}`;

    // OAuth token server
    tokenServer = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/oauth/token') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          tokenRequestCount++;
          const params = new URLSearchParams(body);

          if (params.get('grant_type') === 'refresh_token' &&
              params.get('refresh_token') === currentRefreshToken) {
            // Rotate tokens
            currentAccessToken = `access-token-${tokenRequestCount}`;
            const newRefreshToken = `refresh-token-${tokenRequestCount}`;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              access_token: currentAccessToken,
              refresh_token: newRefreshToken,
              token_type: 'bearer',
            }));

            currentRefreshToken = newRefreshToken;
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>(resolve => tokenServer.listen(0, resolve));
    tokenPort = (tokenServer.address() as AddressInfo).port;
    tokenBaseUrl = `http://localhost:${tokenPort}`;
  });

  after(async () => {
    await new Promise<void>(resolve => apiServer.close(() => resolve()));
    await new Promise<void>(resolve => tokenServer.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-oauth-e2e-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    currentAccessToken = 'initial-access-token';
    currentRefreshToken = 'initial-refresh-token';
    tokenRequestCount = 0;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('full cycle: capture OAuth → store config → replay with auto-refresh', async () => {
    // Step 1: Simulate capture — generator sees API traffic + OAuth token request
    const generator = new SkillGenerator();

    // API request with Bearer auth
    generator.addExchange({
      request: {
        url: `${apiBaseUrl}/api/items`,
        method: 'GET',
        headers: {
          authorization: `Bearer ${currentAccessToken}`,
          accept: 'application/json',
        },
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 1 }] }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    // OAuth token request during capture
    generator.addExchange({
      request: {
        url: `${tokenBaseUrl}/oauth/token`,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: `grant_type=refresh_token&client_id=my-app&refresh_token=${currentRefreshToken}&scope=read`,
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'new-token', token_type: 'bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    // Step 2: Verify OAuth config was detected
    const oauthConfig = generator.getOAuthConfig();
    assert.ok(oauthConfig, 'OAuth config should be detected');
    assert.equal(oauthConfig.tokenEndpoint, `${tokenBaseUrl}/oauth/token`);
    assert.equal(oauthConfig.clientId, 'my-app');
    assert.equal(oauthConfig.grantType, 'refresh_token');
    assert.equal(oauthConfig.scope, 'read');

    // Step 3: Generate skill file — should include oauthConfig
    const skill = generator.toSkillFile('localhost');
    assert.ok(skill.auth?.oauthConfig, 'Skill file should include oauthConfig');
    assert.equal(skill.auth!.oauthConfig!.tokenEndpoint, `${tokenBaseUrl}/oauth/token`);

    // Step 4: Store auth and OAuth credentials
    const extractedAuth = generator.getExtractedAuth();
    if (extractedAuth.length > 0) {
      await authManager.store('localhost', extractedAuth[0]);
    }
    await authManager.storeOAuthCredentials('localhost', {
      refreshToken: currentRefreshToken,
    });

    // Step 5: Expire the token and replay — should auto-refresh
    currentAccessToken = 'new-valid-token'; // change what the API accepts

    // Inject stored auth into endpoint headers for replay
    const endpoint = skill.endpoints.find(e => e.id === 'get-api-items')!;
    const storedAuth = await authManager.retrieve('localhost');
    if (storedAuth) {
      endpoint.headers[storedAuth.header] = storedAuth.value;
    }

    // Replay will get 401, trigger OAuth refresh, then retry
    const result = await replayEndpoint(skill, 'get-api-items', {
      authManager,
      domain: 'localhost',
      _skipSsrfCheck: true,
    });

    // The auto-refresh should have gotten a fresh token from token server
    assert.equal(result.status, 200);
    assert.equal(result.refreshed, true);
  });

  it('capture without OAuth traffic: skill file has no oauthConfig', async () => {
    const generator = new SkillGenerator();

    // Regular API request, no OAuth traffic
    generator.addExchange({
      request: {
        url: `${apiBaseUrl}/api/items`,
        method: 'GET',
        headers: { accept: 'application/json' },
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '[]',
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const skill = generator.toSkillFile('localhost');
    assert.equal(skill.auth?.oauthConfig, undefined);
    assert.equal(generator.getOAuthConfig(), null);
  });

  it('refresh token rotation updates stored credentials', async () => {
    // Set up auth with OAuth — use an expired token that will cause 401
    await authManager.store('localhost', {
      type: 'bearer', header: 'authorization', value: 'Bearer expired-token',
    });
    await authManager.storeOAuthCredentials('localhost', {
      refreshToken: currentRefreshToken,
    });

    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl: apiBaseUrl,
      endpoints: [{
        id: 'get-api-items',
        method: 'GET',
        path: '/api/items',
        queryParams: {},
        headers: { authorization: 'Bearer expired-token' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${apiBaseUrl}/api/items`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.9.0' },
      provenance: 'unsigned',
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: `${tokenBaseUrl}/oauth/token`,
          clientId: 'my-app',
          grantType: 'refresh_token',
          scope: 'read',
        },
      },
    };

    // Replay — will get 401, trigger OAuth refresh (which rotates tokens), retry
    const result = await replayEndpoint(skill, 'get-api-items', {
      authManager, domain: 'localhost',
      _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);

    // Verify the refresh token was rotated
    const oauthCreds = await authManager.retrieveOAuthCredentials('localhost');
    assert.ok(oauthCreds?.refreshToken);
    assert.notEqual(oauthCreds.refreshToken, 'initial-refresh-token',
      'Refresh token should have been rotated');
  });

  it('entropy detection captures non-standard auth headers', async () => {
    const generator = new SkillGenerator();

    // Request with non-standard auth header containing high-entropy value
    generator.addExchange({
      request: {
        url: `${apiBaseUrl}/api/items`,
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-custom-session': 'k9Xm2pLqR7vNwYtH3jF5sAcBdEfG8uIoKnMlJhZxWvQrTsUyPe',
        },
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '[]',
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const auth = generator.getExtractedAuth();
    const customAuth = auth.find(a => a.header === 'x-custom-session');
    assert.ok(customAuth, 'Should detect custom auth header via entropy');
    assert.equal(customAuth.type, 'custom');

    // Verify the header is marked [stored] in the skill file
    const skill = generator.toSkillFile('localhost');
    const endpoint = skill.endpoints[0];
    assert.equal(endpoint.headers['x-custom-session'], '[stored]');
  });

  it('JWT detection extracts expiry from Bearer token', async () => {
    const generator = new SkillGenerator();

    // Create a JWT with known claims
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      exp: 1700000000, iss: 'auth.example.com', scope: 'read',
    })).toString('base64url');
    const jwt = `${header}.${payload}.sig`;

    generator.addExchange({
      request: {
        url: `${apiBaseUrl}/api/items`,
        method: 'GET',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/json',
        },
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '[]',
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const auth = generator.getExtractedAuth();
    assert.ok(auth.length > 0, 'Should detect JWT auth');
    assert.equal(auth[0].type, 'bearer');
    assert.ok(auth[0].value.includes(jwt));
  });
});

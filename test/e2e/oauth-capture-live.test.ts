// test/e2e/oauth-capture-live.test.ts
// Live browser capture of OAuth refresh_token traffic → storage → replay with auto-refresh
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../../src/capture/monitor.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import { AuthManager } from '../../src/auth/manager.js';

describe('E2E: Live OAuth refresh token capture → replay', () => {
  let server: Server;
  let serverUrl: string;
  let testDir: string;
  let authManager: AuthManager;
  let currentAccessToken = 'live-access-token-0';
  let currentRefreshToken = 'rt_live_test_123';
  let tokenRequestCount = 0;

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // HTML page that triggers OAuth token refresh on load
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body><h1>OAuth Test App</h1>
          <script>
            fetch('/oauth/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'grant_type=refresh_token&client_id=test-app&refresh_token=rt_live_test_123'
            })
            .then(r => r.json())
            .then(data => {
              return fetch('/api/data', {
                headers: { 'Authorization': 'Bearer ' + data.access_token }
              });
            })
            .then(r => r.json());
          </script>
          </body></html>
        `);
        return;
      }

      // OAuth token endpoint
      if (req.method === 'POST' && url === '/oauth/token') {
        let body = '';
        req.on('data', (chunk: Buffer) => body += chunk);
        req.on('end', () => {
          tokenRequestCount++;
          const params = new URLSearchParams(body);

          if (params.get('grant_type') === 'refresh_token' &&
              params.get('refresh_token') === currentRefreshToken) {
            currentAccessToken = `live-access-token-${tokenRequestCount}`;
            const newRefreshToken = `rt_rotated_${tokenRequestCount}`;

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
        return;
      }

      // Protected API endpoint
      if (req.method === 'GET' && url === '/api/data') {
        const auth = req.headers.authorization;
        if (auth === `Bearer ${currentAccessToken}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items: [{ id: 1, name: 'live-test' }] }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-oauth-live-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    currentAccessToken = 'live-access-token-0';
    currentRefreshToken = 'rt_live_test_123';
    tokenRequestCount = 0;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('captures OAuth refresh_token from live browser traffic', async () => {
    // Step 1: Capture — real browser loads the page, JS fires OAuth POST
    const result = await capture({
      url: serverUrl,
      duration: 5,
      launch: true,
      headless: true,
      allDomains: true,
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    // Step 2: Find the generator for our localhost domain
    assert.ok(result.generators.size > 0, 'Should have at least one domain');
    const domain = Array.from(result.generators.keys())[0]!;
    const generator = result.generators.get(domain)!;

    // Step 3: Verify OAuth config was detected from live traffic
    const oauthConfig = generator.getOAuthConfig();
    assert.ok(oauthConfig, 'OAuth config should be detected from live capture');
    assert.ok(oauthConfig.tokenEndpoint.includes('/oauth/token'), 'Token endpoint should match');
    assert.equal(oauthConfig.clientId, 'test-app');
    assert.equal(oauthConfig.grantType, 'refresh_token');

    // Step 4: Verify refresh token was extracted (the new feature)
    const refreshToken = generator.getOAuthRefreshToken();
    assert.equal(refreshToken, 'rt_live_test_123',
      'Refresh token should be extracted from live OAuth traffic');

    // Step 5: Generate skill file — should include oauthConfig
    const skill = generator.toSkillFile(domain);
    assert.ok(skill.auth?.oauthConfig, 'Skill file should include oauthConfig');
  });

  it('full live pipeline: capture → store → expire → replay with auto-refresh', async () => {
    // Step 1: Capture live traffic
    const result = await capture({
      url: serverUrl,
      duration: 5,
      launch: true,
      headless: true,
      allDomains: true,
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    const domain = Array.from(result.generators.keys())[0]!;
    const generator = result.generators.get(domain)!;
    const skill = generator.toSkillFile(domain);

    // Step 2: Store extracted auth + OAuth credentials (as CLI/session would)
    // Find the bearer auth specifically — entropy detection may flag other headers
    const extractedAuth = generator.getExtractedAuth();
    const bearerAuth = extractedAuth.find(a => a.type === 'bearer');
    if (bearerAuth) {
      await authManager.store(domain, bearerAuth);
    }
    const clientSecret = generator.getOAuthClientSecret();
    const refreshToken = generator.getOAuthRefreshToken();
    if (clientSecret || refreshToken) {
      await authManager.storeOAuthCredentials(domain, {
        ...(clientSecret ? { clientSecret } : {}),
        ...(refreshToken ? { refreshToken } : {}),
      });
    }

    // Step 3: Verify credentials are stored
    const storedOAuth = await authManager.retrieveOAuthCredentials(domain);
    assert.ok(storedOAuth?.refreshToken, 'Refresh token should be stored');

    // Step 4: Reset server state — during capture, the browser already used the
    // refresh token (causing server-side rotation). Reset so the stored token is valid.
    currentRefreshToken = storedOAuth!.refreshToken!;
    currentAccessToken = 'expired-will-cause-401';
    tokenRequestCount = 0;

    // Step 5: Replay — will get 401, trigger OAuth refresh, get new token, retry → 200
    const apiEndpoint = skill.endpoints.find(e => e.path === '/api/data');
    assert.ok(apiEndpoint, 'Should have captured /api/data endpoint');

    // Inject stored auth into endpoint headers for replay
    const storedAuth = await authManager.retrieve(domain);
    if (storedAuth) {
      apiEndpoint.headers[storedAuth.header] = storedAuth.value;
    }

    const replayResult = await replayEndpoint(skill, apiEndpoint.id, {
      authManager,
      domain,
      _skipSsrfCheck: true,
    });

    assert.equal(replayResult.status, 200, 'Replay should succeed after auto-refresh');
    assert.equal(replayResult.refreshed, true, 'Should have triggered refresh');

    // Step 6: Verify refresh token was rotated
    const updatedOAuth = await authManager.retrieveOAuthCredentials(domain);
    assert.ok(updatedOAuth?.refreshToken);
    assert.notEqual(updatedOAuth!.refreshToken, 'rt_live_test_123',
      'Refresh token should have been rotated by the server');
  });
});

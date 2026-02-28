// test/e2e/oauth-auth0.test.ts
// Auth0 tenant: standard OAuth flow, but refresh works via suffix-matched whitelist
// (tenant.auth0.com matches auth0.com in KNOWN_OAUTH_HOSTS)
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOAuthServer, type MockOAuthServer } from './helpers/mock-oauth-server.js';
import { SkillGenerator } from '../../src/skill/generator.js';
import { capture } from '../../src/capture/monitor.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import { refreshOAuth } from '../../src/auth/oauth-refresh.js';
import { AuthManager } from '../../src/auth/manager.js';
import type { OAuthConfig } from '../../src/types.js';

describe('E2E: Auth0 OAuth (suffix-matched whitelist)', () => {
  let mock: MockOAuthServer;
  let testDir: string;
  let authManager: AuthManager;

  before(async () => {
    mock = await createMockOAuthServer({
      tokenPath: '/oauth/token',
      grantTypeLocation: 'body',
      htmlTokenRequest: () => `
        fetch('/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&client_id=auth0-app&refresh_token=refresh-token-initial'
        })
        .then(r => r.json())
        .then(data => {
          return fetch('/api/data', {
            headers: { 'Authorization': 'Bearer ' + data.access_token }
          });
        });
      `,
    });
  });

  after(async () => {
    await mock.cleanup();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth0-e2e-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    mock.reset();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // --- Generator-level test (fast, no browser) ---

  it('detects standard OAuth from Auth0-shaped exchange (generator-level)', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange({
      request: {
        url: 'https://mytenant.auth0.com/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'grant_type=refresh_token&client_id=auth0-app&refresh_token=rt_auth0_abc',
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'at_auth0', token_type: 'bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const config = gen.getOAuthConfig();
    assert.ok(config, 'OAuthConfig should be detected');
    assert.equal(config.clientId, 'auth0-app');
    assert.equal(config.grantType, 'refresh_token');
    assert.equal(gen.getOAuthRefreshToken(), 'rt_auth0_abc');
  });

  // --- Live browser test (slow, requires Playwright) ---

  it('full pipeline with live browser capture and replay', async () => {
    const result = await capture({
      url: mock.url,
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

    const extractedAuth = generator.getExtractedAuth();
    const bearerAuth = extractedAuth.find(a => a.type === 'bearer');
    if (bearerAuth) await authManager.store(domain, bearerAuth);

    const refreshToken = generator.getOAuthRefreshToken();
    if (refreshToken) {
      await authManager.storeOAuthCredentials(domain, { refreshToken });
    }

    const storedOAuth = await authManager.retrieveOAuthCredentials(domain);
    assert.ok(storedOAuth?.refreshToken, 'Should have stored refresh token');
    mock.state.currentRefreshToken = storedOAuth!.refreshToken!;
    mock.state.currentAccessToken = 'expired-will-401';
    mock.state.tokenRequestCount = 0;

    const apiEndpoint = skill.endpoints.find(e => e.path === '/api/data');
    assert.ok(apiEndpoint);

    const storedAuth = await authManager.retrieve(domain);
    if (storedAuth) apiEndpoint.headers[storedAuth.header] = storedAuth.value;

    const replayResult = await replayEndpoint(skill, apiEndpoint.id, {
      authManager, domain, _skipSsrfCheck: true,
    });

    assert.equal(replayResult.status, 200);
    assert.equal(replayResult.refreshed, true);
  });

  // --- Domain whitelist security test ---

  it('blocks evil-auth0.com (not a suffix match)', async () => {
    // evil-auth0.com should NOT match auth0.com in the whitelist.
    // The suffix check requires ".auth0.com", so "evil-auth0.com" fails.
    await authManager.storeOAuthCredentials('myapp.com', { refreshToken: 'rt_evil' });

    const config: OAuthConfig = {
      tokenEndpoint: 'https://evil-auth0.com/oauth/token',
      clientId: 'evil-app',
      grantType: 'refresh_token',
    };

    const result = await refreshOAuth('myapp.com', config, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('domain mismatch'));
  });
});

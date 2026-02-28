// test/e2e/oauth-supabase.test.ts
// Supabase GoTrue: grant_type in URL query param, client_id in body
// NOTE: Real Supabase uses `apikey` header instead of `client_id` in body.
// This test exercises the URL grant_type fallback (our supported path).
// The apikey-as-auth pattern is a known gap for future work.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockOAuthServer, type MockOAuthServer } from './helpers/mock-oauth-server.js';
import { SkillGenerator } from '../../src/skill/generator.js';
import { capture } from '../../src/capture/monitor.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import { AuthManager } from '../../src/auth/manager.js';

describe('E2E: Supabase GoTrue OAuth (grant_type in URL)', () => {
  let mock: MockOAuthServer;
  let testDir: string;
  let authManager: AuthManager;

  before(async () => {
    mock = await createMockOAuthServer({
      tokenPath: '/auth/v1/token',
      grantTypeLocation: 'url',
      htmlTokenRequest: () => `
        fetch('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'client_id=supabase-app&refresh_token=refresh-token-initial'
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
    testDir = await mkdtemp(join(tmpdir(), 'apitap-supabase-e2e-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    mock.reset();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // --- Generator-level test (fast, no browser) ---

  it('detects grant_type from URL query param (generator-level)', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange({
      request: {
        url: 'https://myproject.supabase.co/auth/v1/token?grant_type=refresh_token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'client_id=supabase-app&refresh_token=rt_supa_123',
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'at_supa', token_type: 'bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const config = gen.getOAuthConfig();
    assert.ok(config, 'OAuthConfig should be detected');
    assert.equal(config.grantType, 'refresh_token');
    assert.equal(config.clientId, 'supabase-app');
    assert.equal(gen.getOAuthRefreshToken(), 'rt_supa_123');
  });

  // --- Live browser tests (slow, require Playwright) ---

  it('captures Supabase OAuth from live browser traffic', async () => {
    const result = await capture({
      url: mock.url,
      duration: 5,
      launch: true,
      headless: true,
      allDomains: true,
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    assert.ok(result.generators.size > 0, 'Should have at least one domain');
    const domain = Array.from(result.generators.keys())[0]!;
    const generator = result.generators.get(domain)!;

    const config = generator.getOAuthConfig();
    assert.ok(config, 'Should detect OAuthConfig from Supabase-style traffic');
    assert.equal(config.grantType, 'refresh_token');
    assert.equal(config.clientId, 'supabase-app');
  });

  it('full pipeline: capture → store → refresh → replay', async () => {
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
});

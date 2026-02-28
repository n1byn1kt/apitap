// test/e2e/oauth-firebase.test.ts
// Firebase OAuth: securetoken.googleapis.com with ?key= URL param instead of client_id
//
// Generator-level tests use the real Firebase hostname to test the provider-specific
// ?key= detection path. Live browser tests use a single localhost server (same-origin)
// with client_id in body for the generic OAuth path — these verify the full pipeline.
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

describe('E2E: Firebase OAuth (?key= URL param)', () => {
  let mock: MockOAuthServer;
  let testDir: string;
  let authManager: AuthManager;

  before(async () => {
    mock = await createMockOAuthServer({
      tokenPath: '/v1/token',
      grantTypeLocation: 'body',
      htmlTokenRequest: () => `
        fetch('/v1/token?key=AIzaSyB-test123', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&client_id=firebase-app&refresh_token=refresh-token-initial'
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
    testDir = await mkdtemp(join(tmpdir(), 'apitap-firebase-e2e-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    mock.reset();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // --- Generator-level tests (fast, no browser) ---
  // Use the real securetoken.googleapis.com hostname to test Firebase-specific detection.

  it('detects Firebase OAuthConfig with ?key= as clientId', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange({
      request: {
        url: 'https://securetoken.googleapis.com/v1/token?key=AIzaSyB-test123',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'grant_type=refresh_token&refresh_token=rt_firebase_abc',
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'at_fb', token_type: 'bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const config = gen.getOAuthConfig();
    assert.ok(config, 'OAuthConfig should be detected');
    assert.equal(config.clientId, 'AIzaSyB-test123', 'clientId should be the Firebase API key');
    assert.ok(config.tokenEndpoint.includes('?key=AIzaSyB-test123'), 'tokenEndpoint should include ?key=');
    assert.equal(config.grantType, 'refresh_token');
  });

  it('extracts refresh token from Firebase request body', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange({
      request: {
        url: 'https://securetoken.googleapis.com/v1/token?key=AIzaSyB-test123',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'grant_type=refresh_token&refresh_token=rt_firebase_xyz',
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'at_fb', token_type: 'bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    assert.equal(gen.getOAuthRefreshToken(), 'rt_firebase_xyz');
  });

  // --- Live browser tests (slow, require Playwright) ---
  // These use localhost with client_id in body (generic OAuth path).
  // The Firebase-specific ?key= detection is tested above at generator level.

  it('captures OAuth from live browser traffic (Firebase-shaped endpoint)', async () => {
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
    assert.ok(config, 'Should detect OAuthConfig from live capture');
    assert.ok(config.tokenEndpoint.includes('/v1/token'), 'Token endpoint should match Firebase path');
    assert.equal(config.grantType, 'refresh_token');
  });

  it('full pipeline: capture → store → expire → refresh → replay', async () => {
    // Step 1: Capture
    const result = await capture({
      url: mock.url,
      duration: 5,
      launch: true,
      headless: true,
      allDomains: true,
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    // Step 2: Build skill file
    const domain = Array.from(result.generators.keys())[0]!;
    const generator = result.generators.get(domain)!;
    const skill = generator.toSkillFile(domain);

    // Step 3: Store auth + OAuth credentials
    const extractedAuth = generator.getExtractedAuth();
    const bearerAuth = extractedAuth.find(a => a.type === 'bearer');
    if (bearerAuth) await authManager.store(domain, bearerAuth);

    const refreshToken = generator.getOAuthRefreshToken();
    if (refreshToken) {
      await authManager.storeOAuthCredentials(domain, { refreshToken });
    }

    // Step 4: Expire the token
    const storedOAuth = await authManager.retrieveOAuthCredentials(domain);
    assert.ok(storedOAuth?.refreshToken, 'Should have stored refresh token');
    mock.state.currentRefreshToken = storedOAuth!.refreshToken!;
    mock.state.currentAccessToken = 'expired-token-will-401';
    mock.state.tokenRequestCount = 0;

    // Step 5: Replay — should auto-refresh
    const apiEndpoint = skill.endpoints.find(e => e.path === '/api/data');
    assert.ok(apiEndpoint, 'Should have /api/data endpoint');

    const storedAuth = await authManager.retrieve(domain);
    if (storedAuth) apiEndpoint.headers[storedAuth.header] = storedAuth.value;

    const replayResult = await replayEndpoint(skill, apiEndpoint.id, {
      authManager,
      domain,
      _skipSsrfCheck: true,
    });

    assert.equal(replayResult.status, 200, 'Replay should succeed after auto-refresh');
    assert.equal(replayResult.refreshed, true, 'Should have triggered refresh');
  });
});

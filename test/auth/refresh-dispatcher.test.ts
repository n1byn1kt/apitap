// test/auth/refresh-dispatcher.test.ts
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../../src/auth/manager.js';
import { refreshTokens, type RefreshResult } from '../../src/auth/refresh.js';
import type { SkillFile, OAuthConfig } from '../../src/types.js';

function makeSkill(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    version: '1.2',
    domain: 'example.com',
    capturedAt: new Date().toISOString(),
    baseUrl: 'https://example.com',
    endpoints: [],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.9.0' },
    provenance: 'self',
    ...overrides,
  };
}

describe('refresh dispatcher', () => {
  let testDir: string;
  let authManager: AuthManager;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-dispatcher-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(testDir, { recursive: true, force: true });
  });

  it('routes to OAuth path when oauthConfig + refreshToken present', async () => {
    const skill = makeSkill({
      auth: {
        browserMode: 'headless',
        captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'test',
          grantType: 'refresh_token',
        },
      },
    });

    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_123',
    });

    globalThis.fetch = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'new-token' }),
      text: async () => '{}',
    })) as unknown as typeof globalThis.fetch;

    const result = await refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true });
    assert.equal(result.success, true);
    assert.equal(result.oauthRefreshed, true);
    // Verify fetch was called (OAuth path, not browser)
    assert.equal((globalThis.fetch as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('routes to OAuth path for client_credentials without refreshToken', async () => {
    const skill = makeSkill({
      auth: {
        browserMode: 'headless',
        captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'cc-client',
          grantType: 'client_credentials',
        },
      },
    });

    await authManager.storeOAuthCredentials('example.com', {
      clientSecret: 'cc-secret',
    });

    globalThis.fetch = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'cc-token' }),
      text: async () => '{}',
    })) as unknown as typeof globalThis.fetch;

    const result = await refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true });
    assert.equal(result.success, true);
    assert.equal(result.oauthRefreshed, true);
  });

  it('returns success=false when no refresh mechanisms available', async () => {
    const skill = makeSkill(); // no auth config, no refreshable tokens

    const result = await refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true });
    // No OAuth, no browser tokens — nothing to refresh
    assert.equal(result.success, false);
  });

  it('skips OAuth when no refreshToken stored for refresh_token grant', async () => {
    const skill = makeSkill({
      auth: {
        browserMode: 'headless',
        captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'test',
          grantType: 'refresh_token',
        },
      },
    });
    // No refreshToken stored — should not attempt OAuth

    const fetchMock = mock.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true });
    assert.equal(result.oauthRefreshed, undefined);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('deduplicates concurrent refreshes for same domain', async () => {
    const skill = makeSkill({
      auth: {
        browserMode: 'headless',
        captchaRisk: false,
        oauthConfig: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'test',
          grantType: 'refresh_token',
        },
      },
    });

    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
    });

    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      // Simulate network delay
      await new Promise(r => setTimeout(r, 50));
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: `token-${callCount}` }),
        text: async () => '{}',
      };
    }) as unknown as typeof globalThis.fetch;

    // Fire 3 concurrent refreshes
    const [r1, r2, r3] = await Promise.all([
      refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true }),
      refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true }),
      refreshTokens(skill, authManager, { domain: 'example.com', _skipSsrfCheck: true }),
    ]);

    // Only 1 actual fetch should have been made
    assert.equal(callCount, 1);
    // All should get the same result
    assert.equal(r1.success, r2.success);
    assert.equal(r2.success, r3.success);
  });

  it('allows independent refreshes for different domains', async () => {
    const skill1 = makeSkill({
      domain: 'a.com',
      baseUrl: 'https://a.com',
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: { tokenEndpoint: 'https://a.com/token', clientId: 'a', grantType: 'refresh_token' },
      },
    });
    const skill2 = makeSkill({
      domain: 'b.com',
      baseUrl: 'https://b.com',
      auth: {
        browserMode: 'headless', captchaRisk: false,
        oauthConfig: { tokenEndpoint: 'https://b.com/token', clientId: 'b', grantType: 'refresh_token' },
      },
    });

    await authManager.storeOAuthCredentials('a.com', { refreshToken: 'rt_a' });
    await authManager.storeOAuthCredentials('b.com', { refreshToken: 'rt_b' });

    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: `token-${callCount}` }),
        text: async () => '{}',
      };
    }) as unknown as typeof globalThis.fetch;

    await Promise.all([
      refreshTokens(skill1, authManager, { domain: 'a.com', _skipSsrfCheck: true }),
      refreshTokens(skill2, authManager, { domain: 'b.com', _skipSsrfCheck: true }),
    ]);

    // Two separate fetches — one per domain
    assert.equal(callCount, 2);
  });
});

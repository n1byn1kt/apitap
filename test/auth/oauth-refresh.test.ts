// test/auth/oauth-refresh.test.ts
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../../src/auth/manager.js';
import { refreshOAuth } from '../../src/auth/oauth-refresh.js';
import type { OAuthConfig } from '../../src/types.js';

describe('refreshOAuth', () => {
  let testDir: string;
  let authManager: AuthManager;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-oauth-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(testDir, { recursive: true, force: true });
  });

  const baseConfig: OAuthConfig = {
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    clientId: 'test-client',
    grantType: 'refresh_token',
    scope: 'read write',
  };

  function mockFetch(response: { status: number; body: unknown }) {
    globalThis.fetch = mock.fn(async () => ({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    })) as unknown as typeof globalThis.fetch;
  }

  it('refreshes access token successfully', async () => {
    await authManager.store('example.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer old-token',
    });
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_old',
    });

    mockFetch({
      status: 200,
      body: { access_token: 'new-access-token', token_type: 'bearer' },
    });

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, true);
    assert.equal(result.accessToken, 'new-access-token');

    // Verify stored
    const stored = await authManager.retrieve('example.com');
    assert.equal(stored?.value, 'Bearer new-access-token');
  });

  it('sends correct parameters in refresh request', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
    });

    let capturedBody = '';
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'tok' }),
        text: async () => '{}',
      };
    }) as unknown as typeof globalThis.fetch;

    await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('client_id'), 'test-client');
    assert.equal(params.get('scope'), 'read write');
    assert.equal(params.get('refresh_token'), 'rt_test');
  });

  it('handles refresh token rotation', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_old',
    });

    mockFetch({
      status: 200,
      body: {
        access_token: 'new-at',
        refresh_token: 'rt_new',
      },
    });

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, true);
    assert.equal(result.tokenRotated, true);

    // Verify new refresh token stored
    const creds = await authManager.retrieveOAuthCredentials('example.com');
    assert.equal(creds?.refreshToken, 'rt_new');
  });

  it('does not rotate when refresh_token unchanged', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_same',
    });

    mockFetch({
      status: 200,
      body: {
        access_token: 'new-at',
        refresh_token: 'rt_same',
      },
    });

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.tokenRotated, false);
  });

  it('handles client_credentials flow without refresh token', async () => {
    const ccConfig: OAuthConfig = {
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'cc-client',
      grantType: 'client_credentials',
    };

    await authManager.storeOAuthCredentials('example.com', {
      clientSecret: 'cc-secret',
    });

    let capturedBody = '';
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'cc-token' }),
        text: async () => '{}',
      };
    }) as unknown as typeof globalThis.fetch;

    const result = await refreshOAuth('example.com', ccConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, true);

    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get('grant_type'), 'client_credentials');
    assert.equal(params.get('client_secret'), 'cc-secret');
    assert.equal(params.has('refresh_token'), false);
  });

  it('fails when no refresh token available for refresh_token grant', async () => {
    // No refresh token stored
    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No refresh token'));
  });

  it('handles 400 invalid grant error', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_expired',
    });

    mockFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token expired' },
    });

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('400'));
  });

  it('handles 401 from token endpoint', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_bad',
    });

    mockFetch({
      status: 401,
      body: { error: 'invalid_client' },
    });

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('401'));
  });

  it('handles network error', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
    });

    globalThis.fetch = mock.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('ECONNREFUSED'));
  });

  it('handles response without access_token', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
    });

    mockFetch({
      status: 200,
      body: { token_type: 'bearer' }, // missing access_token
    });

    const result = await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No access_token'));
  });

  it('preserves existing tokens and session after refresh', async () => {
    await authManager.store('example.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer old',
      tokens: { csrf: { value: 'csrf-val', refreshedAt: '2026-01-01T00:00:00Z' } },
    });
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
    });

    mockFetch({
      status: 200,
      body: { access_token: 'new-at' },
    });

    await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });

    const stored = await authManager.retrieve('example.com');
    assert.equal(stored?.value, 'Bearer new-at');
    assert.equal(stored?.tokens?.csrf.value, 'csrf-val');
  });

  it('includes client_secret in request when stored', async () => {
    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
      clientSecret: 'my-secret',
    });

    let capturedBody = '';
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'tok' }),
        text: async () => '{}',
      };
    }) as unknown as typeof globalThis.fetch;

    await refreshOAuth('example.com', baseConfig, authManager, { _skipSsrfCheck: true });
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get('client_secret'), 'my-secret');
  });

  it('omits scope when not configured', async () => {
    const noScopeConfig: OAuthConfig = {
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'test-client',
      grantType: 'refresh_token',
    };

    await authManager.storeOAuthCredentials('example.com', {
      refreshToken: 'rt_test',
    });

    let capturedBody = '';
    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'tok' }),
        text: async () => '{}',
      };
    }) as unknown as typeof globalThis.fetch;

    await refreshOAuth('example.com', noScopeConfig, authManager, { _skipSsrfCheck: true });
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.has('scope'), false);
  });

  it('refreshes via Auth0 tenant endpoint (subdomain of known host)', async () => {
    const auth0Config: OAuthConfig = {
      tokenEndpoint: 'https://tenant.auth0.com/oauth/token',
      clientId: 'auth0-client',
      grantType: 'refresh_token',
    };

    await authManager.storeOAuthCredentials('myapp.com', {
      refreshToken: 'rt_auth0',
    });

    mockFetch({
      status: 200,
      body: { access_token: 'auth0-access-token', token_type: 'bearer' },
    });

    const result = await refreshOAuth('myapp.com', auth0Config, authManager, { _skipSsrfCheck: true });
    assert.equal(result.success, true);
    assert.equal(result.accessToken, 'auth0-access-token');
  });
});

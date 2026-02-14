import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshOAuth } from '../../src/auth/oauth-refresh.js';
import type { OAuthConfig } from '../../src/types.js';

// Minimal mock AuthManager
function mockAuthManager() {
  return {
    retrieveOAuthCredentials: async () => ({ refreshToken: 'rt_abc', clientSecret: 'secret' }),
    retrieve: async () => ({ type: 'bearer', header: 'authorization', value: 'Bearer old' }),
    store: async () => {},
    storeOAuthCredentials: async () => {},
  } as any;
}

function makeOAuthConfig(tokenEndpoint: string): OAuthConfig {
  return {
    tokenEndpoint,
    grantType: 'refresh_token',
    clientId: 'client-123',
  };
}

describe('F2: OAuth token endpoint SSRF validation', () => {
  it('blocks token endpoint targeting private IP', async () => {
    const result = await refreshOAuth(
      'api.example.com',
      makeOAuthConfig('http://127.0.0.1/token'),
      mockAuthManager(),
    );
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('blocked'));
  });

  it('blocks token endpoint on different domain', async () => {
    // Skip SSRF check (DNS resolution) to test the domain-match logic directly
    const result = await refreshOAuth(
      'api.example.com',
      makeOAuthConfig('https://evil.attacker.com/token'),
      mockAuthManager(),
      { _skipSsrfCheck: true },
    );
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('domain mismatch'));
  });

  it('allows token endpoint on same domain', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: 'new_token_123' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;

    try {
      const result = await refreshOAuth(
        'api.example.com',
        makeOAuthConfig('https://api.example.com/oauth/token'),
        mockAuthManager(),
        { _skipSsrfCheck: true },
      );
      assert.equal(result.success, true);
      assert.equal(result.accessToken, 'new_token_123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows token endpoint on known OAuth provider', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: 'google_token' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;

    try {
      const result = await refreshOAuth(
        'api.example.com',
        makeOAuthConfig('https://oauth2.googleapis.com/token'),
        mockAuthManager(),
        { _skipSsrfCheck: true },
      );
      assert.equal(result.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows token endpoint on subdomain of skill domain', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: 'sub_token' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;

    try {
      const result = await refreshOAuth(
        'example.com',
        makeOAuthConfig('https://auth.example.com/oauth/token'),
        mockAuthManager(),
        { _skipSsrfCheck: true },
      );
      assert.equal(result.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

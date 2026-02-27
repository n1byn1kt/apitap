// test/capture/oauth-detector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOAuthTokenRequest } from '../../src/capture/oauth-detector.js';
import { SkillGenerator } from '../../src/skill/generator.js';

describe('isOAuthTokenRequest', () => {
  it('detects refresh_token grant in URL-encoded body', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&client_id=myapp&refresh_token=abc123',
    });
    assert.ok(result);
    assert.equal(result.tokenEndpoint, 'https://auth.example.com/oauth/token');
    assert.equal(result.clientId, 'myapp');
    assert.equal(result.grantType, 'refresh_token');
  });

  it('detects client_credentials grant', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=client_credentials&client_id=myapp&client_secret=secret123',
    });
    assert.ok(result);
    assert.equal(result.grantType, 'client_credentials');
    assert.equal(result.clientSecret, 'secret123');
  });

  it('detects JSON-encoded body', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/api/token',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: 'json-app',
        refresh_token: 'rt_abc',
        scope: 'read write',
      }),
    });
    assert.ok(result);
    assert.equal(result.clientId, 'json-app');
    assert.equal(result.scope, 'read write');
  });

  it('extracts client_id from Basic auth header', () => {
    const basic = Buffer.from('basic-client:basic-secret').toString('base64');
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      postData: 'grant_type=refresh_token&refresh_token=rt_123',
    });
    assert.ok(result);
    assert.equal(result.clientId, 'basic-client');
    assert.equal(result.clientSecret, 'basic-secret');
  });

  it('extracts scope when present', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&client_id=myapp&scope=read+write+admin',
    });
    assert.ok(result);
    assert.equal(result.scope, 'read write admin');
  });

  it('strips query params from token endpoint', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token?v=2',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&client_id=myapp',
    });
    assert.ok(result);
    assert.equal(result.tokenEndpoint, 'https://auth.example.com/oauth/token');
  });

  it('ignores authorization_code grant (initial auth)', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=authorization_code&client_id=myapp&code=authcode',
    });
    assert.equal(result, null);
  });

  it('ignores GET requests', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'GET',
      headers: {},
    });
    assert.equal(result, null);
  });

  it('ignores non-token URLs', () => {
    const result = isOAuthTokenRequest({
      url: 'https://api.example.com/users/me',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&client_id=myapp',
    });
    assert.equal(result, null);
  });

  it('ignores requests without postData', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: {},
    });
    assert.equal(result, null);
  });

  it('ignores requests without grant_type', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'client_id=myapp&redirect_uri=http://localhost',
    });
    assert.equal(result, null);
  });

  it('ignores requests without client_id anywhere', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token',
    });
    assert.equal(result, null);
  });

  it('handles malformed body gracefully', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: 'not valid json{{{',
    });
    assert.equal(result, null);
  });

  it('handles empty body', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: '',
    });
    assert.equal(result, null);
  });

  it('detects /token in various URL positions', () => {
    const result = isOAuthTokenRequest({
      url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=client_credentials&client_id=azure-app&client_secret=s',
    });
    assert.ok(result);
    assert.equal(result.grantType, 'client_credentials');
  });

  it('extracts refreshToken from URL-encoded refresh_token grant', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&client_id=myapp&refresh_token=rt_secret_abc123',
    });
    assert.ok(result);
    assert.equal(result.refreshToken, 'rt_secret_abc123');
  });

  it('extracts refreshToken from JSON-encoded refresh_token grant', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/api/token',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: 'json-app',
        refresh_token: 'rt_json_xyz',
      }),
    });
    assert.ok(result);
    assert.equal(result.refreshToken, 'rt_json_xyz');
  });

  it('does not set refreshToken for client_credentials grant', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=client_credentials&client_id=myapp&client_secret=secret',
    });
    assert.ok(result);
    assert.equal(result.refreshToken, undefined);
  });
});

describe('Supabase URL grant_type fallback', () => {
  it('detects grant_type from URL query param', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.supabase.co/token?grant_type=refresh_token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'client_id=supabase-app&refresh_token=rt_supa',
    });
    assert.ok(result);
    assert.equal(result.grantType, 'refresh_token');
    assert.equal(result.clientId, 'supabase-app');
    assert.equal(result.refreshToken, 'rt_supa');
  });

  it('body grant_type takes precedence over URL', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.example.com/oauth/token?grant_type=client_credentials',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&client_id=myapp&refresh_token=rt_body',
    });
    assert.ok(result);
    assert.equal(result.grantType, 'refresh_token');
  });

  it('URL grant_type alone still requires client_id', () => {
    const result = isOAuthTokenRequest({
      url: 'https://auth.supabase.co/token?grant_type=refresh_token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'refresh_token=rt_supa',
    });
    assert.equal(result, null);
  });
});

describe('Firebase provider-specific detection', () => {
  it('detects Firebase with key param + refresh_token in body', () => {
    const result = isOAuthTokenRequest({
      url: 'https://securetoken.googleapis.com/v1/token?key=AIzaSyB-test123',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&refresh_token=firebase_rt_abc',
    });
    assert.ok(result);
    assert.equal(result.clientId, 'AIzaSyB-test123');
    assert.equal(result.grantType, 'refresh_token');
    assert.equal(result.refreshToken, 'firebase_rt_abc');
    // tokenEndpoint should include the ?key= param
    assert.ok(result.tokenEndpoint.includes('?key=AIzaSyB-test123'));
  });

  it('does not use Firebase path for non-securetoken domains', () => {
    const result = isOAuthTokenRequest({
      url: 'https://evil.example.com/v1/token?key=AIzaSyB-fake',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&refresh_token=rt_fake',
    });
    // Should fall through to normal path, which requires client_id → null
    assert.equal(result, null);
  });

  it('requires key param (no key → null)', () => {
    const result = isOAuthTokenRequest({
      url: 'https://securetoken.googleapis.com/v1/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=refresh_token&refresh_token=rt_no_key',
    });
    // No ?key= and no client_id → null
    assert.equal(result, null);
  });

  it('only for refresh_token grant (client_credentials on securetoken → normal path)', () => {
    const result = isOAuthTokenRequest({
      url: 'https://securetoken.googleapis.com/v1/token?key=AIzaSyB-test',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'grant_type=client_credentials&client_id=myapp&client_secret=secret',
    });
    // Should not use Firebase path (which is refresh_token only)
    // Falls through to normal path, succeeds with client_id
    assert.ok(result);
    assert.equal(result.grantType, 'client_credentials');
    assert.equal(result.clientId, 'myapp');
  });
});

describe('SkillGenerator OAuth refresh token', () => {
  it('stores and exposes refreshToken from captured OAuth request', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange({
      request: {
        url: 'https://auth.example.com/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'grant_type=refresh_token&client_id=myapp&refresh_token=rt_captured_123',
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'new_at', token_type: 'Bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    assert.equal(gen.getOAuthRefreshToken(), 'rt_captured_123');
    assert.ok(gen.getOAuthConfig());
    assert.equal(gen.getOAuthConfig()!.clientId, 'myapp');
  });

  it('returns undefined refreshToken for client_credentials grant', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange({
      request: {
        url: 'https://auth.example.com/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'grant_type=client_credentials&client_id=myapp&client_secret=secret',
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'at_cc', token_type: 'Bearer' }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    assert.equal(gen.getOAuthRefreshToken(), undefined);
  });
});

// test/capture/oauth-detector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOAuthTokenRequest } from '../../src/capture/oauth-detector.js';

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

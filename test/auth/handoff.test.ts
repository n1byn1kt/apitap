// test/auth/handoff.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLoginSuccess, hasHighConfidenceAuthTransition, detectOAuthTokenResponse } from '../../src/auth/handoff.js';

describe('detectLoginSuccess', () => {
  it('detects Set-Cookie with session-like names', () => {
    const headers = new Map([
      ['set-cookie', 'session_id=abc123; Path=/; HttpOnly'],
    ]);
    assert.equal(detectLoginSuccess(headers, 200), true);
  });

  it('detects Set-Cookie with token-like names', () => {
    const headers = new Map([
      ['set-cookie', 'auth_token=xyz789; Path=/'],
    ]);
    assert.equal(detectLoginSuccess(headers, 200), true);
  });

  it('ignores tracking cookies', () => {
    const headers = new Map([
      ['set-cookie', '_ga=GA1.2.123; Path=/'],
    ]);
    assert.equal(detectLoginSuccess(headers, 200), false);
  });

  it('detects auth header in response (bearer)', () => {
    const headers = new Map([
      ['authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.test.sig'],
    ]);
    assert.equal(detectLoginSuccess(headers, 200), true);
  });

  it('returns false for non-2xx status', () => {
    const headers = new Map([
      ['set-cookie', 'session_id=abc123; Path=/'],
    ]);
    assert.equal(detectLoginSuccess(headers, 401), false);
  });

  it('returns false for empty headers', () => {
    assert.equal(detectLoginSuccess(new Map(), 200), false);
  });
});

describe('hasHighConfidenceAuthTransition', () => {
  it('returns false for new anonymous cookie', () => {
    const baseline = new Map<string, string>();
    const current = [{ name: 'anon_id', value: 'abc123' }];
    assert.equal(hasHighConfidenceAuthTransition(baseline, current), false);
  });

  it('returns true for new session cookie', () => {
    const baseline = new Map<string, string>();
    const current = [{ name: 'session_id', value: 'abc123' }];
    assert.equal(hasHighConfidenceAuthTransition(baseline, current), true);
  });

  it('returns true when session-like cookie value changes', () => {
    const baseline = new Map<string, string>([['auth_token', 'old-value']]);
    const current = [{ name: 'auth_token', value: 'new-value' }];
    assert.equal(hasHighConfidenceAuthTransition(baseline, current), true);
  });

  it('returns false when session-like cookie value is unchanged', () => {
    const baseline = new Map<string, string>([['session_id', 'same-value']]);
    const current = [{ name: 'session_id', value: 'same-value' }];
    assert.equal(hasHighConfidenceAuthTransition(baseline, current), false);
  });
});

describe('detectOAuthTokenResponse', () => {
  it('detects standard OAuth token endpoint response', () => {
    const result = detectOAuthTokenResponse(
      'https://accounts.spotify.com/api/token',
      200,
      JSON.stringify({
        access_token: 'BQD...xyz',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'AQA...abc',
        scope: 'user-read-private',
      }),
    );

    assert.ok(result, 'should detect OAuth response');
    assert.equal(result!.accessToken, 'BQD...xyz');
    assert.equal(result!.refreshToken, 'AQA...abc');
    assert.equal(result!.expiresIn, 3600);
  });

  it('detects /oauth/token path', () => {
    const result = detectOAuthTokenResponse(
      'https://example.com/oauth/token',
      200,
      JSON.stringify({ access_token: 'tok123', token_type: 'bearer' }),
    );
    assert.ok(result);
    assert.equal(result!.accessToken, 'tok123');
  });

  it('ignores non-token URLs', () => {
    const result = detectOAuthTokenResponse(
      'https://example.com/api/users',
      200,
      JSON.stringify({ access_token: 'tok123' }),
    );
    assert.equal(result, null);
  });

  it('ignores non-200 responses', () => {
    const result = detectOAuthTokenResponse(
      'https://example.com/oauth/token',
      401,
      JSON.stringify({ error: 'invalid_grant' }),
    );
    assert.equal(result, null);
  });

  it('ignores responses without access_token', () => {
    const result = detectOAuthTokenResponse(
      'https://example.com/oauth/token',
      200,
      JSON.stringify({ token: 'not-oauth-format' }),
    );
    assert.equal(result, null);
  });
});

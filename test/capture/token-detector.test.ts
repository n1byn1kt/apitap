// test/capture/token-detector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRefreshableToken, detectRefreshableTokens } from '../../src/capture/token-detector.js';

describe('isRefreshableToken', () => {
  it('should detect csrf_token with hex value', () => {
    assert.equal(isRefreshableToken('csrf_token', '89f1d8b1568692c9160dee459f4ae000'), true);
  });

  it('should detect xsrf-token with hex value', () => {
    assert.equal(isRefreshableToken('xsrf-token', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'), true);
  });

  it('should detect _token suffix with base64 value', () => {
    assert.equal(isRefreshableToken('session_token', 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='), true);
  });

  it('should detect nonce with hex value', () => {
    assert.equal(isRefreshableToken('nonce', 'deadbeefcafe12345678901234567890'), true);
  });

  it('should NOT detect accessToken (user credential)', () => {
    assert.equal(isRefreshableToken('accessToken', '89f1d8b1568692c9160dee459f4ae000'), false);
  });

  it('should NOT detect access_token (user credential)', () => {
    assert.equal(isRefreshableToken('access_token', '89f1d8b1568692c9160dee459f4ae000'), false);
  });

  it('should NOT detect authToken (user credential)', () => {
    assert.equal(isRefreshableToken('authToken', '89f1d8b1568692c9160dee459f4ae000'), false);
  });

  it('should NOT detect apiToken (user credential)', () => {
    assert.equal(isRefreshableToken('api_token', '89f1d8b1568692c9160dee459f4ae000'), false);
  });

  it('should NOT detect short values', () => {
    assert.equal(isRefreshableToken('csrf_token', 'abc123'), false);
  });

  it('should NOT detect plaintext values', () => {
    assert.equal(isRefreshableToken('csrf_token', 'this is not a token value'), false);
  });
});

describe('detectRefreshableTokens', () => {
  it('should detect csrf_token at top level', () => {
    const body = { csrf_token: '89f1d8b1568692c9160dee459f4ae000', name: 'test' };
    const result = detectRefreshableTokens(body);
    assert.deepEqual(result, ['csrf_token']);
  });

  it('should detect nested tokens', () => {
    const body = {
      data: {
        xsrf_token: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      },
      user: 'test',
    };
    const result = detectRefreshableTokens(body);
    assert.deepEqual(result, ['data.xsrf_token']);
  });

  it('should detect multiple tokens', () => {
    const body = {
      csrf_token: '89f1d8b1568692c9160dee459f4ae000',
      nonce: 'deadbeefcafe12345678901234567890',
    };
    const result = detectRefreshableTokens(body);
    assert.deepEqual(result.sort(), ['csrf_token', 'nonce']);
  });

  it('should return empty array when no tokens found', () => {
    const body = { name: 'test', count: 42 };
    const result = detectRefreshableTokens(body);
    assert.deepEqual(result, []);
  });

  it('should handle string body', () => {
    const result = detectRefreshableTokens('not a json object');
    assert.deepEqual(result, []);
  });
});

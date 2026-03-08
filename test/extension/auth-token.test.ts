// test/extension/auth-token.test.ts
// Verifies auth token extraction and passthrough from observer

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthToken, processCompletedRequest } from '../../extension/src/observer.js';

describe('extractAuthToken', () => {
  it('extracts Bearer token from authorization header', () => {
    const token = extractAuthToken({ authorization: 'Bearer eyJhbGci...' });
    assert.deepEqual(token, { header: 'authorization', value: 'Bearer eyJhbGci...' });
  });

  it('extracts API key from x-api-key header', () => {
    const token = extractAuthToken({ 'x-api-key': 'sk-abc123' });
    assert.deepEqual(token, { header: 'x-api-key', value: 'sk-abc123' });
  });

  it('returns undefined for cookie-only auth (too broad)', () => {
    const token = extractAuthToken({ cookie: 'session=abc' });
    assert.equal(token, undefined);
  });

  it('returns undefined when no auth headers present', () => {
    const token = extractAuthToken({ 'content-type': 'application/json' });
    assert.equal(token, undefined);
  });

  it('prefers Authorization over x-api-key', () => {
    const token = extractAuthToken({
      authorization: 'Bearer xyz',
      'x-api-key': 'sk-abc',
    });
    assert.equal(token!.header, 'authorization');
  });
});

describe('processCompletedRequest authToken passthrough', () => {
  it('includes authToken in observation when authTokenOverride provided', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
      authTypeOverride: 'Bearer',
      authTokenOverride: { header: 'authorization', value: 'Bearer eyJhbGci...' },
    });
    assert.ok(result);
    assert.deepEqual(result!.authToken, { header: 'authorization', value: 'Bearer eyJhbGci...' });
  });

  it('omits authToken when authTokenOverride not provided', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.equal(result!.authToken, undefined);
  });
});

describe('native host save_auth message format', () => {
  it('produces correct message for Bearer token', () => {
    const token = { header: 'authorization', value: 'Bearer eyJhbGci...' };
    const message = {
      action: 'save_auth',
      domain: 'api.example.com',
      authHeader: token.header,
      authValue: token.value,
    };
    assert.equal(message.action, 'save_auth');
    assert.equal(message.authHeader, 'authorization');
    assert.equal(message.authValue, 'Bearer eyJhbGci...');
  });

  it('derives correct auth type from header name', () => {
    function deriveType(header: string, value: string): string {
      const headerLower = header.toLowerCase();
      return headerLower === 'authorization'
        ? (value.startsWith('Bearer ') ? 'bearer' : 'api-key')
        : headerLower === 'x-api-key' ? 'api-key'
        : headerLower === 'cookie' ? 'cookie'
        : 'custom';
    }

    assert.equal(deriveType('authorization', 'Bearer xyz'), 'bearer');
    assert.equal(deriveType('authorization', 'Basic abc'), 'api-key');
    assert.equal(deriveType('x-api-key', 'sk-abc'), 'api-key');
    assert.equal(deriveType('cookie', 'session=x'), 'cookie');
    assert.equal(deriveType('x-custom-auth', 'token'), 'custom');
  });
});

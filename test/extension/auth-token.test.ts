// test/extension/auth-token.test.ts
// Verifies auth token extraction and passthrough from observer

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthToken, extractAuthTokens, processCompletedRequest } from '../../extension/src/observer.js';

describe('extractAuthToken (legacy single-header)', () => {
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

describe('extractAuthTokens (v1.5.1 multi-header)', () => {
  it('returns all matching auth headers', () => {
    const tokens = extractAuthTokens({
      authorization: 'OAuth xyz',
      'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    });
    assert.equal(tokens.length, 2);
    assert.deepEqual(tokens[0], { header: 'authorization', value: 'OAuth xyz' });
    assert.deepEqual(tokens[1], { header: 'client-id', value: 'kimne78kx3ncx6brgo4mv6wki5h1ko' });
  });

  it('returns empty array when no auth headers present', () => {
    const tokens = extractAuthTokens({ 'content-type': 'application/json' });
    assert.deepEqual(tokens, []);
  });

  it('captures x-auth-token header', () => {
    const tokens = extractAuthTokens({ 'x-auth-token': 'abc123' });
    assert.equal(tokens.length, 1);
    assert.deepEqual(tokens[0], { header: 'x-auth-token', value: 'abc123' });
  });

  it('captures Client-ID with various casings', () => {
    const tokens = extractAuthTokens({ 'Client-ID': 'test-id' });
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].header, 'client-id');
  });

  it('returns single header when only one matches', () => {
    const tokens = extractAuthTokens({ authorization: 'Bearer xyz' });
    assert.equal(tokens.length, 1);
    assert.deepEqual(tokens[0], { header: 'authorization', value: 'Bearer xyz' });
  });

  it('skips cookies (too broad and session-specific)', () => {
    const tokens = extractAuthTokens({ cookie: 'session=abc', authorization: 'Bearer xyz' });
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].header, 'authorization');
  });
});

describe('processCompletedRequest authTokens passthrough', () => {
  it('includes authTokens in observation when authTokensOverride provided', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
      authTypeOverride: 'Bearer',
      authTokensOverride: [
        { header: 'authorization', value: 'Bearer eyJhbGci...' },
        { header: 'client-id', value: 'test-client' },
      ],
    });
    assert.ok(result);
    assert.equal(result!.authTokens!.length, 2);
    assert.deepEqual(result!.authTokens![0], { header: 'authorization', value: 'Bearer eyJhbGci...' });
    assert.deepEqual(result!.authTokens![1], { header: 'client-id', value: 'test-client' });
  });

  it('omits authTokens when authTokensOverride not provided', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.equal(result!.authTokens, undefined);
  });

  it('omits authTokens when authTokensOverride is empty', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
      authTokensOverride: [],
    });
    assert.ok(result);
    assert.equal(result!.authTokens, undefined);
  });
});

describe('native host save_auth multi-header message format', () => {
  it('produces correct multi-header message for Twitch', () => {
    const tokens = [
      { header: 'authorization', value: 'OAuth xyz' },
      { header: 'client-id', value: 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
    ];
    const message = {
      action: 'save_auth',
      domain: 'gql.twitch.tv',
      headers: tokens,
    };
    assert.equal(message.action, 'save_auth');
    assert.equal(message.headers.length, 2);
    assert.equal(message.headers[0].header, 'authorization');
    assert.equal(message.headers[1].header, 'client-id');
  });

  it('derives correct auth type from primary header', () => {
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
    assert.equal(deriveType('authorization', 'OAuth xyz'), 'api-key');
    assert.equal(deriveType('x-api-key', 'sk-abc'), 'api-key');
    assert.equal(deriveType('cookie', 'session=x'), 'cookie');
    assert.equal(deriveType('x-custom-auth', 'token'), 'custom');
  });
});

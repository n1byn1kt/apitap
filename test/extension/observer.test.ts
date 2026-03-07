import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processCompletedRequest } from '../../extension/src/observer.js';

describe('observer processCompletedRequest', () => {
  it('returns null for non-JSON responses', () => {
    const result = processCompletedRequest({
      url: 'https://example.com/page.html',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'text/html',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result, null);
  });

  it('returns null for sensitive paths', () => {
    const result = processCompletedRequest({
      url: 'https://example.com/api/login',
      method: 'POST',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result, null);
  });

  it('returns null for blocked URLs (private IPs)', () => {
    const result = processCompletedRequest({
      url: 'http://192.168.1.1/api/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result, null);
  });

  it('processes a valid JSON API response', () => {
    const result = processCompletedRequest({
      url: 'https://discord.com/api/v10/channels/12345',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { authorization: 'Bearer xyz' },
      responseHeaders: { 'content-length': '1234' },
    });
    assert.ok(result);
    assert.equal(result!.domain, 'discord.com');
    assert.equal(result!.endpoint.path, '/api/v10/channels/:id');
    assert.deepEqual(result!.endpoint.methods, ['GET']);
    assert.equal(result!.endpoint.authType, 'Bearer');
    assert.equal(result!.endpoint.hasBody, true);
    assert.equal(result!.endpoint.hits, 1);
  });

  it('parameterizes UUIDs in paths', () => {
    const result = processCompletedRequest({
      url: 'https://api.github.com/repos/a1b2c3d4-e5f6-7890-abcd-ef1234567890/issues',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.equal(result!.endpoint.path, '/repos/:id/issues');
  });

  it('detects Bearer auth from Authorization header', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { authorization: 'Bearer eyJhbGci...' },
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.authType, 'Bearer');
  });

  it('detects API Key auth from x-api-key header', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { 'x-api-key': 'sk-abc123' },
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.authType, 'API Key');
  });

  it('detects Cookie auth', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { cookie: 'session=abc123' },
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.authType, 'Cookie');
  });

  it('extracts query parameter names (never values)', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/search?q=hello&limit=10&offset=0',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.deepEqual(result!.endpoint.queryParamNames, ['limit', 'offset', 'q']);
  });

  it('detects cursor pagination from Link header', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/items',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: { link: '<https://api.example.com/items?cursor=abc>; rel="next"' },
    });
    assert.equal(result!.endpoint.pagination, 'cursor');
  });

  it('detects offset pagination from query params', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/items?offset=20&limit=10',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.pagination, 'offset');
  });

  it('flags POST /graphql as graphql type', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/graphql',
      method: 'POST',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.equal(result!.endpoint.type, 'graphql');
  });

  it('uses authTypeOverride when provided, ignoring requestHeaders', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { authorization: 'Bearer should-be-ignored' },
      responseHeaders: {},
      authTypeOverride: 'API Key',
    });
    assert.equal(result!.endpoint.authType, 'API Key');
  });

  it('detects hasBody from content-length > 0', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: { 'content-length': '0' },
    });
    assert.equal(result!.endpoint.hasBody, false);
  });
});

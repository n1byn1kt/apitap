// test/types/types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedExchange, SkillEndpoint, RequestBody } from '../../src/types.js';

describe('CapturedExchange type', () => {
  it('supports optional postData field on request', () => {
    const exchange: CapturedExchange = {
      request: {
        url: 'https://example.com/api',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: '{"query": "test"}',
      },
      response: {
        status: 200,
        headers: {},
        body: '{}',
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    };
    assert.equal(exchange.request.postData, '{"query": "test"}');
  });

  it('allows postData to be undefined', () => {
    const exchange: CapturedExchange = {
      request: {
        url: 'https://example.com/api',
        method: 'GET',
        headers: {},
      },
      response: {
        status: 200,
        headers: {},
        body: '{}',
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    };
    assert.equal(exchange.request.postData, undefined);
  });
});

describe('SkillEndpoint type', () => {
  it('supports optional requestBody field', () => {
    const endpoint: SkillEndpoint = {
      id: 'post-graphql-GetPosts',
      method: 'POST',
      path: '/graphql',
      queryParams: {},
      headers: { 'content-type': 'application/json' },
      responseShape: { type: 'object' },
      examples: {
        request: { url: 'https://example.com/graphql', headers: {} },
        responsePreview: null,
      },
      requestBody: {
        contentType: 'application/json',
        template: { query: 'query GetPosts { posts { id } }', variables: {} },
        variables: ['variables.limit', 'variables.after'],
      },
    };
    assert.equal(endpoint.requestBody?.contentType, 'application/json');
    assert.deepEqual(endpoint.requestBody?.variables, ['variables.limit', 'variables.after']);
  });

  it('allows requestBody to be undefined for GET endpoints', () => {
    const endpoint: SkillEndpoint = {
      id: 'get-api-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array' },
      examples: {
        request: { url: 'https://example.com/api/data', headers: {} },
        responsePreview: null,
      },
    };
    assert.equal(endpoint.requestBody, undefined);
  });
});

describe('RequestBody type', () => {
  it('supports string template for non-JSON bodies', () => {
    const body: RequestBody = {
      contentType: 'application/x-www-form-urlencoded',
      template: 'username=:username&password=:password',
      variables: ['username', 'password'],
    };
    assert.equal(typeof body.template, 'string');
  });

  it('supports object template for JSON bodies', () => {
    const body: RequestBody = {
      contentType: 'application/json',
      template: { id: ':id', name: 'static' },
      variables: ['id'],
    };
    assert.equal(typeof body.template, 'object');
  });
});

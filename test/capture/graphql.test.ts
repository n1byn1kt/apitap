// test/capture/graphql.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGraphQLEndpoint,
  parseGraphQLBody,
  extractOperationName,
  detectGraphQLVariables,
} from '../../src/capture/graphql.js';

describe('isGraphQLEndpoint', () => {
  it('detects /graphql path', () => {
    assert.equal(isGraphQLEndpoint('/graphql', 'application/json', null), true);
    assert.equal(isGraphQLEndpoint('/api/graphql', 'application/json', null), true);
    assert.equal(isGraphQLEndpoint('/svc/shreddit/graphql', 'application/json', null), true);
  });

  it('detects application/graphql content type', () => {
    assert.equal(isGraphQLEndpoint('/api', 'application/graphql', null), true);
  });

  it('detects body with query field', () => {
    const body = JSON.stringify({ query: 'query { posts }' });
    assert.equal(isGraphQLEndpoint('/api', 'application/json', body), true);
  });

  it('returns false for non-GraphQL endpoints', () => {
    assert.equal(isGraphQLEndpoint('/api/posts', 'application/json', '{"id": 1}'), false);
    assert.equal(isGraphQLEndpoint('/api/data', 'text/html', null), false);
  });
});

describe('parseGraphQLBody', () => {
  it('extracts query, variables, and operationName', () => {
    const body = JSON.stringify({
      operationName: 'GetPosts',
      query: 'query GetPosts($limit: Int) { posts(limit: $limit) { id } }',
      variables: { limit: 10 },
    });
    const result = parseGraphQLBody(body);
    assert.equal(result?.operationName, 'GetPosts');
    assert.equal(result?.query, 'query GetPosts($limit: Int) { posts(limit: $limit) { id } }');
    assert.deepEqual(result?.variables, { limit: 10 });
  });

  it('handles missing operationName', () => {
    const body = JSON.stringify({
      query: 'query { posts { id } }',
    });
    const result = parseGraphQLBody(body);
    assert.equal(result?.operationName, null);
  });

  it('returns null for invalid JSON', () => {
    const result = parseGraphQLBody('not json');
    assert.equal(result, null);
  });

  it('returns null for non-GraphQL JSON', () => {
    const result = parseGraphQLBody('{"id": 1}');
    assert.equal(result, null);
  });
});

describe('extractOperationName', () => {
  it('extracts name from query string when operationName missing', () => {
    assert.equal(extractOperationName('query GetPosts { posts }', null), 'GetPosts');
    assert.equal(extractOperationName('mutation CreatePost { create }', null), 'CreatePost');
  });

  it('prefers explicit operationName', () => {
    assert.equal(extractOperationName('query GetPosts { posts }', 'CustomName'), 'CustomName');
  });

  it('returns Anonymous for unnamed queries', () => {
    assert.equal(extractOperationName('query { posts }', null), 'Anonymous');
    assert.equal(extractOperationName('{ posts }', null), 'Anonymous');
  });
});

describe('detectGraphQLVariables', () => {
  it('detects variables with dynamic values', () => {
    const vars = { limit: 10, after: 'cursor123456789', name: 'static' };
    const detected = detectGraphQLVariables(vars);
    // Numbers, cursor strings are likely dynamic
    assert.ok(detected.includes('limit'));
    assert.ok(detected.includes('after'));
  });

  it('handles nested variables', () => {
    const vars = { input: { userId: 12345, name: 'test' } };
    const detected = detectGraphQLVariables(vars);
    assert.ok(detected.includes('input.userId'));
  });

  it('returns empty array for empty variables', () => {
    assert.deepEqual(detectGraphQLVariables({}), []);
    assert.deepEqual(detectGraphQLVariables(null), []);
  });
});

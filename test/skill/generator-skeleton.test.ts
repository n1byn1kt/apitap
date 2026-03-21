import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillGenerator } from '../../src/skill/generator.js';
import type { CapturedExchange } from '../../src/types.js';

function makeRequest(overrides: Partial<{ url: string; method: string; headers: Record<string, string>; postData: string }> = {}) {
  return {
    url: overrides.url ?? 'https://api.example.com/users/123?limit=10',
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? { 'content-type': 'application/json' },
    postData: overrides.postData,
  };
}

function makeExchange(url = 'https://api.example.com/users/123'): CapturedExchange {
  return {
    request: { url, method: 'GET', headers: { 'content-type': 'application/json' } },
    response: { status: 200, headers: {}, body: '{"id":123}', contentType: 'application/json' },
    timestamp: new Date().toISOString(),
  };
}

describe('addSkeleton', () => {
  it('creates endpoint with confidence 0.8 and provenance skeleton', () => {
    const gen = new SkillGenerator();
    const ep = gen.addSkeleton(makeRequest());
    assert.ok(ep);
    assert.strictEqual(ep.confidence, 0.8);
    assert.strictEqual(ep.endpointProvenance, 'skeleton');
    assert.strictEqual(ep.method, 'GET');
    assert.strictEqual(ep.path, '/users/:username');
    assert.deepStrictEqual(ep.responseShape, { type: 'unknown' });
    assert.strictEqual(ep.responseBytes, 0);
    assert.strictEqual(ep.examples.responsePreview, null);
  });

  it('extracts query params from URL', () => {
    const gen = new SkillGenerator();
    const ep = gen.addSkeleton(makeRequest({ url: 'https://api.example.com/search?q=test&limit=10' }));
    assert.ok(ep);
    assert.ok(ep.queryParams.q);
    assert.ok(ep.queryParams.limit);
  });

  it('dedup: second skeleton with same path returns null', () => {
    const gen = new SkillGenerator();
    const first = gen.addSkeleton(makeRequest({ url: 'https://api.example.com/users/1' }));
    const second = gen.addSkeleton(makeRequest({ url: 'https://api.example.com/users/2' }));
    assert.ok(first);
    assert.strictEqual(second, null);
  });

  it('returns null when full capture already exists', () => {
    const gen = new SkillGenerator();
    gen.addExchange(makeExchange('https://api.example.com/users/1'));
    const skeleton = gen.addSkeleton(makeRequest({ url: 'https://api.example.com/users/2' }));
    assert.strictEqual(skeleton, null);
  });

  it('full capture replaces existing skeleton', () => {
    const gen = new SkillGenerator();
    const skeleton = gen.addSkeleton(makeRequest({ url: 'https://api.example.com/users/1' }));
    assert.ok(skeleton);
    assert.strictEqual(skeleton.endpointProvenance, 'skeleton');

    const full = gen.addExchange(makeExchange('https://api.example.com/users/2'));
    assert.ok(full);
    // Full capture should NOT be a skeleton
    assert.notStrictEqual(full.endpointProvenance, 'skeleton');
    assert.notDeepStrictEqual(full.responseShape, { type: 'unknown' });
  });

  it('extracts auth from request headers', () => {
    const gen = new SkillGenerator();
    gen.addSkeleton(makeRequest({
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
    }));
    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.ok(ep);
    // Auth header should be scrubbed (not the raw token value)
    assert.notStrictEqual(ep.headers['authorization'], 'Bearer tok123');
  });

  it('handles GraphQL dedup by operation name', () => {
    const gen = new SkillGenerator();
    const ep1 = gen.addSkeleton(makeRequest({
      url: 'https://api.example.com/graphql',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ query: 'query GetUser { user { id } }' }),
    }));
    const ep2 = gen.addSkeleton(makeRequest({
      url: 'https://api.example.com/graphql',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ query: 'query GetUser { user { id name } }' }),
    }));
    assert.ok(ep1);
    assert.strictEqual(ep2, null);
  });
});

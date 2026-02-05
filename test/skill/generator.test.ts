// test/skill/generator.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillGenerator } from '../../src/skill/generator.js';
import type { CapturedExchange } from '../../src/types.js';

function mockExchange(overrides: {
  url?: string;
  method?: string;
  status?: number;
  body?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}): CapturedExchange {
  const url = overrides.url ?? 'https://api.example.com/data';
  return {
    request: {
      url,
      method: overrides.method ?? 'GET',
      headers: overrides.requestHeaders ?? { accept: 'application/json' },
    },
    response: {
      status: overrides.status ?? 200,
      headers: overrides.responseHeaders ?? {},
      body: overrides.body ?? JSON.stringify([{ id: 1, name: 'test' }]),
      contentType: 'application/json',
    },
    timestamp: '2026-02-04T12:00:00.000Z',
  };
}

describe('SkillGenerator', () => {
  it('generates a skill file from captured exchanges', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://api.example.com/api/markets?limit=10',
      body: JSON.stringify([{ id: 1, name: 'BTC', price: 50000 }]),
    }));
    gen.addExchange(mockExchange({
      url: 'https://api.example.com/api/events',
      body: JSON.stringify({ events: [{ id: 1 }] }),
    }));

    const skill = gen.toSkillFile('api.example.com');

    assert.equal(skill.version, '1.1');
    assert.equal(skill.provenance, 'unsigned');
    assert.equal(skill.domain, 'api.example.com');
    assert.equal(skill.endpoints.length, 2);
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('deduplicates endpoints by method + path', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ url: 'https://example.com/api/data?page=1' }));
    gen.addExchange(mockExchange({ url: 'https://example.com/api/data?page=2' }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('generates readable endpoint IDs', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ url: 'https://example.com/api/v1/markets' }));
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/orders',
      method: 'POST',
    }));

    const skill = gen.toSkillFile('example.com');
    const ids = skill.endpoints.map(e => e.id);
    assert.ok(ids.includes('get-api-v1-markets'));
    assert.ok(ids.includes('post-api-orders'));
  });

  it('extracts query parameters', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?q=bitcoin&limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.equal(ep.queryParams['q'].example, 'bitcoin');
    assert.equal(ep.queryParams['limit'].example, '10');
  });

  it('detects array response shape', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'a', price: 100 }]),
    }));

    const skill = gen.toSkillFile('example.com');
    const shape = skill.endpoints[0].responseShape;
    assert.equal(shape.type, 'array');
    assert.deepEqual(shape.fields, ['id', 'name', 'price']);
  });

  it('detects object response shape', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify({ total: 100, items: [] }),
    }));

    const skill = gen.toSkillFile('example.com');
    const shape = skill.endpoints[0].responseShape;
    assert.equal(shape.type, 'object');
    assert.deepEqual(shape.fields, ['total', 'items']);
  });

  it('returns new endpoint from addExchange, null for duplicates', () => {
    const gen = new SkillGenerator();
    const first = gen.addExchange(mockExchange({ url: 'https://example.com/api/data' }));
    const dupe = gen.addExchange(mockExchange({ url: 'https://example.com/api/data?v=2' }));

    assert.notEqual(first, null);
    assert.equal(dupe, null);
  });

  it('filters noisy request headers, keeps meaningful ones', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'accept': 'application/json',
        'authorization': 'Bearer tok123',
        'user-agent': 'Mozilla/5.0 ...',
        'accept-encoding': 'gzip',
        'x-api-key': 'key123',
        'cookie': 'session=abc',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], '[stored]');
    assert.equal(h['x-api-key'], '[stored]');
    assert.equal(h['user-agent'], undefined);
    assert.equal(h['accept-encoding'], undefined);
  });

  it('tracks filtered count', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({}));
    gen.recordFiltered();
    gen.recordFiltered();
    gen.recordFiltered();

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.metadata.filteredCount, 3);
    assert.equal(skill.metadata.captureCount, 1);
  });

  it('replaces auth headers with [stored] placeholder', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'authorization': 'Bearer secret-token',
        'x-api-key': 'secret-key',
        'content-type': 'application/json',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], '[stored]');
    assert.equal(h['x-api-key'], '[stored]');
    assert.equal(h['content-type'], 'application/json');

    // Example headers should also be scrubbed
    const exH = skill.endpoints[0].examples.request.headers;
    assert.equal(exH['authorization'], '[stored]');
    assert.equal(exH['x-api-key'], '[stored]');
  });

  it('exposes extracted auth credentials', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'authorization': 'Bearer secret-token',
      },
    }));

    const extracted = gen.getExtractedAuth();
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].type, 'bearer');
    assert.equal(extracted[0].header, 'authorization');
    assert.equal(extracted[0].value, 'Bearer secret-token');
  });

  it('omits responsePreview by default', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'test' }]),
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].examples.responsePreview, null);
  });

  it('includes responsePreview when enablePreview is true', () => {
    const gen = new SkillGenerator({ enablePreview: true });
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'test' }]),
    }));

    const skill = gen.toSkillFile('example.com');
    assert.deepEqual(skill.endpoints[0].examples.responsePreview, [{ id: 1, name: 'test' }]);
  });

  it('scrubs PII from query param examples', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?email=john@test.com&limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    const params = skill.endpoints[0].queryParams;
    assert.equal(params['email'].example, '[email]');
    assert.equal(params['limit'].example, '10');
  });

  it('scrubs PII from example request URL', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/users/john@test.com/profile',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.ok(skill.endpoints[0].examples.request.url.includes('[email]'));
    assert.ok(!skill.endpoints[0].examples.request.url.includes('john@test.com'));
  });

  it('skips PII scrubbing when scrub is false', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?email=john@test.com',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].queryParams['email'].example, 'john@test.com');
  });
});

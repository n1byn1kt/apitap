import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertOpenAPISpec } from '../../src/skill/openapi-converter.js';
import { mergeSkillFile } from '../../src/skill/merge.js';

describe('OpenAPI import integration', () => {
  const apisGuruSpec = {
    openapi: '3.0.0',
    info: { title: 'APIs.guru', version: '2.2.0', description: 'Wikipedia for Web APIs' },
    servers: [{ url: 'https://api.apis.guru/v2' }],
    security: [],
    paths: {
      '/metrics.json': {
        get: {
          operationId: 'getMetrics',
          summary: 'Get basic metrics',
          responses: {
            '200': { content: { 'application/json': { schema: { type: 'object', properties: { numSpecs: { type: 'integer' }, numAPIs: { type: 'integer' }, numEndpoints: { type: 'integer' } } } } } },
          },
        },
      },
      '/providers.json': {
        get: {
          operationId: 'getProviders',
          summary: 'List all providers',
          responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array' } } } } } } },
        },
      },
    },
  };

  it('converts APIs.guru spec and merges into empty skill file', () => {
    const result = convertOpenAPISpec(apisGuruSpec, 'https://api.apis.guru/v2/openapi.json');
    assert.strictEqual(result.domain, 'api.apis.guru');
    assert.strictEqual(result.endpoints.length, 2);

    const { skillFile, diff } = mergeSkillFile(null, result.endpoints, result.meta);
    assert.strictEqual(diff.added, 2);
    assert.strictEqual(skillFile.endpoints.length, 2);

    // Verify paths include base path
    const metrics = skillFile.endpoints.find(e => e.id.includes('getmetrics'));
    assert.ok(metrics);
    assert.strictEqual(metrics.path, '/v2/metrics.json');
    assert.strictEqual(metrics.endpointProvenance, 'openapi-import');
    assert.ok((metrics.confidence ?? 1.0) > 0.6);
  });

  it('second import is idempotent', () => {
    const result = convertOpenAPISpec(apisGuruSpec, 'https://api.apis.guru/v2/openapi.json');
    const first = mergeSkillFile(null, result.endpoints, result.meta);
    const second = mergeSkillFile(first.skillFile, result.endpoints, result.meta);
    assert.strictEqual(second.diff.added, 0);
    assert.strictEqual(second.diff.skipped, 2);
  });

  it('merge preserves captured endpoints and fills gaps', () => {
    // Simulate a captured skill file with one endpoint
    const captured = {
      version: '1.2' as const, domain: 'api.apis.guru',
      capturedAt: new Date().toISOString(), baseUrl: 'https://api.apis.guru',
      endpoints: [{
        id: 'get-getmetrics', method: 'GET', path: '/v2/metrics.json',
        queryParams: {}, headers: { 'user-agent': 'test' },
        responseShape: { type: 'object', fields: ['numAPIs'] },
        examples: { request: { url: 'https://api.apis.guru/v2/metrics.json', headers: {} }, responsePreview: { numAPIs: 2500 } },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self' as const,
    };

    const result = convertOpenAPISpec(apisGuruSpec, 'https://api.apis.guru/v2/openapi.json');
    const { skillFile, diff } = mergeSkillFile(captured, result.endpoints, result.meta);

    // Captured endpoint preserved or enriched, new one added
    assert.strictEqual(diff.added, 1); // getProviders is new
    assert.ok(diff.preserved + diff.enriched >= 1); // getMetrics kept
    assert.strictEqual(skillFile.endpoints.length, 2);

    // Captured endpoint keeps its original responsePreview
    const metrics = skillFile.endpoints.find(e => e.id === 'get-getmetrics');
    assert.ok(metrics);
    assert.deepStrictEqual(metrics.examples.responsePreview, { numAPIs: 2500 });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRef, extractDomainAndBasePath } from '../../src/skill/openapi-converter.js';

describe('resolveRef', () => {
  it('resolves a simple $ref like #/components/schemas/User', () => {
    const spec = {
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
            },
          },
        },
      },
    };

    const result = resolveRef({ $ref: '#/components/schemas/User' }, spec);

    assert.deepEqual(result, spec.components.schemas.User);
  });

  it('returns input unchanged if no $ref present', () => {
    const spec = {};
    const obj = { type: 'string', description: 'A plain string' };

    const result = resolveRef(obj, spec);

    assert.deepEqual(result, obj);
  });

  it('returns null on circular $ref (A -> B -> A)', () => {
    const spec = {
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/A' },
        },
      },
    };

    const result = resolveRef({ $ref: '#/components/schemas/A' }, spec);

    assert.equal(result, null);
  });

  it('handles deeply nested $ref chain (9 levels deep, within limit)', () => {
    // Build a chain: Level1 -> Level2 -> ... -> Level9 -> { type: 'string' }
    const spec: Record<string, any> = { components: { schemas: {} } };
    const schemas = spec.components.schemas;

    schemas['Level9'] = { type: 'string', description: 'leaf' };
    for (let i = 8; i >= 1; i--) {
      schemas[`Level${i}`] = { $ref: `#/components/schemas/Level${i + 1}` };
    }

    const result = resolveRef({ $ref: '#/components/schemas/Level1' }, spec);

    assert.deepEqual(result, { type: 'string', description: 'leaf' });
  });

  it('merges allOf properties from multiple entries', () => {
    const spec = {
      components: {
        schemas: {
          Base: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
            },
            required: ['id'],
          },
          Extra: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
            description: 'Extra fields',
          },
        },
      },
    };

    const result = resolveRef(
      {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { $ref: '#/components/schemas/Extra' },
        ],
      },
      spec,
    );

    assert.equal(result?.type, 'object');
    assert.ok(result?.properties?.id, 'should have id from Base');
    assert.ok(result?.properties?.name, 'should have name from Extra');
    assert.deepEqual(result?.required, ['id', 'name']);
    assert.equal(result?.description, 'Extra fields');
  });

  it('returns null for $ref pointing to nonexistent path', () => {
    const spec = {
      components: {
        schemas: {},
      },
    };

    const result = resolveRef({ $ref: '#/components/schemas/DoesNotExist' }, spec);

    assert.equal(result, null);
  });
});

describe('extractDomainAndBasePath', () => {
  it('extracts from absolute OpenAPI 3.x server URL', () => {
    const spec = { openapi: '3.0.0', servers: [{ url: 'https://api.stripe.com/v1' }] };
    const result = extractDomainAndBasePath(spec, 'https://example.com/spec.json');
    assert.strictEqual(result.domain, 'api.stripe.com');
    assert.strictEqual(result.basePath, '/v1');
  });

  it('extracts from relative server URL using specUrl', () => {
    const spec = { openapi: '3.0.0', servers: [{ url: '/v1' }] };
    const result = extractDomainAndBasePath(spec, 'https://api.apis.guru/v2/specs/stripe.com/spec.json');
    assert.strictEqual(result.basePath, '/v1');
    assert.strictEqual(result.domain, 'api.apis.guru');
  });

  it('uses x-providerName for relative server URL when available', () => {
    const spec = { openapi: '3.0.0', servers: [{ url: '/v1' }], info: { 'x-providerName': 'stripe.com' } };
    const result = extractDomainAndBasePath(spec, 'https://api.apis.guru/v2/specs/stripe.com/spec.json');
    assert.strictEqual(result.domain, 'stripe.com');
  });

  it('extracts from Swagger 2.0 host + basePath', () => {
    const spec = { swagger: '2.0', host: 'petstore.swagger.io', basePath: '/v2' };
    const result = extractDomainAndBasePath(spec, 'https://example.com/spec.json');
    assert.strictEqual(result.domain, 'petstore.swagger.io');
    assert.strictEqual(result.basePath, '/v2');
  });

  it('falls back to specUrl when no servers or host', () => {
    const spec = { openapi: '3.0.0', paths: {} };
    const result = extractDomainAndBasePath(spec, 'https://my-api.example.com/openapi.json');
    assert.strictEqual(result.domain, 'my-api.example.com');
    assert.strictEqual(result.basePath, '');
  });
});

import { computeConfidence, detectAuth, generateEndpointId } from '../../src/skill/openapi-converter.js';

describe('computeConfidence', () => {
  it('returns 0.85 for GET + open + examples', () => {
    assert.strictEqual(computeConfidence({ method: 'GET', hasExamples: true, requiresAuth: false }), 0.85);
  });
  it('returns 0.6 for POST + auth + no examples', () => {
    assert.strictEqual(computeConfidence({ method: 'POST', hasExamples: false, requiresAuth: true }), 0.6);
  });
  it('returns 0.75 for GET + auth + examples', () => {
    assert.strictEqual(computeConfidence({ method: 'GET', hasExamples: true, requiresAuth: true }), 0.75);
  });
  it('caps at 0.85', () => {
    assert.ok(computeConfidence({ method: 'GET', hasExamples: true, requiresAuth: false }) <= 0.85);
  });
});

describe('detectAuth', () => {
  it('detects bearer from OpenAPI 3.x', () => {
    const spec = { components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ BearerAuth: [] }] };
    const result = detectAuth(spec);
    assert.strictEqual(result.requiresAuth, true);
    assert.strictEqual(result.authType, 'bearer');
  });
  it('detects apiKey from Swagger 2.0', () => {
    const spec = { securityDefinitions: { api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }, security: [{ api_key: [] }] };
    assert.strictEqual(detectAuth(spec).authType, 'apiKey');
  });
  it('returns no auth when no security defined', () => {
    assert.strictEqual(detectAuth({ security: [], paths: {} }).requiresAuth, false);
  });
  it('detects oauth2', () => {
    const spec = { components: { securitySchemes: { OAuth: { type: 'oauth2' } } }, security: [{ OAuth: [] }] };
    assert.strictEqual(detectAuth(spec).authType, 'oauth2');
  });
});

describe('generateEndpointId', () => {
  it('uses method-operationId convention', () => {
    assert.strictEqual(generateEndpointId('get', '/users', 'listUsers', new Set()), 'get-listusers');
  });
  it('slugifies operationId', () => {
    assert.strictEqual(generateEndpointId('post', '/users', 'createUser.v2', new Set()), 'post-createuser-v2');
  });
  it('falls back to method-path when no operationId', () => {
    assert.strictEqual(generateEndpointId('get', '/users/:id/posts', undefined, new Set()), 'get-users-posts');
  });
  it('deduplicates with numeric suffix', () => {
    const seen = new Set(['get-listusers']);
    assert.strictEqual(generateEndpointId('get', '/users', 'listUsers', seen), 'get-listusers-2');
  });
  it('truncates to 80 chars', () => {
    const longId = 'a'.repeat(100);
    const result = generateEndpointId('get', '/x', longId, new Set());
    assert.ok(result.length <= 80);
  });
});

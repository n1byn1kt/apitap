// test/skill/merge.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, mergeSkillFile } from '../../src/skill/merge.js';
import type { SkillEndpoint, SkillFile, ImportMeta } from '../../src/types.js';

// ---- Helpers ----------------------------------------------------------------

function makeEndpoint(overrides: Partial<SkillEndpoint>): SkillEndpoint {
  return {
    id: 'get-test', method: 'GET', path: '/test',
    queryParams: {}, headers: {},
    responseShape: { type: 'unknown' },
    examples: { request: { url: 'https://test.com/test', headers: {} }, responsePreview: null },
    ...overrides,
  };
}

function makeSkillFile(endpoints: SkillEndpoint[]): SkillFile {
  return {
    version: '1.2', domain: 'test.com',
    capturedAt: new Date().toISOString(), baseUrl: 'https://test.com',
    endpoints,
    metadata: { captureCount: endpoints.length, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self',
  };
}

const testMeta: ImportMeta = {
  specUrl: 'https://example.com/spec.json', specVersion: 'openapi3',
  title: 'Test', description: '', requiresAuth: false, endpointCount: 1,
};

// ---- normalizePath ----------------------------------------------------------

describe('normalizePath', () => {
  it('replaces :paramName placeholders with :_', () => {
    assert.equal(normalizePath('/repos/:owner/:repo'), '/repos/:_/:_');
  });

  it('replaces single :param', () => {
    assert.equal(normalizePath('/users/:userId/profile'), '/users/:_/profile');
  });

  it('leaves paths without params unchanged', () => {
    assert.equal(normalizePath('/users/list'), '/users/list');
  });

  it('leaves root path unchanged', () => {
    assert.equal(normalizePath('/'), '/');
  });
});

// ---- mergeSkillFile ---------------------------------------------------------

describe('mergeSkillFile — null existing', () => {
  it('adds all endpoints when no existing file (null)', () => {
    const imported = [
      makeEndpoint({ id: 'get-users', method: 'GET', path: '/users', endpointProvenance: 'openapi-import' }),
      makeEndpoint({ id: 'post-users', method: 'POST', path: '/users', endpointProvenance: 'openapi-import' }),
    ];
    const result = mergeSkillFile(null, imported, testMeta);
    assert.equal(result.skillFile.endpoints.length, 2);
    assert.equal(result.diff.added, 2);
    assert.equal(result.diff.preserved, 0);
    assert.equal(result.diff.enriched, 0);
    assert.equal(result.diff.skipped, 0);
  });

  it('creates a SkillFile with correct domain from importMeta specUrl', () => {
    const imported = [makeEndpoint({ id: 'get-test', method: 'GET', path: '/test' })];
    const meta: ImportMeta = { ...testMeta, specUrl: 'https://api.myservice.com/openapi.json' };
    const result = mergeSkillFile(null, imported, meta);
    assert.ok(result.skillFile.version);
    assert.ok(result.skillFile.capturedAt);
    assert.ok(result.skillFile.domain);
  });
});

describe('mergeSkillFile — captured endpoint wins', () => {
  it('preserves captured endpoint when import adds nothing new', () => {
    const captured = makeEndpoint({
      id: 'get-users', method: 'GET', path: '/users',
      confidence: 0.9, endpointProvenance: 'captured',
    });
    const existing = makeSkillFile([captured]);

    const imported = [
      makeEndpoint({ id: 'get-users-spec', method: 'GET', path: '/users', endpointProvenance: 'openapi-import' }),
    ];

    const result = mergeSkillFile(existing, imported, testMeta);
    assert.equal(result.diff.preserved + result.diff.enriched, 1);
    assert.equal(result.diff.added, 0);
    // The endpoint in the result should still have captured provenance
    const ep = result.skillFile.endpoints.find(e => e.method === 'GET' && e.path === '/users');
    assert.ok(ep);
    assert.equal(ep!.endpointProvenance, 'captured');
  });

  it('enriches captured endpoint with specSource + description', () => {
    const captured = makeEndpoint({
      id: 'get-users', method: 'GET', path: '/users',
      confidence: 0.9, endpointProvenance: 'captured',
    });
    const existing = makeSkillFile([captured]);

    const imported = [makeEndpoint({
      id: 'get-users-spec', method: 'GET', path: '/users',
      endpointProvenance: 'openapi-import',
      specSource: 'openapi3',
      description: 'List all users',
    })];

    const result = mergeSkillFile(existing, imported, testMeta);
    assert.equal(result.diff.enriched, 1);
    assert.equal(result.diff.preserved, 0);

    const ep = result.skillFile.endpoints.find(e => e.method === 'GET' && e.path === '/users');
    assert.ok(ep);
    assert.equal(ep!.description, 'List all users');
    assert.equal(ep!.specSource, 'openapi3');
    // Confidence should remain from captured
    assert.equal(ep!.confidence, 0.9);
  });

  it('fills gaps — adds new endpoints not in existing', () => {
    const captured = makeEndpoint({
      id: 'get-users', method: 'GET', path: '/users',
      confidence: 0.9, endpointProvenance: 'captured',
    });
    const existing = makeSkillFile([captured]);

    const imported = [
      makeEndpoint({ id: 'get-users-spec', method: 'GET', path: '/users', endpointProvenance: 'openapi-import' }),
      makeEndpoint({ id: 'post-users-spec', method: 'POST', path: '/users', endpointProvenance: 'openapi-import' }),
      makeEndpoint({ id: 'delete-users-spec', method: 'DELETE', path: '/users/:id', endpointProvenance: 'openapi-import' }),
    ];

    const result = mergeSkillFile(existing, imported, testMeta);
    assert.equal(result.skillFile.endpoints.length, 3);
    assert.equal(result.diff.added, 2);
    // GET /users was already captured, so it's preserved or enriched, not added
    assert.ok(result.diff.preserved + result.diff.enriched === 1);
  });

  it('never downgrades confidence (existing 0.8, import 0.7 → stays 0.8)', () => {
    const captured = makeEndpoint({
      id: 'get-users', method: 'GET', path: '/users',
      confidence: 0.8, endpointProvenance: 'captured',
    });
    const existing = makeSkillFile([captured]);

    const imported = [makeEndpoint({
      id: 'get-users-spec', method: 'GET', path: '/users',
      endpointProvenance: 'openapi-import',
      confidence: 0.7,
    })];

    const result = mergeSkillFile(existing, imported, testMeta);
    const ep = result.skillFile.endpoints.find(e => e.method === 'GET' && e.path === '/users');
    assert.ok(ep);
    assert.equal(ep!.confidence, 0.8);
  });

  it('idempotent re-import — second run all skipped', () => {
    // First import: existing file already has enriched endpoints from a previous import
    const alreadyEnriched = makeEndpoint({
      id: 'get-users', method: 'GET', path: '/users',
      confidence: 0.9, endpointProvenance: 'captured',
      specSource: 'openapi3', description: 'List all users',
    });
    const existingAfterFirstImport = makeSkillFile([alreadyEnriched]);
    // Simulate first import already happened
    existingAfterFirstImport.metadata.importHistory = [{
      specUrl: testMeta.specUrl,
      specVersion: testMeta.specVersion,
      importedAt: new Date().toISOString(),
      endpointsAdded: 0,
      endpointsEnriched: 1,
    }];

    const imported = [makeEndpoint({
      id: 'get-users-spec', method: 'GET', path: '/users',
      endpointProvenance: 'openapi-import',
      specSource: 'openapi3', description: 'List all users',
    })];

    const result = mergeSkillFile(existingAfterFirstImport, imported, testMeta);
    assert.equal(result.diff.skipped, 1);
    assert.equal(result.diff.enriched, 0);
    assert.equal(result.diff.added, 0);
  });
});

describe('mergeSkillFile — normalizedPath matching', () => {
  it('matches endpoints with different param names via normalizedPath', () => {
    // Existing has :id, import has :userId — both normalize to :_
    const captured = makeEndpoint({
      id: 'get-user', method: 'GET', path: '/users/:id',
      confidence: 0.9, endpointProvenance: 'captured',
    });
    const existing = makeSkillFile([captured]);

    const imported = [makeEndpoint({
      id: 'get-user-spec', method: 'GET', path: '/users/:userId',
      endpointProvenance: 'openapi-import',
      description: 'Get a user by ID',
    })];

    const result = mergeSkillFile(existing, imported, testMeta);
    // Should match as same endpoint and enrich, not add a new one
    assert.equal(result.skillFile.endpoints.length, 1);
    assert.equal(result.diff.added, 0);
    assert.ok(result.diff.preserved + result.diff.enriched === 1);
  });

  it('stores normalizedPath on all endpoints after merge', () => {
    const captured = makeEndpoint({
      id: 'get-user', method: 'GET', path: '/users/:id',
      confidence: 0.9, endpointProvenance: 'captured',
    });
    const existing = makeSkillFile([captured]);

    const imported = [makeEndpoint({
      id: 'get-posts-spec', method: 'GET', path: '/posts/:postId',
      endpointProvenance: 'openapi-import',
    })];

    const result = mergeSkillFile(existing, imported, testMeta);

    for (const ep of result.skillFile.endpoints) {
      assert.ok(ep.normalizedPath !== undefined, `endpoint ${ep.id} should have normalizedPath`);
    }

    // Verify correct normalization
    const userEp = result.skillFile.endpoints.find(e => e.path === '/users/:id');
    const postEp = result.skillFile.endpoints.find(e => e.path === '/posts/:postId');
    assert.equal(userEp!.normalizedPath, '/users/:_');
    assert.equal(postEp!.normalizedPath, '/posts/:_');
  });
});

describe('mergeSkillFile — import history', () => {
  it('appends import history to metadata', () => {
    const existing = makeSkillFile([
      makeEndpoint({ id: 'get-users', method: 'GET', path: '/users', endpointProvenance: 'captured' }),
    ]);

    const imported = [makeEndpoint({
      id: 'get-users-spec', method: 'GET', path: '/users',
      endpointProvenance: 'openapi-import',
      description: 'List all users',
    })];

    const result = mergeSkillFile(existing, imported, testMeta);
    const history = result.skillFile.metadata.importHistory;
    assert.ok(history, 'importHistory should exist');
    assert.equal(history!.length, 1);
    assert.equal(history![0].specUrl, testMeta.specUrl);
    assert.equal(history![0].specVersion, testMeta.specVersion);
    assert.ok(history![0].importedAt);
    assert.equal(typeof history![0].endpointsAdded, 'number');
    assert.equal(typeof history![0].endpointsEnriched, 'number');
  });

  it('appends to existing import history on re-import', () => {
    const existing = makeSkillFile([
      makeEndpoint({ id: 'get-users', method: 'GET', path: '/users', endpointProvenance: 'captured' }),
    ]);
    existing.metadata.importHistory = [{
      specUrl: 'https://other.com/spec.json',
      specVersion: 'openapi3',
      importedAt: new Date().toISOString(),
      endpointsAdded: 0,
      endpointsEnriched: 1,
    }];

    const imported = [makeEndpoint({
      id: 'get-users-spec', method: 'GET', path: '/users',
      endpointProvenance: 'openapi-import',
    })];

    const result = mergeSkillFile(existing, imported, testMeta);
    const history = result.skillFile.metadata.importHistory;
    assert.ok(history);
    assert.equal(history!.length, 2);
  });
});

describe('skeleton merge behavior', () => {
  it('import enriches skeleton: adds response shape, keeps skeleton provenance', () => {
    const skeletonEp = makeEndpoint({
      id: 'get-users', path: '/users', confidence: 0.8,
      endpointProvenance: 'skeleton' as const,
      responseShape: { type: 'unknown' },
    });
    const existing = makeSkillFile([skeletonEp]);

    const importedEp = makeEndpoint({
      id: 'get-users', path: '/users', confidence: 0.85,
      endpointProvenance: 'openapi-import' as const,
      responseShape: { type: 'object', fields: ['id', 'name', 'email'] },
      description: 'List all users',
      specSource: 'https://example.com/spec.json',
    });

    const result = mergeSkillFile(existing, [importedEp], testMeta);
    assert.strictEqual(result.diff.enriched, 1);
    const ep = result.skillFile.endpoints[0];
    assert.strictEqual(ep.endpointProvenance, 'skeleton');
    assert.strictEqual(ep.confidence, 0.85); // max(0.8, 0.85)
    assert.deepStrictEqual(ep.responseShape, { type: 'object', fields: ['id', 'name', 'email'] });
    assert.strictEqual(ep.description, 'List all users');
    assert.strictEqual(ep.specSource, 'https://example.com/spec.json');
  });

  it('skeleton + lower confidence import → confidence stays at 0.8', () => {
    const skeletonEp = makeEndpoint({
      id: 'get-users', path: '/users', confidence: 0.8,
      endpointProvenance: 'skeleton' as const,
    });
    const existing = makeSkillFile([skeletonEp]);

    const importedEp = makeEndpoint({
      id: 'get-users', path: '/users', confidence: 0.7,
      endpointProvenance: 'openapi-import' as const,
      description: 'List users',
    });

    const result = mergeSkillFile(existing, [importedEp], testMeta);
    assert.strictEqual(result.diff.enriched, 1);
    const ep = result.skillFile.endpoints[0];
    assert.strictEqual(ep.confidence, 0.8); // max(0.8, 0.7)
    assert.strictEqual(ep.description, 'List users');
  });
});

describe('mergeSkillFile — query param merge', () => {
  it('merges query param schema: keeps captured example, adds spec enum/required', () => {
    const captured = makeEndpoint({
      id: 'get-search', method: 'GET', path: '/search',
      confidence: 0.9, endpointProvenance: 'captured',
      queryParams: {
        sort: { type: 'string', example: 'created_at' },
        limit: { type: 'string', example: '10' },
      },
    });
    const existing = makeSkillFile([captured]);

    const imported = [makeEndpoint({
      id: 'get-search-spec', method: 'GET', path: '/search',
      endpointProvenance: 'openapi-import',
      queryParams: {
        sort: { type: 'string', example: 'name', enum: ['name', 'created_at', 'updated_at'], required: true, fromSpec: true },
        limit: { type: 'integer', example: '20', required: false, fromSpec: true },
        page: { type: 'integer', example: '1', required: false, fromSpec: true },
      },
    })];

    const result = mergeSkillFile(existing, imported, testMeta);
    const ep = result.skillFile.endpoints.find(e => e.method === 'GET' && e.path === '/search');
    assert.ok(ep);

    // Captured example should be preserved
    assert.equal(ep!.queryParams['sort'].example, 'created_at');
    assert.equal(ep!.queryParams['limit'].example, '10');

    // Spec enum/required should be added
    assert.deepEqual(ep!.queryParams['sort'].enum, ['name', 'created_at', 'updated_at']);
    assert.equal(ep!.queryParams['sort'].required, true);

    // Type from spec for limit (spec wins on type when captured has generic 'string')
    assert.equal(ep!.queryParams['limit'].type, 'integer');

    // New param from spec should be added
    assert.ok(ep!.queryParams['page'], 'page param from spec should be added');
    assert.equal(ep!.queryParams['page'].example, '1');
  });

  it('caps merged result at 500 endpoints, keeping captured first', () => {
    // Existing file with 300 captured endpoints
    const existingEndpoints = Array.from({ length: 300 }, (_, i) =>
      makeEndpoint({ id: `captured-${i}`, method: 'GET', path: `/captured/${i}`, endpointProvenance: 'captured', confidence: 1.0 }),
    );
    const existing = makeSkillFile(existingEndpoints);

    // Import 300 more — merge would produce 600, must be capped to 500
    const imported = Array.from({ length: 300 }, (_, i) =>
      makeEndpoint({ id: `imported-${i}`, method: 'GET', path: `/imported/${i}`, endpointProvenance: 'openapi-import', confidence: 0.6 }),
    );

    const result = mergeSkillFile(existing, imported, testMeta);
    assert.equal(result.skillFile.endpoints.length, 500, 'should cap at 500');

    // All 300 captured endpoints should be preserved (they sort first)
    const capturedCount = result.skillFile.endpoints.filter(
      ep => ep.endpointProvenance === 'captured',
    ).length;
    assert.equal(capturedCount, 300, 'all captured endpoints preserved');
  });

  it('caps new file at 500 endpoints', () => {
    const imported = Array.from({ length: 600 }, (_, i) =>
      makeEndpoint({ id: `ep-${i}`, method: 'GET', path: `/api/${i}` }),
    );
    const result = mergeSkillFile(null, imported, testMeta);
    assert.equal(result.skillFile.endpoints.length, 500);
  });
});

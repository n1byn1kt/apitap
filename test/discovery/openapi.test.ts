// test/discovery/openapi.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discoverSpecs, parseSpecToSkillFile } from '../../src/discovery/openapi.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

let server: Server;
let baseUrl: string;
let routes: Record<string, { status: number; contentType: string; body: string }>;

function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const route = routes[req.url!];
      if (route) {
        res.writeHead(route.status, { 'Content-Type': route.contentType });
        res.end(route.body);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function teardownServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

const SAMPLE_OPENAPI_3 = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/api/users': {
      get: {
        operationId: 'getUsers',
        summary: 'List users',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create user',
        requestBody: { content: { 'application/json': { schema: {} } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        operationId: 'deleteUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
  },
});

const SAMPLE_SWAGGER_2 = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy API', version: '0.1.0' },
  host: 'api.example.com',
  basePath: '/v1',
  paths: {
    '/items': {
      get: { operationId: 'listItems', responses: { '200': {} } },
    },
  },
});

const skipSsrf = { skipSsrf: true };

describe('discoverSpecs', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  it('finds OpenAPI 3.0 spec at /openapi.json', async () => {
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_OPENAPI_3,
    };

    const specs = await discoverSpecs(baseUrl, undefined, skipSsrf);
    assert.ok(specs.length >= 1);
    const spec = specs.find(s => s.url.includes('/openapi.json'));
    assert.ok(spec);
    assert.equal(spec!.type, 'openapi');
    assert.equal(spec!.version, '3.0.0');
    assert.equal(spec!.endpointCount, 4);
  });

  it('finds Swagger 2.0 spec at /swagger.json', async () => {
    routes['/swagger.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_SWAGGER_2,
    };

    const specs = await discoverSpecs(baseUrl, undefined, skipSsrf);
    assert.ok(specs.length >= 1);
    const spec = specs.find(s => s.url.includes('/swagger.json'));
    assert.ok(spec);
    assert.equal(spec!.type, 'swagger');
    assert.equal(spec!.version, '2.0');
  });

  it('returns empty for sites without specs', async () => {
    const specs = await discoverSpecs(baseUrl, undefined, skipSsrf);
    assert.equal(specs.length, 0);
  });

  it('ignores non-JSON responses', async () => {
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html>Not a spec</html>',
    };

    const specs = await discoverSpecs(baseUrl, undefined, skipSsrf);
    assert.equal(specs.length, 0);
  });

  it('ignores 404 responses', async () => {
    const specs = await discoverSpecs(baseUrl, undefined, skipSsrf);
    assert.equal(specs.length, 0);
  });

  it('discovers specs from Link header', async () => {
    routes['/my-api-spec.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_OPENAPI_3,
    };

    const specs = await discoverSpecs(baseUrl, {
      link: `<${baseUrl}/my-api-spec.json>; rel="describedby"`,
    }, skipSsrf);
    assert.ok(specs.some(s => s.url.includes('/my-api-spec.json')));
  });
});

describe('parseSpecToSkillFile', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  it('parses OpenAPI 3.0 spec into skill file', async () => {
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_OPENAPI_3,
    };

    const skill = await parseSpecToSkillFile(
      `${baseUrl}/openapi.json`,
      '127.0.0.1',
      baseUrl,
      skipSsrf,
    );
    assert.ok(skill);
    assert.equal(skill!.domain, '127.0.0.1');
    assert.equal(skill!.endpoints.length, 4);

    // Check endpoint IDs use operationId
    const getUsers = skill!.endpoints.find(e => e.id === 'get-getusers');
    assert.ok(getUsers);
    assert.equal(getUsers!.method, 'GET');
    assert.equal(getUsers!.path, '/api/users');

    // Check query params extracted
    assert.ok('limit' in getUsers!.queryParams);
    assert.ok('offset' in getUsers!.queryParams);

    // Check path params converted
    const getUser = skill!.endpoints.find(e => e.path === '/api/users/:id' && e.method === 'GET');
    assert.ok(getUser);
  });

  it('parses Swagger 2.0 spec with host/basePath', async () => {
    routes['/swagger.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_SWAGGER_2,
    };

    const skill = await parseSpecToSkillFile(
      `${baseUrl}/swagger.json`,
      'api.example.com',
      baseUrl,
      skipSsrf,
    );
    assert.ok(skill);
    assert.ok(skill!.baseUrl.includes('api.example.com'));
  });

  it('returns null for invalid spec', async () => {
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"not": "a spec"}',
    };

    const skill = await parseSpecToSkillFile(
      `${baseUrl}/openapi.json`,
      'example.com',
      baseUrl,
      skipSsrf,
    );
    assert.equal(skill, null);
  });

  it('returns null for unreachable URL', async () => {
    const skill = await parseSpecToSkillFile(
      'http://127.0.0.1:59999/nonexistent',
      'example.com',
      'http://127.0.0.1:59999',
      skipSsrf,
    );
    assert.equal(skill, null);
  });

  it('sets replayability to unknown with discovered-from-spec signal', async () => {
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_OPENAPI_3,
    };

    const skill = await parseSpecToSkillFile(
      `${baseUrl}/openapi.json`,
      '127.0.0.1',
      baseUrl,
      skipSsrf,
    );
    assert.ok(skill);
    for (const ep of skill!.endpoints) {
      assert.equal(ep.replayability?.tier, 'unknown');
      assert.equal(ep.replayability?.verified, false);
      assert.ok(ep.replayability?.signals.includes('discovered-from-spec'));
    }
  });

  it('sets provenance to unsigned and version to 1.2', async () => {
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: SAMPLE_OPENAPI_3,
    };

    const skill = await parseSpecToSkillFile(
      `${baseUrl}/openapi.json`,
      '127.0.0.1',
      baseUrl,
      skipSsrf,
    );
    assert.ok(skill);
    assert.equal(skill!.provenance, 'unsigned');
    assert.equal(skill!.version, '1.2');
  });
});

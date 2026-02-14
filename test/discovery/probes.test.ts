// test/discovery/probes.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeApiPaths } from '../../src/discovery/probes.js';
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
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html>Not Found</html>');
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

const skipSsrf = { skipSsrf: true };

describe('probeApiPaths', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  it('detects JSON API at /api/', async () => {
    routes['/api/'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"status":"ok"}',
    };

    const results = await probeApiPaths(baseUrl, skipSsrf);
    const apiProbe = results.find(r => r.path === '/api/');
    assert.ok(apiProbe);
    assert.equal(apiProbe!.isApi, true);
    assert.equal(apiProbe!.status, 200);
  });

  it('detects GraphQL endpoint', async () => {
    routes['/graphql'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"data":{"__schema":{"types":[]}}}',
    };

    const results = await probeApiPaths(baseUrl, skipSsrf);
    const gqlProbe = results.find(r => r.path === '/graphql');
    assert.ok(gqlProbe);
    assert.equal(gqlProbe!.isApi, true);
  });

  it('detects auth-gated API (401)', async () => {
    routes['/api/v1/'] = {
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    };

    const results = await probeApiPaths(baseUrl, skipSsrf);
    const probe = results.find(r => r.path === '/api/v1/');
    assert.ok(probe);
    assert.equal(probe!.isApi, true);
    assert.equal(probe!.status, 401);
  });

  it('does not mark HTML 404 as API', async () => {
    const results = await probeApiPaths(baseUrl, skipSsrf);
    assert.equal(results.length, 0);
  });

  it('detects JSON body even without proper content-type', async () => {
    routes['/rest/'] = {
      status: 200,
      contentType: 'text/plain',
      body: '{"items":[1,2,3]}',
    };

    const results = await probeApiPaths(baseUrl, skipSsrf);
    const probe = results.find(r => r.path === '/rest/');
    assert.ok(probe);
    assert.equal(probe!.isApi, true);
  });

  it('detects API at multiple paths', async () => {
    routes['/api/'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"v":"1"}',
    };
    routes['/api/v1/'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"v":"1"}',
    };

    const results = await probeApiPaths(baseUrl, skipSsrf);
    assert.ok(results.length >= 2);
    assert.ok(results.some(r => r.path === '/api/' && r.isApi));
    assert.ok(results.some(r => r.path === '/api/v1/' && r.isApi));
  });

  it('handles connection failures gracefully', async () => {
    const results = await probeApiPaths('http://127.0.0.1:59998', skipSsrf);
    assert.equal(results.length, 0);
  });

  it('detects 403 with JSON as API', async () => {
    routes['/api/'] = {
      status: 403,
      contentType: 'application/json',
      body: '{"error":"forbidden"}',
    };

    const results = await probeApiPaths(baseUrl, skipSsrf);
    const probe = results.find(r => r.path === '/api/');
    assert.ok(probe);
    assert.equal(probe!.isApi, true);
  });
});

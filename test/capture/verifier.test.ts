// test/capture/verifier.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyEndpoints, classifyHeuristic } from '../../src/capture/verifier.js';
import type { SkillFile, SkillEndpoint } from '../../src/types.js';

function makeEndpoint(overrides: Partial<SkillEndpoint> & { id: string; path: string }): SkillEndpoint {
  return {
    method: 'GET',
    queryParams: {},
    headers: {},
    responseShape: { type: 'array', fields: ['id', 'name'] },
    examples: {
      request: { url: '', headers: {} },
      responsePreview: null,
    },
    ...overrides,
  };
}

describe('classifyHeuristic', () => {
  it('classifies public endpoints as green (unverified)', () => {
    const ep = makeEndpoint({ id: 'get-data', path: '/data' });
    const result = classifyHeuristic(ep);
    assert.equal(result.tier, 'green');
    assert.equal(result.verified, false);
  });

  it('classifies auth-required endpoints as yellow', () => {
    const ep = makeEndpoint({
      id: 'get-data',
      path: '/data',
      headers: { authorization: '[stored]' },
    });
    const result = classifyHeuristic(ep);
    assert.equal(result.tier, 'yellow');
    assert.ok(result.signals.includes('auth-required'));
  });

  it('classifies CSRF-protected endpoints as orange', () => {
    const ep = makeEndpoint({
      id: 'post-data',
      path: '/data',
      headers: { 'x-csrf-token': '[stored]' },
    });
    const result = classifyHeuristic(ep);
    assert.equal(result.tier, 'orange');
    assert.ok(result.signals.includes('csrf-token'));
  });
});

describe('verifyEndpoints', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/public') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'test' }]));
      } else if (req.url === '/api/authed') {
        if (req.headers.authorization) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
        }
      } else if (req.url === '/api/broken') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      } else if (req.url === '/api/post-ok' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'created' }));
      } else if (req.url === '/api/post-fail' && req.method === 'POST') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('tags public GET endpoint as green + verified', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'get-api-public',
          path: '/api/public',
          examples: {
            request: { url: `${baseUrl}/api/public`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.3.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill);
    assert.equal(verified.endpoints[0].replayability?.tier, 'green');
    assert.equal(verified.endpoints[0].replayability?.verified, true);
    assert.ok(verified.endpoints[0].replayability?.signals.includes('status-match'));
  });

  it('tags auth-required GET endpoint as yellow + verified', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'get-api-authed',
          path: '/api/authed',
          headers: { authorization: '[stored]' },
          responseShape: { type: 'object', fields: ['ok'] },
          examples: {
            request: { url: `${baseUrl}/api/authed`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.3.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill);
    assert.equal(verified.endpoints[0].replayability?.tier, 'yellow');
    assert.equal(verified.endpoints[0].replayability?.verified, true);
  });

  it('tags errored GET endpoint as orange + verified', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'get-api-broken',
          path: '/api/broken',
          examples: {
            request: { url: `${baseUrl}/api/broken`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.3.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill);
    assert.equal(verified.endpoints[0].replayability?.tier, 'orange');
    assert.equal(verified.endpoints[0].replayability?.verified, true);
  });

  it('verifies POST endpoint when verifyPosts is true', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'post-api-post-ok',
          path: '/api/post-ok',
          method: 'POST',
          responseShape: { type: 'object', fields: ['result'] },
          requestBody: {
            contentType: 'application/json',
            template: { data: 'test' },
            variables: [],
          },
          examples: {
            request: { url: `${baseUrl}/api/post-ok`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill, { verifyPosts: true });
    assert.equal(verified.endpoints[0].replayability?.tier, 'green');
    assert.equal(verified.endpoints[0].replayability?.verified, true);
    assert.ok(verified.endpoints[0].replayability?.signals.includes('status-match'));
  });

  it('tags failing POST endpoint as orange when verifyPosts is true', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'post-api-post-fail',
          path: '/api/post-fail',
          method: 'POST',
          requestBody: {
            contentType: 'application/json',
            template: { data: 'test' },
            variables: [],
          },
          examples: {
            request: { url: `${baseUrl}/api/post-fail`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill, { verifyPosts: true });
    assert.equal(verified.endpoints[0].replayability?.tier, 'orange');
    assert.equal(verified.endpoints[0].replayability?.verified, true);
  });

  it('falls back to heuristic for POST without requestBody when verifyPosts is true', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'post-api-no-body',
          path: '/api/post-ok',
          method: 'POST',
          examples: {
            request: { url: `${baseUrl}/api/post-ok`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill, { verifyPosts: true });
    // No requestBody → falls back to heuristic (unverified)
    assert.equal(verified.endpoints[0].replayability?.verified, false);
  });

  it('uses heuristic classification for non-GET endpoints', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [
        makeEndpoint({
          id: 'post-api-data',
          path: '/api/data',
          method: 'POST',
          examples: {
            request: { url: `${baseUrl}/api/data`, headers: {} },
            responsePreview: null,
          },
        }),
      ],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.3.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill);
    assert.equal(verified.endpoints[0].replayability?.verified, false);
  });

  it('returns skill unchanged when no endpoints', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: 'localhost',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [],
      metadata: { captureCount: 0, filteredCount: 0, toolVersion: '0.3.0' },
      provenance: 'unsigned',
    };

    const verified = await verifyEndpoints(skill);
    assert.deepEqual(verified.endpoints, []);
  });
});

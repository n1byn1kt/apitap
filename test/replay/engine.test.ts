// test/replay/engine.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

describe('replayEndpoint', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/items')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Widget' }, { id: 2, name: 'Gadget' }]));
      } else if (req.url === '/api/item/42') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 42, name: 'Special' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function makeSkill(): SkillFile {
    return {
      version: '1.1',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00.000Z',
      baseUrl,
      endpoints: [
        {
          id: 'get-api-items',
          method: 'GET',
          path: '/api/items',
          queryParams: { limit: { type: 'string', example: '10' } },
          headers: {},
          responseShape: { type: 'array', fields: ['id', 'name'] },
          examples: {
            request: { url: `${baseUrl}/api/items`, headers: {} },
            responsePreview: [],
          },
        },
        {
          id: 'get-api-item-42',
          method: 'GET',
          path: '/api/item/42',
          queryParams: {},
          headers: {},
          responseShape: { type: 'object', fields: ['id', 'name'] },
          examples: {
            request: { url: `${baseUrl}/api/item/42`, headers: {} },
            responsePreview: {},
          },
        },
      ],
      metadata: { captureCount: 2, filteredCount: 0, toolVersion: '0.2.0' },
      provenance: 'unsigned',
    };
  }

  it('replays a GET endpoint and returns JSON', async () => {
    const result = await replayEndpoint(makeSkill(), 'get-api-items');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, [
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Gadget' },
    ]);
  });

  it('replays with query parameters', async () => {
    const result = await replayEndpoint(makeSkill(), 'get-api-items', { limit: '5' });
    assert.equal(result.status, 200);
    // Server ignores params in this test, but the request should succeed
    assert.ok(Array.isArray(result.data));
  });

  it('throws for unknown endpoint ID', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill(), 'nonexistent'),
      { message: /endpoint.*not found/i },
    );
  });
});

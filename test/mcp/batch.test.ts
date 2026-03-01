import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';
import { createMcpServer } from '../../src/mcp.js';

function makeSkill(domain: string, baseUrl: string, endpoints: Array<{ id: string; method: string; path: string }>): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-07T12:00:00.000Z',
    baseUrl,
    endpoints: endpoints.map(ep => ({
      id: ep.id,
      method: ep.method,
      path: ep.path,
      queryParams: {},
      headers: {},
      responseShape: { type: 'object', fields: ['id'] },
      examples: {
        request: { url: `${baseUrl}${ep.path}`, headers: {} },
        responsePreview: null,
      },
      replayability: { tier: 'green' as const, verified: true, signals: [] },
    })),
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self' as const,
  };
}

describe('apitap_replay_batch via MCP', () => {
  let testDir: string;
  let serverA: Server;
  let serverB: Server;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-mcp-batch-'));

    serverA = createHttpServer((req, res) => {
      if (req.url === '/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1 }]));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => serverA.listen(0, r));
    const portA = (serverA.address() as AddressInfo).port;

    serverB = createHttpServer((req, res) => {
      if (req.url === '/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: 99 }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => serverB.listen(0, r));
    const portB = (serverB.address() as AddressInfo).port;

    await writeSkillFile(makeSkill('site-a.test', `http://localhost:${portA}`, [
      { id: 'get-items', method: 'GET', path: '/items' },
    ]), testDir);
    await writeSkillFile(makeSkill('site-b.test', `http://localhost:${portB}`, [
      { id: 'get-data', method: 'GET', path: '/data' },
    ]), testDir);

    const server = createMcpServer({ skillsDir: testDir, _skipSsrfCheck: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    await new Promise<void>(r => serverA.close(() => r()));
    await new Promise<void>(r => serverB.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('tool is registered', async () => {
    const { tools } = await client.listTools();
    const batch = tools.find(t => t.name === 'apitap_replay_batch');
    assert.ok(batch, 'apitap_replay_batch should exist');
    assert.equal(batch.annotations?.readOnlyHint, true);
  });

  it('replays multiple domains in one call', async () => {
    const result = await client.callTool({
      name: 'apitap_replay_batch',
      arguments: {
        requests: [
          { domain: 'site-a.test', endpointId: 'get-items' },
          { domain: 'site-b.test', endpointId: 'get-data' },
        ],
      },
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.length, 2);
    assert.equal(data[0].status, 200);
    assert.deepEqual(data[0].data, [{ id: 1 }]);
    assert.equal(data[0].skillSource, 'disk', `batch result keys: ${Object.keys(data[0]).join(', ')}`);
    assert.equal(data[1].status, 200);
    assert.deepEqual(data[1].data, { value: 99 });
  });

  it('handles partial failures gracefully', async () => {
    const result = await client.callTool({
      name: 'apitap_replay_batch',
      arguments: {
        requests: [
          { domain: 'site-a.test', endpointId: 'get-items' },
          { domain: 'missing.test', endpointId: 'get-stuff' },
        ],
      },
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data[0].status, 200);
    assert.equal(data[1].status, 0);
    assert.ok(data[1].error);
  });
});

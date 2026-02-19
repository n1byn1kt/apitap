// test/mcp/mcp.test.ts
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

function makeSkill(domain: string, baseUrl: string, endpoints: Array<{ id: string; method: string; path: string; tier?: string }>): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-04T12:00:00.000Z',
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
      replayability: {
        tier: (ep.tier ?? 'green') as 'green' | 'yellow' | 'orange' | 'red' | 'unknown',
        verified: true,
        signals: [],
      },
    })),
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.5.0' },
    provenance: 'self',
  };
}

describe('MCP server tool registration', () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const server = createMcpServer();
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
  });

  it('exposes twelve tools', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'apitap_auth_request',
      'apitap_browse',
      'apitap_capture',
      'apitap_capture_finish',
      'apitap_capture_interact',
      'apitap_capture_start',
      'apitap_discover',
      'apitap_peek',
      'apitap_read',
      'apitap_replay',
      'apitap_replay_batch',
      'apitap_search',
    ]);
  });

  it('apitap_auth_request has correct input schema', async () => {
    const { tools } = await client.listTools();
    const authReq = tools.find(t => t.name === 'apitap_auth_request')!;
    assert.ok(authReq, 'apitap_auth_request tool should exist');
    assert.ok(authReq.inputSchema.properties.domain);
    assert.ok(authReq.inputSchema.required.includes('domain'));
    assert.ok(authReq.inputSchema.properties.loginUrl);
    assert.ok(authReq.inputSchema.properties.timeout);
    assert.equal(authReq.annotations?.readOnlyHint, false);
    assert.equal(authReq.annotations?.openWorldHint, true);
  });

  it('apitap_search has correct input schema', async () => {
    const { tools } = await client.listTools();
    const search = tools.find(t => t.name === 'apitap_search')!;
    assert.equal(search.inputSchema.type, 'object');
    assert.ok(search.inputSchema.properties.query);
    assert.ok(search.inputSchema.required.includes('query'));
  });

  it('apitap_replay has correct input schema', async () => {
    const { tools } = await client.listTools();
    const replay = tools.find(t => t.name === 'apitap_replay')!;
    assert.ok(replay.inputSchema.properties.domain);
    assert.ok(replay.inputSchema.properties.endpointId);
    assert.ok(replay.inputSchema.properties.params);
    assert.ok(replay.inputSchema.properties.fresh, 'should have fresh param');
    assert.ok(replay.inputSchema.required.includes('domain'));
    assert.ok(replay.inputSchema.required.includes('endpointId'));
  });

  it('apitap_capture has correct input schema', async () => {
    const { tools } = await client.listTools();
    const cap = tools.find(t => t.name === 'apitap_capture')!;
    assert.ok(cap.inputSchema.properties.url);
    assert.ok(cap.inputSchema.required.includes('url'));
    assert.ok(cap.inputSchema.properties.duration);
  });

  it('apitap_search description explains tier system', async () => {
    const { tools } = await client.listTools();
    const search = tools.find(t => t.name === 'apitap_search')!;
    assert.ok(search.description.includes('green'));
    assert.ok(search.description.includes('yellow'));
    assert.ok(search.description.includes('orange'));
    assert.ok(search.description.includes('red'));
  });

  it('apitap_search has readOnlyHint annotation', async () => {
    const { tools } = await client.listTools();
    const search = tools.find(t => t.name === 'apitap_search')!;
    assert.equal(search.annotations?.readOnlyHint, true);
  });

  it('apitap_replay has readOnlyHint and openWorldHint annotations', async () => {
    const { tools } = await client.listTools();
    const replay = tools.find(t => t.name === 'apitap_replay')!;
    assert.equal(replay.annotations?.readOnlyHint, true);
    assert.equal(replay.annotations?.openWorldHint, true);
  });

  it('apitap_capture has readOnlyHint=false annotation', async () => {
    const { tools } = await client.listTools();
    const cap = tools.find(t => t.name === 'apitap_capture')!;
    assert.equal(cap.annotations?.readOnlyHint, false);
  });
});

describe('apitap_search via MCP', () => {
  let testDir: string;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-mcp-'));
    await writeSkillFile(makeSkill('gamma-api.polymarket.com', 'https://gamma-api.polymarket.com', [
      { id: 'get-events', method: 'GET', path: '/events', tier: 'green' },
      { id: 'get-teams', method: 'GET', path: '/teams', tier: 'yellow' },
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
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns matching results as JSON text content', async () => {
    const result = await client.callTool({ name: 'apitap_search', arguments: { query: 'polymarket' } });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.found, true);
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0].domain, 'gamma-api.polymarket.com');
  });

  it('returns not-found with suggestion', async () => {
    const result = await client.callTool({ name: 'apitap_search', arguments: { query: 'nonexistent' } });
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.found, false);
    assert.ok(data.suggestion);
  });
});

describe('apitap_replay via MCP', () => {
  let testDir: string;
  let httpServer: Server;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-mcp-replay-'));

    httpServer = createHttpServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, title: 'Election 2026' }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://localhost:${port}`;

    await writeSkillFile(makeSkill('test-api.example.com', baseUrl, [
      { id: 'get-events', method: 'GET', path: '/events', tier: 'green' },
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
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('replays green endpoint and returns data', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'test-api.example.com', endpointId: 'get-events' },
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.status, 200);
    assert.ok(Array.isArray(data.data));
    assert.equal(data.data[0].title, 'Election 2026');
  });

  it('returns error content for unknown domain', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'unknown.com', endpointId: 'get-events' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as any)[0].text;
    assert.ok(text.includes('No skill file'));
  });

  it('returns enriched metadata in replay response', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'test-api.example.com', endpointId: 'get-events' },
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.status, 200);
    assert.equal(data.domain, 'test-api.example.com');
    assert.equal(data.endpointId, 'get-events');
    assert.equal(data.tier, 'green');
    assert.ok(data.capturedAt);
    assert.equal(typeof data.fromCache, 'boolean');
  });

  it('marks replay response as untrusted external content', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'test-api.example.com', endpointId: 'get-events' },
    });
    assert.equal(result.isError, undefined);
    assert.equal((result as any)._meta?.externalContent?.untrusted, true);
    assert.equal((result as any)._meta?.externalContent?.source, 'apitap_replay');
  });

  it('returns error content for unknown endpoint', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'test-api.example.com', endpointId: 'nonexistent' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as any)[0].text;
    assert.ok(text.includes('not found'));
  });
});

describe('apitap_read via MCP', () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const server = createMcpServer({ _skipSsrfCheck: true });
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
  });

  it('marks read response as untrusted external content', async () => {
    const result = await client.callTool({
      name: 'apitap_read',
      arguments: { url: 'https://en.wikipedia.org/wiki/Node.js' },
    });
    assert.equal(result.isError, undefined);
    assert.equal((result as any)._meta?.externalContent?.untrusted, true);
    assert.equal((result as any)._meta?.externalContent?.source, 'apitap_read');
  });
});

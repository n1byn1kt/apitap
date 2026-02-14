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

describe('apitap_browse via MCP', () => {
  let testDir: string;
  let httpServer: Server;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-mcp-browse-'));

    httpServer = createHttpServer((req, res) => {
      if (req.url === '/api/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ id: 1 }] }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => httpServer.listen(0, r));
    const port = (httpServer.address() as AddressInfo).port;

    await writeSkillFile(makeSkill('browse-test.example.com', `http://localhost:${port}`, [
      { id: 'get-api-search', method: 'GET', path: '/api/search' },
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
    await new Promise<void>(r => httpServer.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('tool is registered with correct schema', async () => {
    const { tools } = await client.listTools();
    const browseTool = tools.find(t => t.name === 'apitap_browse');
    assert.ok(browseTool, 'apitap_browse should exist');
    assert.ok(browseTool.inputSchema.properties.url);
    assert.ok(browseTool.inputSchema.properties.task);
    assert.equal(browseTool.annotations?.readOnlyHint, true);
    assert.equal(browseTool.annotations?.openWorldHint, true);
  });

  it('browses known domain and returns data', async () => {
    const result = await client.callTool({
      name: 'apitap_browse',
      arguments: { url: 'http://browse-test.example.com/api/search' },
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.success, true);
    assert.equal(data.domain, 'browse-test.example.com');
    assert.ok(data.data);
    assert.equal(data.fromCache, true);
  });

  it('returns guidance for unknown domain', async () => {
    const result = await client.callTool({
      name: 'apitap_browse',
      arguments: { url: 'http://unknown-domain.test/stuff' },
    });
    // Not isError — guidance is a successful tool response
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.success, false);
    assert.ok(data.suggestion);
    assert.equal(data.domain, 'unknown-domain.test');
  });

  it('passes task through', async () => {
    const result = await client.callTool({
      name: 'apitap_browse',
      arguments: { url: 'http://browse-test.example.com', task: 'find items' },
    });
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.task, 'find items');
  });
});

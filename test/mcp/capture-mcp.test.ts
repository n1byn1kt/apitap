// test/mcp/capture-mcp.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp.js';

let httpServer: Server;
let baseUrl: string;
let testDir: string;
let client: Client;
let cleanup: () => Promise<void>;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><title>MCP Test</title></head>
<body>
  <button id="btn1" onclick="fetchData()">Load</button>
  <a href="/page2">Page 2</a>
  <input type="text" name="q" placeholder="Search">
  <script>
    async function fetchData() {
      await fetch('/api/items').then(r => r.json());
    }
  </script>
</body></html>`);
      } else if (req.url === '/page2') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Page 2</title></head><body><p>Page 2</p></body></html>`);
      } else if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 1 }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    httpServer.listen(0, () => {
      const port = (httpServer.address() as AddressInfo).port;
      resolve(`http://localhost:${port}`);
    });
  });
}

describe('MCP capture tools registration', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-capture-mcp-'));
    baseUrl = await startServer();

    const server = createMcpServer({ skillsDir: testDir });
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

  it('exposes 12 tools total', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
  });

  it('new tools have correct names', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.ok(names.includes('apitap_capture_start'));
    assert.ok(names.includes('apitap_capture_interact'));
    assert.ok(names.includes('apitap_capture_finish'));
  });

  it('apitap_capture_start has correct schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'apitap_capture_start')!;
    assert.ok(tool.inputSchema.properties.url);
    assert.ok(tool.inputSchema.required.includes('url'));
    assert.ok(tool.inputSchema.properties.headless);
    assert.ok(tool.inputSchema.properties.allDomains);
  });

  it('apitap_capture_interact has correct schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'apitap_capture_interact')!;
    assert.ok(tool.inputSchema.properties.sessionId);
    assert.ok(tool.inputSchema.properties.action);
    assert.ok(tool.inputSchema.required.includes('sessionId'));
    assert.ok(tool.inputSchema.required.includes('action'));
  });

  it('apitap_capture_finish has correct schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'apitap_capture_finish')!;
    assert.ok(tool.inputSchema.properties.sessionId);
    assert.ok(tool.inputSchema.properties.abort);
    assert.ok(tool.inputSchema.required.includes('sessionId'));
  });
});

describe('MCP capture start → interact → finish flow', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-capture-mcp-'));
    baseUrl = await startServer();

    const server = createMcpServer({ skillsDir: testDir });
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

  it('start returns sessionId and snapshot', async () => {
    const result = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    assert.equal(result.isError, undefined);

    const data = JSON.parse((result.content as any)[0].text);
    assert.ok(data.sessionId, 'should have sessionId');
    assert.ok(data.snapshot, 'should have snapshot');
    assert.ok(data.snapshot.url.includes('localhost'));
    assert.equal(data.snapshot.title, 'MCP Test');
    assert.ok(data.snapshot.elements.length > 0);

    // Clean up
    await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId: data.sessionId, abort: true },
    });
  });

  it('interact with snapshot action returns page state', async () => {
    const startResult = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    const { sessionId } = JSON.parse((startResult.content as any)[0].text);

    const snapResult = await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId, action: 'snapshot' },
    });
    assert.equal(snapResult.isError, undefined);

    const data = JSON.parse((snapResult.content as any)[0].text);
    assert.equal(data.success, true);
    assert.ok(data.snapshot.elements.length > 0);

    // Clean up
    await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId, abort: true },
    });
  });

  it('interact with click triggers API capture', async () => {
    const startResult = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    const { sessionId, snapshot } = JSON.parse((startResult.content as any)[0].text);

    // Find the button
    const btn = snapshot.elements.find((e: any) => e.tag === 'button');
    assert.ok(btn, 'should find button in snapshot');

    // Click it
    await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId, action: 'click', ref: btn.ref },
    });

    // Wait for fetch to complete
    await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId, action: 'wait', seconds: 1 },
    });

    // Check capture stats
    const snapResult = await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId, action: 'snapshot' },
    });
    const snapData = JSON.parse((snapResult.content as any)[0].text);
    assert.ok(snapData.snapshot.endpointsCaptured >= 1, `expected >=1 endpoint, got ${snapData.snapshot.endpointsCaptured}`);

    // Clean up
    await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId, abort: true },
    });
  });

  it('interact with navigate goes to new page', async () => {
    const startResult = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    const { sessionId } = JSON.parse((startResult.content as any)[0].text);

    const navResult = await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId, action: 'navigate', url: `${baseUrl}/page2` },
    });
    const data = JSON.parse((navResult.content as any)[0].text);
    assert.equal(data.success, true);
    assert.equal(data.snapshot.title, 'Page 2');

    await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId, abort: true },
    });
  });

  it('finish writes skill files', async () => {
    const startResult = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    const { sessionId, snapshot } = JSON.parse((startResult.content as any)[0].text);

    // Click button to trigger API
    const btn = snapshot.elements.find((e: any) => e.tag === 'button');
    if (btn) {
      await client.callTool({
        name: 'apitap_capture_interact',
        arguments: { sessionId, action: 'click', ref: btn.ref },
      });
      await client.callTool({
        name: 'apitap_capture_interact',
        arguments: { sessionId, action: 'wait', seconds: 1 },
      });
    }

    const finishResult = await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId },
    });
    assert.equal(finishResult.isError, undefined);

    const data = JSON.parse((finishResult.content as any)[0].text);
    assert.equal(data.aborted, false);
    assert.ok(Array.isArray(data.domains));

    // If endpoints were captured, skill file should have been written
    if (data.domains.length > 0) {
      const files = await readdir(testDir);
      assert.ok(files.some(f => f.endsWith('.json')), 'skill file should be written');
    }
  });

  it('abort closes without saving', async () => {
    const startResult = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    const { sessionId } = JSON.parse((startResult.content as any)[0].text);

    const abortResult = await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId, abort: true },
    });
    const data = JSON.parse((abortResult.content as any)[0].text);
    assert.equal(data.aborted, true);
    assert.deepEqual(data.domains, []);
  });

  it('unknown sessionId returns error', async () => {
    const result = await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId: 'fake-id', action: 'snapshot' },
    });
    assert.equal(result.isError, true);
    assert.ok((result.content as any)[0].text.includes('not found'));
  });

  it('finish with unknown sessionId returns error', async () => {
    const result = await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId: 'fake-id' },
    });
    assert.equal(result.isError, true);
    assert.ok((result.content as any)[0].text.includes('not found'));
  });

  it('invalid ref returns error with snapshot', async () => {
    const startResult = await client.callTool({
      name: 'apitap_capture_start',
      arguments: { url: baseUrl },
    });
    const { sessionId } = JSON.parse((startResult.content as any)[0].text);

    const clickResult = await client.callTool({
      name: 'apitap_capture_interact',
      arguments: { sessionId, action: 'click', ref: 'e999' },
    });
    assert.equal(clickResult.isError, true);
    const data = JSON.parse((clickResult.content as any)[0].text);
    assert.equal(data.success, false);
    assert.ok(data.error.includes('not found'));
    assert.ok(data.snapshot, 'should still include snapshot');

    await client.callTool({
      name: 'apitap_capture_finish',
      arguments: { sessionId, abort: true },
    });
  });
});

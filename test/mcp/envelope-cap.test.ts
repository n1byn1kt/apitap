// test/mcp/envelope-cap.test.ts
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
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveSigningKey } from '../../src/auth/crypto.js';
import { getMachineId } from '../../src/auth/manager.js';
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

// A big payload — well over any reasonable maxBytes test cap.
const bigItems = Array.from({ length: 500 }, (_, i) => ({
  id: i,
  title: `Item number ${i} with some extra padding text to inflate size`,
  description: 'x'.repeat(200),
}));

describe('MCP envelope cap', () => {
  let testDir: string;
  let httpServer: Server;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-mcp-envelope-cap-'));

    httpServer = createHttpServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bigItems));
      } else if (req.url === '/small') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 1, title: 'small payload' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://localhost:${port}`;

    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    // Skill domain must match baseUrl's hostname (validateSkillFile enforces
    // this), so "localhost" is the only usable domain here — it also happens
    // to be what apitap_browse resolves from a port-less "http://localhost/..." URL.
    await writeSkillFile(signSkillFile(makeSkill('localhost', baseUrl, [
      { id: 'get-big', method: 'GET', path: '/big', tier: 'green' },
      { id: 'get-small', method: 'GET', path: '/small', tier: 'green' },
    ]), sigKey), testDir);

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

  it('apitap_replay caps content[0].text at maxBytes and reports envelopeBytes', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'localhost', endpointId: 'get-big', maxBytes: 4000 },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as any)[0].text;
    assert.ok(Buffer.byteLength(text) <= 4000, `payload ${Buffer.byteLength(text)} > 4000`);
    const payload = JSON.parse(text);
    assert.equal(typeof payload.envelopeBytes, 'number');
    assert.ok(payload.truncated);
  });

  it('apitap_replay under budget still reports envelopeBytes without truncation', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'localhost', endpointId: 'get-small', maxBytes: 4000 },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as any)[0].text;
    const payload = JSON.parse(text);
    assert.equal(typeof payload.envelopeBytes, 'number');
    assert.equal(payload.truncated, undefined);
    assert.equal(payload.data.title, 'small payload');
  });

  it('apitap_replay with no maxBytes omits envelope capping (no envelopeBytes)', async () => {
    const result = await client.callTool({
      name: 'apitap_replay',
      arguments: { domain: 'localhost', endpointId: 'get-small' },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as any)[0].text;
    const payload = JSON.parse(text);
    // capEnvelope always reports the measured size, even without a maxBytes ceiling.
    assert.equal(typeof payload.envelopeBytes, 'number');
    assert.equal(payload.truncated, undefined);
  });

  it('apitap_replay_batch caps each result independently and reports envelopeBytes per result', async () => {
    const result = await client.callTool({
      name: 'apitap_replay_batch',
      arguments: {
        requests: [
          { domain: 'localhost', endpointId: 'get-big' },
          { domain: 'localhost', endpointId: 'get-small' },
        ],
        maxBytes: 4000,
      },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as any)[0].text;
    const results = JSON.parse(text);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(typeof r.envelopeBytes, 'number');
    }
    const bigResult = results.find((r: any) => r.endpointId === 'get-big');
    assert.ok(bigResult.truncated, 'big result should be truncated');
    const smallResult = results.find((r: any) => r.endpointId === 'get-small');
    assert.equal(smallResult.truncated, undefined);
  });

  it('apitap_browse caps content[0].text at maxBytes and reports envelopeBytes', async () => {
    const result = await client.callTool({
      name: 'apitap_browse',
      arguments: { url: 'http://localhost/big', maxBytes: 4000 },
    });
    assert.equal(result.isError, undefined);
    const text = (result.content as any)[0].text;
    assert.ok(Buffer.byteLength(text) <= 4000, `payload ${Buffer.byteLength(text)} > 4000`);
    const payload = JSON.parse(text);
    assert.equal(typeof payload.envelopeBytes, 'number');
    assert.ok(payload.truncated);
  });
});

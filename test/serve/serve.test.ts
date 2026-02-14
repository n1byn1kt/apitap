// test/serve/serve.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile } from '../../src/skill/store.js';
import { buildServeTools, createServeServer } from '../../src/serve.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(domain: string, baseUrl: string, endpoints: SkillFile['endpoints']): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-09T00:00:00.000Z',
    baseUrl,
    endpoints,
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self',
  };
}

describe('buildServeTools', () => {
  it('generates tool name as domain_endpointId', () => {
    const skill = makeSkill('coingecko.com', 'https://api.coingecko.com', [{
      id: 'get-trending',
      method: 'GET',
      path: '/trending',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array' },
      examples: { request: { url: 'https://api.coingecko.com/trending', headers: {} }, responsePreview: null },
    }]);

    const tools = buildServeTools(skill);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'coingecko.com_get-trending');
    assert.equal(tools[0].description, 'GET /trending on coingecko.com');
    assert.equal(tools[0].endpointId, 'get-trending');
  });

  it('makes path params required', () => {
    const skill = makeSkill('reddit.com', 'https://www.reddit.com', [{
      id: 'get-subreddit',
      method: 'GET',
      path: '/r/:subreddit/about',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://www.reddit.com/r/programming/about', headers: {} }, responsePreview: null },
    }]);

    const tools = buildServeTools(skill);
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties.subreddit);
    assert.ok(schema.required.includes('subreddit'));
  });

  it('makes query params optional with examples', () => {
    const skill = makeSkill('coingecko.com', 'https://api.coingecko.com', [{
      id: 'get-price',
      method: 'GET',
      path: '/simple/price',
      queryParams: {
        ids: { type: 'string', example: 'bitcoin' },
        vs_currencies: { type: 'string', example: 'usd' },
      },
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://api.coingecko.com/simple/price', headers: {} }, responsePreview: null },
    }]);

    const tools = buildServeTools(skill);
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties.ids);
    assert.ok(schema.properties.ids.description.includes('bitcoin'));
    assert.ok(schema.properties.vs_currencies);
    assert.ok(!schema.required || !schema.required.includes('ids'));
  });

  it('includes body variables for POST endpoints', () => {
    const skill = makeSkill('reddit.com', 'https://www.reddit.com', [{
      id: 'post-graphql',
      method: 'POST',
      path: '/gql',
      queryParams: {},
      headers: { 'content-type': 'application/json' },
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://www.reddit.com/gql', headers: {} }, responsePreview: null },
      requestBody: {
        contentType: 'application/json',
        template: { query: '', variables: { limit: 25 } },
        variables: ['variables.limit'],
      },
    }]);

    const tools = buildServeTools(skill);
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties['variables.limit']);
  });

  it('returns empty array for skill with no endpoints', () => {
    const skill = makeSkill('empty.com', 'https://empty.com', []);
    const tools = buildServeTools(skill);
    assert.equal(tools.length, 0);
  });
});

describe('createServeServer', () => {
  let testDir: string;
  let httpServer: Server;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-serve-'));

    httpServer = createHttpServer((req, res) => {
      if (req.url === '/trending') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Bitcoin' }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://localhost:${port}`;

    await writeSkillFile(makeSkill('test-api.example.com', baseUrl, [{
      id: 'get-trending',
      method: 'GET',
      path: '/trending',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array', fields: ['id', 'name'] },
      examples: { request: { url: `${baseUrl}/trending`, headers: {} }, responsePreview: null },
    }]), testDir);

    const server = await createServeServer('test-api.example.com', { skillsDir: testDir, noAuth: true });
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

  it('registers one tool per endpoint', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'test-api.example.com_get-trending');
  });

  it('tool call returns live API data', async () => {
    const result = await client.callTool({
      name: 'test-api.example.com_get-trending',
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content as any)[0].text);
    assert.equal(data.status, 200);
    assert.ok(Array.isArray(data.data));
    assert.equal(data.data[0].name, 'Bitcoin');
  });

  it('returns MCP error for unknown tool', async () => {
    try {
      await client.callTool({ name: 'nonexistent', arguments: {} });
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.ok(err.message);
    }
  });
});

describe('createServeServer errors', () => {
  it('throws when skill file not found', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'apitap-serve-err-'));
    try {
      await assert.rejects(
        () => createServeServer('nonexistent.com', { skillsDir: testDir }),
        /No skill file found/,
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

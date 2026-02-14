// test/plugin/plugin.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile } from '../../src/skill/store.js';
import { createPlugin } from '../../src/plugin.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(domain: string, endpoints: Array<{ id: string; method: string; path: string; tier?: string }>): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: `https://${domain}`,
    endpoints: endpoints.map(ep => ({
      id: ep.id,
      method: ep.method,
      path: ep.path,
      queryParams: {},
      headers: {},
      responseShape: { type: 'object', fields: ['id'] },
      examples: {
        request: { url: `https://${domain}${ep.path}`, headers: {} },
        responsePreview: null,
      },
      replayability: {
        tier: (ep.tier ?? 'green') as 'green' | 'yellow' | 'orange' | 'red' | 'unknown',
        verified: true,
        signals: [],
      },
    })),
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.4.0' },
    provenance: 'self',
  };
}

describe('createPlugin', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-plugin-'));
    await writeSkillFile(makeSkill('gamma-api.polymarket.com', [
      { id: 'get-events', method: 'GET', path: '/events', tier: 'green' },
      { id: 'get-teams', method: 'GET', path: '/teams', tier: 'green' },
    ]), testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns three tool definitions', () => {
    const plugin = createPlugin();
    assert.equal(plugin.tools.length, 3);
    const names = plugin.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['apitap_capture', 'apitap_replay', 'apitap_search']);
  });

  it('each tool has name, description, and parameters schema', () => {
    const plugin = createPlugin();
    for (const tool of plugin.tools) {
      assert.ok(tool.name, `Tool missing name`);
      assert.ok(tool.description, `Tool ${tool.name} missing description`);
      assert.ok(tool.parameters, `Tool ${tool.name} missing parameters`);
      assert.ok(tool.execute, `Tool ${tool.name} missing execute function`);
    }
  });

  it('apitap_search description tells agent when to use it', () => {
    const plugin = createPlugin();
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;
    assert.ok(search.description.includes('Search'));
    assert.ok(search.description.includes('green'));
  });

  it('apitap_replay description explains tiers', () => {
    const plugin = createPlugin();
    const replay = plugin.tools.find(t => t.name === 'apitap_replay')!;
    assert.ok(replay.description.includes('Replay'));
    assert.ok(replay.description.includes('tier'));
  });

  it('apitap_capture description explains when to capture', () => {
    const plugin = createPlugin();
    const cap = plugin.tools.find(t => t.name === 'apitap_capture')!;
    assert.ok(cap.description.includes('Capture'));
    assert.ok(cap.description.includes('skill'));
  });
});

describe('apitap_search tool execute', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-plugin-'));
    await writeSkillFile(makeSkill('gamma-api.polymarket.com', [
      { id: 'get-events', method: 'GET', path: '/events', tier: 'green' },
      { id: 'get-teams', method: 'GET', path: '/teams', tier: 'yellow' },
    ]), testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns matching results for a valid query', async () => {
    const plugin = createPlugin({ skillsDir: testDir });
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;
    const result = await search.execute({ query: 'polymarket' });
    assert.ok(result.found);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].domain, 'gamma-api.polymarket.com');
  });

  it('returns not-found with suggestion', async () => {
    const plugin = createPlugin({ skillsDir: testDir });
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;
    const result = await search.execute({ query: 'nonexistent' });
    assert.equal(result.found, false);
    assert.ok(result.suggestion);
  });

  it('returns specific endpoint by path search', async () => {
    const plugin = createPlugin({ skillsDir: testDir });
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;
    const result = await search.execute({ query: 'events' });
    assert.ok(result.found);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].endpointId, 'get-events');
    assert.equal(result.results[0].tier, 'green');
  });
});

describe('apitap_replay tool execute', () => {
  let testDir: string;
  let server: import('node:http').Server;
  let baseUrl: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-plugin-replay-'));

    // Start a local API server
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, title: 'Election 2026' }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://localhost:${port}`;

    // Write a skill file pointing at our test server
    const skill: SkillFile = {
      version: '1.2',
      domain: 'test-api.example.com',
      capturedAt: '2026-02-04T12:00:00.000Z',
      baseUrl,
      endpoints: [{
        id: 'get-events',
        method: 'GET',
        path: '/events',
        queryParams: {},
        headers: {},
        responseShape: { type: 'array', fields: ['id', 'title'] },
        examples: {
          request: { url: `${baseUrl}/events`, headers: {} },
          responsePreview: null,
        },
        replayability: { tier: 'green', verified: true, signals: ['status-match'] },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.4.0' },
      provenance: 'self',
    };
    await writeSkillFile(skill, testDir);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('replays a green endpoint and returns data', async () => {
    const plugin = createPlugin({ skillsDir: testDir });
    const replay = plugin.tools.find(t => t.name === 'apitap_replay')!;
    const result: any = await replay.execute({
      domain: 'test-api.example.com',
      endpointId: 'get-events',
    });
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.data));
    assert.equal(result.data[0].title, 'Election 2026');
  });

  it('returns error for unknown domain', async () => {
    const plugin = createPlugin({ skillsDir: testDir });
    const replay = plugin.tools.find(t => t.name === 'apitap_replay')!;
    const result: any = await replay.execute({
      domain: 'unknown.com',
      endpointId: 'get-events',
    });
    assert.ok(result.error);
    assert.ok(result.error.includes('No skill file'));
  });

  it('returns error for unknown endpoint', async () => {
    const plugin = createPlugin({ skillsDir: testDir });
    const replay = plugin.tools.find(t => t.name === 'apitap_replay')!;
    const result: any = await replay.execute({
      domain: 'test-api.example.com',
      endpointId: 'nonexistent',
    });
    assert.ok(result.error);
    assert.ok(result.error.includes('not found'));
  });
});

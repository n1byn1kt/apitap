// test/e2e/search-replay.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile } from '../../src/skill/store.js';
import { createPlugin } from '../../src/plugin.js';
import type { SkillFile } from '../../src/types.js';

describe('end-to-end: search → replay via plugin', () => {
  let server: Server;
  let baseUrl: string;
  let testDir: string;

  before(async () => {
    // API server simulating polymarket-like endpoints
    server = createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 'evt-1', title: 'Will BTC hit $200k?', volume: 42000 },
          { id: 'evt-2', title: 'Next US President', volume: 98000 },
        ]));
      } else if (req.url === '/teams') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 'team-1', name: 'Alpha Fund' },
        ]));
      } else if (req.url?.startsWith('/events?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 'evt-1', title: 'Will BTC hit $200k?', volume: 42000 },
        ]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;

    testDir = await mkdtemp(join(tmpdir(), 'apitap-e2e-search-'));

    // Write skill file matching the test server
    const skill: SkillFile = {
      version: '1.2',
      domain: 'gamma-api.polymarket.com',
      capturedAt: '2026-02-04T12:00:00.000Z',
      baseUrl,
      endpoints: [
        {
          id: 'get-events',
          method: 'GET',
          path: '/events',
          queryParams: {},
          headers: {},
          responseShape: { type: 'array', fields: ['id', 'title', 'volume'] },
          examples: { request: { url: `${baseUrl}/events`, headers: {} }, responsePreview: null },
          replayability: { tier: 'green', verified: true, signals: ['status-match', 'shape-match'] },
        },
        {
          id: 'get-teams',
          method: 'GET',
          path: '/teams',
          queryParams: {},
          headers: {},
          responseShape: { type: 'array', fields: ['id', 'name'] },
          examples: { request: { url: `${baseUrl}/teams`, headers: {} }, responsePreview: null },
          replayability: { tier: 'green', verified: true, signals: ['status-match'] },
        },
      ],
      metadata: { captureCount: 5, filteredCount: 20, toolVersion: '0.4.0' },
      provenance: 'self',
    };
    await writeSkillFile(skill, testDir);
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('agent workflow: search → find green endpoint → replay → get data', async () => {
    const plugin = createPlugin({ skillsDir: testDir, _skipSsrfCheck: true });
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;
    const replay = plugin.tools.find(t => t.name === 'apitap_replay')!;

    // Step 1: Agent searches for polymarket
    const searchResult: any = await search.execute({ query: 'polymarket events' });
    assert.ok(searchResult.found, 'Should find polymarket skill');
    assert.equal(searchResult.results.length, 1);

    const found = searchResult.results[0];
    assert.equal(found.domain, 'gamma-api.polymarket.com');
    assert.equal(found.endpointId, 'get-events');
    assert.equal(found.tier, 'green');

    // Step 2: Agent sees green tier, replays
    const replayResult: any = await replay.execute({
      domain: found.domain,
      endpointId: found.endpointId,
    });
    assert.equal(replayResult.status, 200);
    assert.ok(Array.isArray(replayResult.data));
    assert.equal(replayResult.data.length, 2);
    assert.equal(replayResult.data[0].title, 'Will BTC hit $200k?');
  });

  it('agent workflow: search not found → suggestion to capture', async () => {
    const plugin = createPlugin({ skillsDir: testDir, _skipSsrfCheck: true });
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;

    const searchResult: any = await search.execute({ query: 'hacker-news' });
    assert.equal(searchResult.found, false);
    assert.ok(searchResult.suggestion);
    assert.ok(searchResult.suggestion.includes('gamma-api.polymarket.com'));
  });

  it('agent workflow: search → replay with params', async () => {
    const plugin = createPlugin({ skillsDir: testDir, _skipSsrfCheck: true });
    const search = plugin.tools.find(t => t.name === 'apitap_search')!;
    const replay = plugin.tools.find(t => t.name === 'apitap_replay')!;

    // Search for events
    const searchResult: any = await search.execute({ query: 'events' });
    assert.ok(searchResult.found);

    // Replay with limit param
    const replayResult: any = await replay.execute({
      domain: searchResult.results[0].domain,
      endpointId: searchResult.results[0].endpointId,
      params: { limit: '1' },
    });
    assert.equal(replayResult.status, 200);
  });
});

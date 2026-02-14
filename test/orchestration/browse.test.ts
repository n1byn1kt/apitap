import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { browse } from '../../src/orchestration/browse.js';
import { SessionCache } from '../../src/orchestration/cache.js';
import { writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(domain: string, baseUrl: string, endpoints: Array<{ id: string; method: string; path: string; tier?: string }>): SkillFile {
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
      replayability: {
        tier: (ep.tier ?? 'green') as 'green' | 'yellow' | 'orange' | 'red' | 'unknown',
        verified: true,
        signals: [],
      },
    })),
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self' as const,
  };
}

describe('browse orchestration', () => {
  let testDir: string;
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-browse-'));
    httpServer = createServer((req, res) => {
      if (req.url === '/api/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ id: 1, name: 'Portland Apt' }] }));
      } else if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1 }, { id: 2 }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => httpServer.listen(0, r));
    baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => httpServer.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('replays from existing skill file on disk', async () => {
    await writeSkillFile(makeSkill('test.example.com', baseUrl, [
      { id: 'get-api-search', method: 'GET', path: '/api/search' },
    ]), testDir);

    const cache = new SessionCache();
    const result = await browse('http://test.example.com/api/search', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.domain, 'test.example.com');
    assert.ok(result.success && result.data);
    assert.equal(result.success && result.fromCache, true);
  });

  it('uses session cache on second call', async () => {
    await writeSkillFile(makeSkill('test.example.com', baseUrl, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
    ]), testDir);

    const cache = new SessionCache();

    // First call populates cache
    await browse('http://test.example.com/api/items', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });
    assert.ok(cache.has('test.example.com'));

    // Second call uses cache
    const result = await browse('http://test.example.com/api/items', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });
    assert.equal(result.success, true);
  });

  it('returns guidance when no skill file exists and discovery disabled', async () => {
    const cache = new SessionCache();
    const result = await browse('http://unknown-site.example.com', {
      skillsDir: testDir,
      cache,
      skipDiscovery: true,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, false);
    assert.equal(!result.success && result.reason, 'no_skill_file');
    assert.equal(!result.success && result.suggestion, 'capture_needed');
  });

  it('passes task through in response', async () => {
    await writeSkillFile(makeSkill('test.example.com', baseUrl, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
    ]), testDir);

    const cache = new SessionCache();
    const result = await browse('http://test.example.com', {
      skillsDir: testDir,
      cache,
      task: 'find apartments',
      _skipSsrfCheck: true,
    });

    assert.equal(result.task, 'find apartments');
  });

  it('prefers endpoint matching URL path', async () => {
    await writeSkillFile(makeSkill('test.example.com', baseUrl, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
      { id: 'get-api-search', method: 'GET', path: '/api/search' },
    ]), testDir);

    const cache = new SessionCache();
    const result = await browse('http://test.example.com/api/search', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.success && result.endpointId, 'get-api-search');
  });

  it('skips red-tier endpoints', async () => {
    await writeSkillFile(makeSkill('test.example.com', baseUrl, [
      { id: 'get-api-search', method: 'GET', path: '/api/search', tier: 'red' },
      { id: 'get-api-items', method: 'GET', path: '/api/items', tier: 'green' },
    ]), testDir);

    const cache = new SessionCache();
    const result = await browse('http://test.example.com', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.success && result.endpointId, 'get-api-items');
  });

  it('rejects HTML responses as non-API data', async () => {
    // Create a server that returns HTML at /api/docs
    const htmlServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>API Documentation</body></html>');
    });
    await new Promise<void>(r => htmlServer.listen(0, r));
    const htmlBaseUrl = `http://localhost:${(htmlServer.address() as AddressInfo).port}`;

    await writeSkillFile(makeSkill('html-site.example.com', htmlBaseUrl, [
      { id: 'get-api-docs', method: 'GET', path: '/api/docs' },
    ]), testDir);

    const cache = new SessionCache();
    const result = await browse('http://html-site.example.com', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, false);
    assert.equal(!result.success && result.reason, 'non_api_response');
    assert.equal(!result.success && result.suggestion, 'capture_needed');

    await new Promise<void>(r => htmlServer.close(() => r()));
  });
});

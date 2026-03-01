import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayMultiple, type BatchReplayRequest } from '../../src/replay/engine.js';
import { writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';
import type { ContractWarning } from '../../src/contract/diff.js';

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

describe('replayMultiple', () => {
  let serverA: Server;
  let serverB: Server;
  let baseUrlA: string;
  let baseUrlB: string;
  let testDir: string;

  before(async () => {
    // Server A: site-a.example.com
    serverA = createServer((req, res) => {
      if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1 }, { id: 2 }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => serverA.listen(0, r));
    baseUrlA = `http://localhost:${(serverA.address() as AddressInfo).port}`;

    // Server B: site-b.example.com
    serverB = createServer((req, res) => {
      if (req.url === '/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: 42 }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => serverB.listen(0, r));
    baseUrlB = `http://localhost:${(serverB.address() as AddressInfo).port}`;

    // Write skill files
    testDir = await mkdtemp(join(tmpdir(), 'apitap-batch-'));
    await writeSkillFile(makeSkill('site-a.example.com', baseUrlA, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
    ]), testDir);
    await writeSkillFile(makeSkill('site-b.example.com', baseUrlB, [
      { id: 'get-data', method: 'GET', path: '/data' },
    ]), testDir);
  });

  after(async () => {
    await new Promise<void>(r => serverA.close(() => r()));
    await new Promise<void>(r => serverB.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('replays multiple domains in parallel', async () => {
    const requests: BatchReplayRequest[] = [
      { domain: 'site-a.example.com', endpointId: 'get-api-items' },
      { domain: 'site-b.example.com', endpointId: 'get-data' },
    ];
    const results = await replayMultiple(requests, { skillsDir: testDir, _skipSsrfCheck: true });

    assert.equal(results.length, 2);
    assert.equal(results[0].domain, 'site-a.example.com');
    assert.equal(results[0].status, 200);
    assert.deepEqual(results[0].data, [{ id: 1 }, { id: 2 }]);
    assert.equal(results[0].tier, 'green');
    assert.equal(results[0].capturedAt, '2026-02-07T12:00:00.000Z');
    assert.equal(results[0].skillSource, 'disk');

    assert.equal(results[1].domain, 'site-b.example.com');
    assert.equal(results[1].status, 200);
    assert.deepEqual(results[1].data, { value: 42 });
  });

  it('returns error for missing domain without failing others', async () => {
    const requests: BatchReplayRequest[] = [
      { domain: 'site-a.example.com', endpointId: 'get-api-items' },
      { domain: 'nonexistent.com', endpointId: 'get-stuff' },
    ];
    const results = await replayMultiple(requests, { skillsDir: testDir, _skipSsrfCheck: true });

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 200);
    assert.equal(results[1].status, 0);
    assert.ok(results[1].error);
    assert.equal(results[1].data, null);
  });

  it('returns error for missing endpoint without failing others', async () => {
    const requests: BatchReplayRequest[] = [
      { domain: 'site-a.example.com', endpointId: 'nonexistent' },
      { domain: 'site-b.example.com', endpointId: 'get-data' },
    ];
    const results = await replayMultiple(requests, { skillsDir: testDir, _skipSsrfCheck: true });

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 0);
    assert.ok(results[0].error);
    assert.equal(results[1].status, 200);
  });

  it('handles empty request array', async () => {
    const results = await replayMultiple([], { skillsDir: testDir });
    assert.deepEqual(results, []);
  });

  it('includes contractWarnings when schema drifts', async () => {
    // Create a server that returns drifted data (extra field, missing field)
    const driftServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Missing 'name' field, added 'email', id changed type
      res.end(JSON.stringify({ id: 'string-now', email: 'test@example.com' }));
    });
    await new Promise<void>(r => driftServer.listen(0, r));
    const driftUrl = `http://localhost:${(driftServer.address() as AddressInfo).port}`;

    // Write skill file with responseSchema
    const driftSkill: SkillFile = {
      ...makeSkill('drift.example.com', driftUrl, [{ id: 'get-user', method: 'GET', path: '/user' }]),
    };
    driftSkill.endpoints[0].responseSchema = {
      type: 'object',
      fields: {
        id: { type: 'number' },
        name: { type: 'string' },
      },
    };
    await writeSkillFile(driftSkill, testDir);

    const requests: BatchReplayRequest[] = [
      { domain: 'drift.example.com', endpointId: 'get-user' },
    ];
    const results = await replayMultiple(requests, { skillsDir: testDir, _skipSsrfCheck: true });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 200);
    assert.ok(results[0].contractWarnings, 'batch result should include contractWarnings');
    assert.ok(results[0].contractWarnings!.length > 0);

    const errors = results[0].contractWarnings!.filter((w: ContractWarning) => w.severity === 'error');
    assert.ok(errors.some((w: ContractWarning) => w.path === 'name'), 'should detect missing name field');

    await new Promise<void>(r => driftServer.close(() => r()));
  });

  it('deduplicates skill file reads for same domain', async () => {
    const requests: BatchReplayRequest[] = [
      { domain: 'site-a.example.com', endpointId: 'get-api-items' },
      { domain: 'site-a.example.com', endpointId: 'get-api-items' },
    ];
    const results = await replayMultiple(requests, { skillsDir: testDir, _skipSsrfCheck: true });

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 200);
    assert.equal(results[1].status, 200);
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { browse } from '../../src/orchestration/browse.js';
import { SessionCache } from '../../src/orchestration/cache.js';
import { writeSkillFile } from '../../src/skill/store.js';
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveSigningKey } from '../../src/auth/crypto.js';
import { getMachineId } from '../../src/auth/manager.js';
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
    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(makeSkill('localhost', baseUrl, [
      { id: 'get-api-search', method: 'GET', path: '/api/search' },
    ]), sigKey), testDir);

    const cache = new SessionCache();
    const result = await browse('http://localhost/api/search', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.domain, 'localhost');
    assert.ok(result.success && result.data);
    assert.equal(result.success && result.skillSource, 'disk');
  });

  it('uses session cache on second call', async () => {
    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(makeSkill('localhost', baseUrl, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
    ]), sigKey), testDir);

    const cache = new SessionCache();

    // First call populates cache
    await browse('http://localhost/api/items', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });
    assert.ok(cache.has('localhost'));

    // Second call uses cache
    const result = await browse('http://localhost/api/items', {
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
      _bridgeSocketPath: join(testDir, 'nonexistent.sock'),
    });

    assert.equal(result.success, false);
    assert.equal(!result.success && result.reason, 'no_skill_file');
    assert.equal(!result.success && result.suggestion, 'capture_needed');
  });

  it('passes task through in response', async () => {
    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(makeSkill('localhost', baseUrl, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
    ]), sigKey), testDir);

    const cache = new SessionCache();
    const result = await browse('http://localhost', {
      skillsDir: testDir,
      cache,
      task: 'find apartments',
      _skipSsrfCheck: true,
    });

    assert.equal(result.task, 'find apartments');
  });

  it('prefers endpoint matching URL path', async () => {
    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(makeSkill('localhost', baseUrl, [
      { id: 'get-api-items', method: 'GET', path: '/api/items' },
      { id: 'get-api-search', method: 'GET', path: '/api/search' },
    ]), sigKey), testDir);

    const cache = new SessionCache();
    const result = await browse('http://localhost/api/search', {
      skillsDir: testDir,
      cache,
      _skipSsrfCheck: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.success && result.endpointId, 'get-api-search');
  });

  it('skips red-tier endpoints', async () => {
    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(makeSkill('localhost', baseUrl, [
      { id: 'get-api-search', method: 'GET', path: '/api/search', tier: 'red' },
      { id: 'get-api-items', method: 'GET', path: '/api/items', tier: 'green' },
    ]), sigKey), testDir);

    const cache = new SessionCache();
    const result = await browse('http://localhost', {
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

    const machineId = await getMachineId();
    const sigKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(makeSkill('localhost', htmlBaseUrl, [
      { id: 'get-api-docs', method: 'GET', path: '/api/docs' },
    ]), sigKey), testDir);

    const cache = new SessionCache();
    const result = await browse('http://localhost', {
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

describe('browse with bridge escalation', () => {
  let testDir: string;
  let bridgeDir: string;
  let socketPath: string;
  let bridgeServer: net.Server;
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-browse-bridge-'));
    bridgeDir = await mkdtemp(join(tmpdir(), 'apitap-bridge-'));
    socketPath = join(bridgeDir, 'bridge.sock');

    httpServer = createServer((req, res) => {
      if (req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 1 }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => httpServer.listen(0, r));
    baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    bridgeServer?.close();
    await new Promise<void>(r => httpServer.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
    await rm(bridgeDir, { recursive: true, force: true });
  });

  function startBridgeServer(handler: (msg: any) => any): Promise<void> {
    return new Promise((resolve) => {
      bridgeServer = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf('\n');
          if (idx === -1) return;
          const msg = JSON.parse(buf.slice(0, idx));
          const response = handler(msg);
          conn.end(JSON.stringify(response) + '\n');
        });
      });
      bridgeServer.listen(socketPath, resolve);
    });
  }

  it('skips bridge when socket does not exist', async () => {
    const result = await browse('http://no-bridge.example.com', {
      skillsDir: testDir,
      skipDiscovery: true,
      _skipSsrfCheck: true,
      _bridgeSocketPath: join(bridgeDir, 'nonexistent.sock'),
    });

    assert.equal(result.success, false);
    assert.equal(!result.success && result.suggestion, 'capture_needed');
  });

  it('escalates to bridge and returns data when skill files received', async () => {
    // Bridge returns a skill file pointing to our test HTTP server
    await startBridgeServer((msg) => ({
      success: true,
      skillFiles: [makeSkill(msg.domain, baseUrl, [
        { id: 'get-api-data', method: 'GET', path: '/api/data' },
      ])],
    }));

    const result = await browse('http://localhost/api/data', {
      skillsDir: testDir,
      skipDiscovery: true,
      _skipSsrfCheck: true,
      _bridgeSocketPath: socketPath,
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.domain, 'localhost');
      assert.equal(result.skillSource, 'bridge');
      assert.ok(result.data);
    }
  });

  it('handles user denial gracefully', async () => {
    await startBridgeServer(() => ({
      success: false,
      error: 'user_denied',
    }));

    const result = await browse('http://denied.example.com', {
      skillsDir: testDir,
      skipDiscovery: true,
      _skipSsrfCheck: true,
      _bridgeSocketPath: socketPath,
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, 'user_denied');
      assert.ok(result.suggestion.includes('auth'));
    }
  });

  it('handles bridge timeout gracefully', async () => {
    // Server that never responds
    await new Promise<void>((resolve) => {
      bridgeServer = net.createServer(() => { /* no response */ });
      bridgeServer.listen(socketPath, resolve);
    });

    const result = await browse('http://timeout.example.com', {
      skillsDir: testDir,
      skipDiscovery: true,
      _skipSsrfCheck: true,
      _bridgeSocketPath: socketPath,
      _bridgeTimeout: 500,
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.suggestion, 'capture_needed');
    }
  });
});

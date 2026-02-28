import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthManager, getMachineId } from '../../src/auth/manager.js';
import { capture } from '../../src/capture/monitor.js';

describe('monitor capture session injection', () => {
  let httpServer: Server;
  let baseUrl: string;
  let receivedCookies: string[];
  let testDir: string;

  before(async () => {
    httpServer = createServer((req, res) => {
      receivedCookies.push(req.headers.cookie ?? '');
      if (req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><script>fetch("/api/data").catch(() => {});</script></body></html>');
    });
    await new Promise<void>(resolve => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  beforeEach(async () => {
    receivedCookies = [];
    testDir = await mkdtemp(join(tmpdir(), 'apitap-monitor-inject-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('injects cached session cookies for monitor capture path', async () => {
    const machineId = await getMachineId();
    const authManager = new AuthManager(testDir, machineId);
    await authManager.storeSession('localhost', {
      cookies: [{
        name: 'session_id',
        value: 'monitor-injected',
        domain: 'localhost',
        path: '/',
      }],
      savedAt: new Date().toISOString(),
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    await capture({
      url: baseUrl,
      launch: true,
      headless: true,
      duration: 2,
      authDir: testDir,
      allDomains: true,
    });

    const hasCookie = receivedCookies.some(c => c.includes('session_id=monitor-injected'));
    assert.ok(hasCookie, `Expected injected cookie, got: ${JSON.stringify(receivedCookies)}`);
  });
});

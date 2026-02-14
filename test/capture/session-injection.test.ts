// test/capture/session-injection.test.ts
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthManager, getMachineId } from '../../src/auth/manager.js';

describe('CaptureSession session injection', () => {
  let httpServer: Server;
  let baseUrl: string;
  let receivedCookies: string[];
  let testDir: string;

  before(async () => {
    httpServer = createServer((req, res) => {
      receivedCookies.push(req.headers.cookie ?? '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Hello</body></html>');
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
    testDir = await mkdtemp(join(tmpdir(), 'apitap-session-inject-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('injects cached session cookies into browser context', async () => {
    const machineId = await getMachineId();
    const authManager = new AuthManager(testDir, machineId);

    // Store session cookies for localhost
    await authManager.storeSession('localhost', {
      cookies: [{
        name: 'session_id',
        value: 'injected-abc123',
        domain: 'localhost',
        path: '/',
      }],
      savedAt: new Date().toISOString(),
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    // Import CaptureSession dynamically to avoid Playwright import at module level
    const { CaptureSession } = await import('../../src/capture/session.js');
    const session = new CaptureSession({
      headless: true,
      authDir: testDir,
    });

    try {
      await session.start(baseUrl);
      // Give server a moment to receive the request
      await new Promise(resolve => setTimeout(resolve, 500));

      // The server should have received the injected cookie
      const hasCookie = receivedCookies.some(c => c.includes('session_id=injected-abc123'));
      assert.ok(hasCookie, `Expected injected cookie, got: ${JSON.stringify(receivedCookies)}`);
    } finally {
      await session.abort();
    }
  });

  it('proceeds without cookies when no session cached', async () => {
    const { CaptureSession } = await import('../../src/capture/session.js');
    const session = new CaptureSession({
      headless: true,
      authDir: testDir,
    });

    try {
      await session.start(baseUrl);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should have made request but without session cookie
      assert.ok(receivedCookies.length > 0, 'Should have received at least one request');
      const hasSessionCookie = receivedCookies.some(c => c.includes('session_id'));
      assert.ok(!hasSessionCookie, 'Should not have session cookie');
    } finally {
      await session.abort();
    }
  });
});

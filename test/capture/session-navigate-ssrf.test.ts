import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureSession } from '../../src/capture/session.js';

let httpServer: Server;
let baseUrl: string;
let testDir: string;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><p>Test page</p></body></html>`);
    });
    httpServer.listen(0, () => {
      const port = (httpServer.address() as AddressInfo).port;
      resolve(`http://localhost:${port}`);
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (httpServer) httpServer.close(() => resolve());
    else resolve();
  });
}

describe('F7: Capture session navigate SSRF validation', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-navigate-'));
    baseUrl = await startServer();
  });

  afterEach(async () => {
    await stopServer();
    await rm(testDir, { recursive: true, force: true });
  });

  it('blocks file:// URLs', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);

    try {
      const result = await session.interact({
        action: 'navigate',
        url: 'file:///etc/passwd',
      });

      assert.equal(result.success, false, 'Navigate should fail');
      assert.match(result.error ?? '', /Navigation blocked|Blocked scheme/, 'Should mention blocked');
    } finally {
      await session.abort();
    }
  });

  it('blocks cloud metadata endpoint', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);

    try {
      const result = await session.interact({
        action: 'navigate',
        url: 'http://169.254.169.254/latest/meta-data',
      });

      assert.equal(result.success, false, 'Navigate should fail');
      assert.match(result.error ?? '', /Navigation blocked|Blocked scheme/, 'Should mention blocked');
    } finally {
      await session.abort();
    }
  });

  it('blocks javascript: URLs', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);

    try {
      const result = await session.interact({
        action: 'navigate',
        url: 'javascript:alert(1)',
      });

      assert.equal(result.success, false, 'Navigate should fail');
      assert.match(result.error ?? '', /Navigation blocked|Blocked scheme/, 'Should mention blocked');
    } finally {
      await session.abort();
    }
  });

  it('allows public HTTPS URLs', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);

    try {
      // Mock page.goto to avoid actually navigating
      const originalGoto = session['page'].goto;
      let gotoWasCalled = false;
      session['page'].goto = (async () => {
        gotoWasCalled = true;
        return null;
      }) as any;

      const result = await session.interact({
        action: 'navigate',
        url: 'https://example.com',
      });

      assert.equal(result.success, true, 'Navigate should succeed for public URL');
      assert.equal(gotoWasCalled, true, 'page.goto should be called for valid URL');

      // Restore
      session['page'].goto = originalGoto;
    } finally {
      await session.abort();
    }
  });
});

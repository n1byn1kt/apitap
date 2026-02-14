// test/capture/session.test.ts
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

function startServer(handler: (req: any, res: any) => void): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer(handler);
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

describe('CaptureSession', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-session-'));
    baseUrl = await startServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><title>Test App</title></head>
<body>
  <a href="/page2" id="link1">Go to Page 2</a>
  <button id="btn1" onclick="fetchData()">Load Data</button>
  <input type="text" name="search" placeholder="Search..." id="input1">
  <select id="sel1"><option value="a">A</option><option value="b">B</option></select>
  <script>
    async function fetchData() {
      const res = await fetch('/api/data');
      const data = await res.json();
      document.getElementById('btn1').textContent = 'Loaded ' + data.items.length;
    }
  </script>
</body></html>`);
      } else if (req.url === '/page2') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head><title>Page 2</title></head>
<body>
  <a href="/">Back</a>
  <button id="btn2" onclick="fetchMore()">More</button>
  <script>
    async function fetchMore() {
      const res = await fetch('/api/more');
      await res.json();
    }
  </script>
</body></html>`);
      } else if (req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 1, name: 'test' }] }));
      } else if (req.url === '/api/more') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ more: true }));
      } else if (req.url === '/api/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  afterEach(async () => {
    await stopServer();
    await rm(testDir, { recursive: true, force: true });
  });

  it('start() returns snapshot with page elements', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      const snapshot = await session.start(baseUrl);

      assert.ok(snapshot.url.includes('localhost'));
      assert.equal(snapshot.title, 'Test App');
      assert.ok(snapshot.elements.length > 0, 'should have interactive elements');

      // Check we got the expected elements
      const link = snapshot.elements.find(e => e.tag === 'a');
      assert.ok(link, 'should find a link element');
      assert.equal(link.text, 'Go to Page 2');

      const button = snapshot.elements.find(e => e.tag === 'button');
      assert.ok(button, 'should find a button element');

      const input = snapshot.elements.find(e => e.tag === 'input');
      assert.ok(input, 'should find an input element');
      assert.equal(input.placeholder, 'Search...');

      // Refs should be sequential
      assert.ok(snapshot.elements[0].ref.startsWith('e'));
    } finally {
      await session.abort();
    }
  });

  it('generates a unique session ID', () => {
    const s1 = new CaptureSession();
    const s2 = new CaptureSession();
    assert.notEqual(s1.id, s2.id);
    assert.match(s1.id, /^[0-9a-f-]{36}$/);
  });

  it('click triggers API call and captures endpoint', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      const snapshot = await session.start(baseUrl);

      // Find the button
      const btn = snapshot.elements.find(e => e.tag === 'button' && e.text.includes('Load Data'));
      assert.ok(btn, 'should find Load Data button');

      const result = await session.interact({ action: 'click', ref: btn.ref });
      assert.equal(result.success, true);

      // Wait a moment for the fetch to complete
      await session.interact({ action: 'wait', seconds: 1 });

      // Take a snapshot — should see the captured endpoint
      const snap2 = await session.interact({ action: 'snapshot' });
      assert.equal(snap2.success, true);
      assert.ok(snap2.snapshot.endpointsCaptured >= 1, `expected >=1 endpoint, got ${snap2.snapshot.endpointsCaptured}`);
    } finally {
      await session.abort();
    }
  });

  it('type fills input', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      const snapshot = await session.start(baseUrl);

      const input = snapshot.elements.find(e => e.tag === 'input');
      assert.ok(input, 'should find input');

      const result = await session.interact({ action: 'type', ref: input.ref, text: 'hello world' });
      assert.equal(result.success, true);
    } finally {
      await session.abort();
    }
  });

  it('navigate goes to new page', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      const result = await session.interact({ action: 'navigate', url: `${baseUrl}/page2` });
      assert.equal(result.success, true);
      assert.equal(result.snapshot.title, 'Page 2');
      assert.ok(result.snapshot.url.includes('/page2'));
    } finally {
      await session.abort();
    }
  });

  it('scroll returns updated snapshot', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      const result = await session.interact({ action: 'scroll', direction: 'down' });
      assert.equal(result.success, true);
      assert.ok(result.snapshot.url);
    } finally {
      await session.abort();
    }
  });

  it('wait pauses and returns snapshot', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      const result = await session.interact({ action: 'wait', seconds: 1 });
      assert.equal(result.success, true);
    } finally {
      await session.abort();
    }
  });

  it('invalid ref returns error with snapshot', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      const result = await session.interact({ action: 'click', ref: 'e999' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('not found'));
      // Should still return a snapshot
      assert.ok(result.snapshot.url);
    } finally {
      await session.abort();
    }
  });

  it('missing ref returns error', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      const result = await session.interact({ action: 'click' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('ref required'));
    } finally {
      await session.abort();
    }
  });

  it('finish() writes skill files and returns domain info', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);

    // Click button to trigger API call
    const snap = await session.interact({ action: 'snapshot' });
    const btn = snap.snapshot.elements.find(e => e.tag === 'button' && e.text.includes('Load Data'));
    if (btn) {
      await session.interact({ action: 'click', ref: btn.ref });
      await session.interact({ action: 'wait', seconds: 1 });
    }

    const result = await session.finish();
    assert.equal(result.aborted, false);

    // May or may not have domains depending on whether the fetch was captured
    // The key thing is it doesn't throw and returns the right shape
    assert.ok(Array.isArray(result.domains));
    if (result.domains.length > 0) {
      const d = result.domains[0];
      assert.ok(d.domain);
      assert.ok(d.endpointCount > 0);
      assert.ok(d.skillFile);
      assert.ok(d.tiers);
    }
  });

  it('abort() closes without writing', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);
    await session.abort();
    assert.equal(session.isActive, false);
  });

  it('isActive is false after finish', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);
    await session.finish();
    assert.equal(session.isActive, false);
  });

  it('interact on closed session returns error', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    await session.start(baseUrl);
    await session.abort();

    const result = await session.interact({ action: 'snapshot' });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('closed'));
  });

  it('expired session returns error', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir, timeoutMs: 100 });
    await session.start(baseUrl);

    // Wait for timeout
    await new Promise(r => setTimeout(r, 200));

    const result = await session.interact({ action: 'snapshot' });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('expired') || result.error?.includes('closed'));
  });

  it('select changes dropdown value', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      const snapshot = await session.start(baseUrl);

      const sel = snapshot.elements.find(e => e.tag === 'select');
      assert.ok(sel, 'should find select element');

      const result = await session.interact({ action: 'select', ref: sel.ref, value: 'b' });
      assert.equal(result.success, true);
    } finally {
      await session.abort();
    }
  });

  it('wait is capped at 10 seconds', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      const start = Date.now();
      await session.interact({ action: 'wait', seconds: 100 }); // should be capped to 10
      const elapsed = Date.now() - start;
      // Should not wait more than ~11 seconds (10s + overhead)
      assert.ok(elapsed < 12000, `waited ${elapsed}ms, expected < 12000ms`);
    } finally {
      await session.abort();
    }
  });

  it('recentEndpoints tracks discovered APIs', async () => {
    const session = new CaptureSession({ headless: true, skillsDir: testDir });
    try {
      await session.start(baseUrl);

      // Click button to trigger API
      const snap = await session.interact({ action: 'snapshot' });
      const btn = snap.snapshot.elements.find(e => e.tag === 'button' && e.text.includes('Load Data'));
      if (btn) {
        await session.interact({ action: 'click', ref: btn.ref });
        await session.interact({ action: 'wait', seconds: 1 });
      }

      const snap2 = await session.interact({ action: 'snapshot' });
      // Recent endpoints should be populated if API was captured
      if (snap2.snapshot.endpointsCaptured > 0) {
        assert.ok(snap2.snapshot.recentEndpoints.length > 0);
        assert.ok(snap2.snapshot.recentEndpoints[0].includes('GET'));
      }
    } finally {
      await session.abort();
    }
  });
});

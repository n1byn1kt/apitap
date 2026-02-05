// test/e2e/capture-replay.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../../src/capture/monitor.js';
import { writeSkillFile, readSkillFile } from '../../src/skill/store.js';
import { replayEndpoint } from '../../src/replay/engine.js';

describe('end-to-end: capture → skill file → replay', () => {
  let server: Server;
  let serverUrl: string;
  let testDir: string;

  before(async () => {
    // Start a simple JSON API server
    server = createServer((req, res) => {
      if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Beta' },
        ]));
      } else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
      } else {
        // Serve a minimal HTML page that fetches from the API
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body><h1>Test Page</h1>
          <script>
            fetch('/api/items').then(r => r.json()).then(console.log);
            fetch('/api/status').then(r => r.json()).then(console.log);
          </script>
          </body></html>
        `);
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://localhost:${port}`;

    testDir = await mkdtemp(join(tmpdir(), 'apitap-e2e-'));
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('captures API traffic, generates skill file, and replays', async () => {
    // 1. Capture traffic (launch browser, navigate, wait 3s for fetches)
    const result = await capture({
      url: serverUrl,
      duration: 3,
      launch: true,
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    // 2. Verify we captured endpoints
    assert.ok(result.generators.size > 0, 'Should have at least one domain');
    const domain = Array.from(result.generators.keys())[0];
    const gen = result.generators.get(domain)!;
    const skill = gen.toSkillFile(domain);

    assert.ok(skill.endpoints.length >= 2, `Expected >= 2 endpoints, got ${skill.endpoints.length}`);

    // 3. Write and re-read skill file
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile(domain, testDir);
    assert.ok(loaded, 'Skill file should be readable');
    assert.equal(loaded!.endpoints.length, skill.endpoints.length);

    // 4. Replay an endpoint
    const itemsEndpoint = skill.endpoints.find(e => e.path === '/api/items');
    assert.ok(itemsEndpoint, 'Should have /api/items endpoint');

    const replayResult = await replayEndpoint(loaded!, itemsEndpoint!.id);
    assert.equal(replayResult.status, 200);
    assert.deepEqual(replayResult.data, [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]);
  });
});

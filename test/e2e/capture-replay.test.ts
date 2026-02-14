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
import { verifyEndpoints } from '../../src/capture/verifier.js';
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';

describe('end-to-end: capture → skill file → replay', () => {
  let server: Server;
  let serverUrl: string;
  let testDir: string;

  before(async () => {
    // Start a JSON API server with varied endpoints
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
      } else if (req.url?.startsWith('/api/items?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Alpha' }]));
      } else if (req.url === '/monitoring') {
        // Telemetry noise — should be filtered
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        // Serve a minimal HTML page that fetches from the API
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body><h1>Test Page</h1>
          <script>
            fetch('/api/items').then(r => r.json()).then(console.log);
            fetch('/api/status').then(r => r.json()).then(console.log);
            fetch('/api/items?offset=0&limit=10').then(r => r.json()).then(console.log);
            fetch('/monitoring').then(r => r.json()).then(console.log);
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
      headless: true,
      allDomains: true,  // localhost would be filtered by domain-only mode
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    // 2. Verify we captured endpoints
    assert.ok(result.generators.size > 0, 'Should have at least one domain');
    const domain = Array.from(result.generators.keys())[0];
    const gen = result.generators.get(domain)!;
    let skill = gen.toSkillFile(domain);

    assert.ok(skill.endpoints.length >= 2, `Expected >= 2 endpoints, got ${skill.endpoints.length}`);

    // 3. Verify v0.3 features — schema version
    assert.equal(skill.version, '1.2');
    assert.equal(skill.provenance, 'unsigned');

    // 4. Auto-verify endpoints
    skill = await verifyEndpoints(skill);
    for (const ep of skill.endpoints) {
      if (ep.method === 'GET') {
        assert.ok(ep.replayability, `Endpoint ${ep.id} should have replayability`);
        assert.equal(ep.replayability!.verified, true);
        assert.equal(ep.replayability!.tier, 'green');
      }
    }

    // 5. Check pagination detection on /api/items (has offset+limit)
    const itemsEp = skill.endpoints.find(e => e.path === '/api/items');
    if (itemsEp && itemsEp.queryParams['offset']) {
      assert.equal(itemsEp.pagination?.type, 'offset');
    }

    // 6. Sign the skill file
    const key = deriveKey('test-machine-id');
    skill = signSkillFile(skill, key);
    assert.equal(skill.provenance, 'self');
    assert.ok(skill.signature?.startsWith('hmac-sha256:'));

    // Verify response previews are null by default
    for (const ep of skill.endpoints) {
      assert.equal(ep.examples.responsePreview, null, `Preview should be null for ${ep.id}`);
    }

    // 7. Write and re-read skill file
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile(domain, testDir);
    assert.ok(loaded, 'Skill file should be readable');
    assert.equal(loaded!.endpoints.length, skill.endpoints.length);
    assert.equal(loaded!.provenance, 'self');

    // 8. Replay an endpoint
    const replayEp = skill.endpoints.find(e => e.path === '/api/items');
    assert.ok(replayEp, 'Should have /api/items endpoint');

    const replayResult = await replayEndpoint(loaded!, replayEp!.id, { _skipSsrfCheck: true });
    assert.equal(replayResult.status, 200);
    assert.ok(Array.isArray(replayResult.data));
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

const execFileAsync = promisify(execFile);

function makeSkill(domain: string, baseUrl: string): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-07T12:00:00.000Z',
    baseUrl,
    endpoints: [{
      id: 'get-api-items',
      method: 'GET',
      path: '/api/items',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array', fields: ['id'] },
      examples: {
        request: { url: `${baseUrl}/api/items`, headers: {} },
        responsePreview: null,
      },
      replayability: { tier: 'green' as const, verified: true, signals: [] },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self' as const,
  };
}

describe('CLI browse command', () => {
  let testDir: string;
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-cli-browse-'));
    httpServer = createServer((req, res) => {
      if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1 }, { id: 2 }]));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => httpServer.listen(0, r));
    baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => httpServer.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('outputs JSON with --json flag', async () => {
    await writeSkillFile(makeSkill('cli-test.example.com', baseUrl), testDir);

    const { stdout } = await execFileAsync('node', [
      '--import', 'tsx',
      'src/cli.ts', 'browse', `http://cli-test.example.com`, '--json',
    ], {
      env: { ...process.env, APITAP_SKILLS_DIR: testDir, APITAP_SKIP_SSRF_CHECK: '1' },
      timeout: 15000,
    });

    const data = JSON.parse(stdout);
    assert.equal(data.success, true);
    assert.equal(data.domain, 'cli-test.example.com');
    assert.ok(data.data);
  });

  it('exits with error for missing URL', async () => {
    await assert.rejects(
      execFileAsync('node', [
        '--import', 'tsx',
        'src/cli.ts', 'browse',
      ], { timeout: 10000 }),
      (err: any) => err.code === 1,
    );
  });
});

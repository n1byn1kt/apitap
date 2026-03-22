import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AuthManager } from '../../src/auth/manager.js';

const execFileAsync = promisify(execFile);

describe('CLI replay auth persistence', () => {
  let testDir: string;
  let skillsDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-replay-auth-persist-'));
    skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('does not persist live auth header values during replay upgrade', async () => {
    const domain = '127.0.0.1';
    const endpointId = 'get-root';
    const skillPath = join(skillsDir, `${domain}.json`);
    const secret = 'CLI-PERSISTENCE-SECRET-XYZ';

    await writeFile(skillPath, JSON.stringify({
      version: '1.2',
      domain,
      baseUrl,
      capturedAt: new Date().toISOString(),
      endpoints: [{
        id: endpointId,
        method: 'GET',
        path: '/',
        queryParams: {},
        headers: {},
        responseShape: { type: 'object' },
        examples: { request: { url: `${baseUrl}/`, headers: {} }, responsePreview: null },
        confidence: 0.6,
        endpointProvenance: 'skeleton',
      }],
      metadata: { captureCount: 0, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'unsigned',
    }, null, 2));

    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store(domain, {
      type: 'custom',
      header: 'x-api-key',
      value: secret,
    });

    const { stderr } = await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', 'replay', domain, endpointId, '--trust-unsigned', '--danger-disable-ssrf', '--json'],
      {
        env: {
          ...process.env,
          APITAP_DIR: testDir,
          APITAP_SKILLS_DIR: skillsDir,
          APITAP_MACHINE_ID: 'test-machine-id',
        },
        timeout: 20_000,
      },
    );

    assert.ok(
      stderr.includes('SSRF protection is disabled'),
      'expected replay command to execute with warning',
    );

    const persisted = await readFile(skillPath, 'utf-8');
    assert.ok(!persisted.includes(secret), 'persisted skill file must not contain live auth secret');
  });
});

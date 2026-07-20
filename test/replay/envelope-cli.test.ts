// test/replay/envelope-cli.test.ts
// Verifies `apitap replay --json --max-bytes N` and `apitap browse --json --max-bytes N`
// hard-cap stdout at N bytes via capEnvelope, and that the envelope always carries
// a numeric `envelopeBytes` sibling of `truncated` when --json is used.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSkillFile } from '../../src/skill/store.js';
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveSigningKey } from '../../src/auth/crypto.js';
import { getMachineId } from '../../src/auth/manager.js';
import type { SkillFile } from '../../src/types.js';

const execFileAsync = promisify(execFile);

interface CliResult { stdout: string; stderr: string; code: number }

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { ...process.env, ...env }, timeout: 20_000 },
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: typeof err.code === 'number' ? err.code : 1 };
  }
}

describe('CLI envelope cap on replay/browse --json', () => {
  let testDir: string;
  let skillsDir: string;
  let server: Server;
  let baseUrl: string;
  let domain: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-envelope-cli-'));
    skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    server = createServer((req, res) => {
      if (req.url === '/big') {
        // ~200 KB JSON array — comfortably over any small --max-bytes budget.
        const items = Array.from({ length: 4000 }, (_, i) => ({
          id: i,
          name: `item-${i}`,
          description: 'x'.repeat(30),
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(items));
      } else if (req.url === '/small') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: 1 }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    domain = '127.0.0.1';

    const skill: SkillFile = {
      version: '1.2',
      domain,
      baseUrl,
      capturedAt: new Date().toISOString(),
      endpoints: [
        {
          id: 'get-big',
          method: 'GET',
          path: '/big',
          queryParams: {},
          headers: {},
          responseShape: { type: 'array' },
          examples: { request: { url: `${baseUrl}/big`, headers: {} }, responsePreview: null },
          confidence: 0.6,
          endpointProvenance: 'skeleton',
          replayability: { tier: 'green', verified: true, signals: [] },
        } as any,
        {
          id: 'get-small',
          method: 'GET',
          path: '/small',
          queryParams: {},
          headers: {},
          responseShape: { type: 'object' },
          examples: { request: { url: `${baseUrl}/small`, headers: {} }, responsePreview: null },
          confidence: 0.6,
          endpointProvenance: 'skeleton',
          replayability: { tier: 'green', verified: true, signals: [] },
        } as any,
      ],
      metadata: { captureCount: 0, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };
    const machineId = await getMachineId();
    const signingKey = deriveSigningKey(machineId);
    await writeSkillFile(signSkillFile(skill, signingKey), skillsDir);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  const fixtureEnv = () => ({
    APITAP_DIR: testDir,
    APITAP_SKILLS_DIR: skillsDir,
  });

  it('replay --json --max-bytes N emits at most N bytes of stdout', async () => {
    const { stdout, code } = await runCli(
      ['replay', domain, 'get-big', '--danger-disable-ssrf', '--json', '--max-bytes', '4000'],
      fixtureEnv(),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Buffer.byteLength(stdout.trim()) <= 4000, `stdout ${Buffer.byteLength(stdout)} > 4000`);
    assert.equal(typeof parsed.envelopeBytes, 'number');
    assert.ok(parsed.truncated);
  });

  it('under-budget replay still reports envelopeBytes', async () => {
    const { stdout, code } = await runCli(
      ['replay', domain, 'get-small', '--danger-disable-ssrf', '--json', '--max-bytes', '50000'],
      fixtureEnv(),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(typeof parsed.envelopeBytes, 'number');
    assert.equal(parsed.truncated, undefined);
  });

  it('browse --json --max-bytes N emits at most N bytes of stdout', async () => {
    const { stdout, code } = await runCli(
      ['browse', `${baseUrl}/big`, '--danger-disable-ssrf', '--json', '--max-bytes', '4000'],
      fixtureEnv(),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Buffer.byteLength(stdout.trim()) <= 4000, `stdout ${Buffer.byteLength(stdout)} > 4000`);
    assert.equal(parsed.success, true);
    assert.equal(typeof parsed.envelopeBytes, 'number');
    assert.ok(parsed.truncated);
  });

  it('under-budget browse still reports envelopeBytes', async () => {
    const { stdout, code } = await runCli(
      ['browse', `${baseUrl}/small`, '--danger-disable-ssrf', '--json', '--max-bytes', '50000'],
      fixtureEnv(),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(typeof parsed.envelopeBytes, 'number');
    assert.equal(parsed.truncated, undefined);
  });
});

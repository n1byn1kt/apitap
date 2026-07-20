// test/cli/doctor-cli.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deriveSigningKey } from '../../src/auth/crypto.js';
import { getMachineId } from '../../src/auth/manager.js';
import { signSkillFileAs } from '../../src/skill/signing.js';
import { makeEndpoint, makeSkill } from '../doctor/fixtures.js';

const execFileAsync = promisify(execFile);

async function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: typeof err.code === 'number' ? err.code : 1 };
  }
}

describe('doctor --help', () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-doctor-cli-'));
    skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('prints usage and exits 0 without scanning', async () => {
    const { stdout, code } = await runCli(['doctor', '--help'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });
    assert.equal(code, 0);
    assert.match(stdout, /Usage: apitap doctor/);
    assert.doesNotMatch(stdout, /skills scanned/);
  });

  it('treats -h positional as help', async () => {
    const { stdout, code } = await runCli(['doctor', '-h'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });
    assert.equal(code, 0);
    assert.match(stdout, /Usage: apitap doctor/);
  });
});

describe('doctor summary default', () => {
  let testDir: string;
  let skillsDir: string;
  let baseEnv: Record<string, string>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-doctor-cli-summary-'));
    skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });

    // handleDoctor derives its signing key via `deriveSigningKey(machineId)`
    // with no saltFile override, so it always reads the real per-install
    // salt at ~/.apitap/install-salt — never APITAP_DIR. To sign fixtures
    // the CLI subprocess will accept, mirror that exactly: real machine id
    // (no APITAP_MACHINE_ID override) + default salt file.
    const machineId = await getMachineId();
    const signingKey = deriveSigningKey(machineId);

    // junk domain (capture blocklist) → quarantine-fixable finding
    await writeFile(join(skillsDir, 'cdn.segment.com.json'), JSON.stringify(
      signSkillFileAs(makeSkill({ domain: 'cdn.segment.com', baseUrl: 'https://cdn.segment.com' }), signingKey, 'self'),
    ));
    // beacon endpoint → warn/fixable finding on a second domain
    const beaconEp = makeEndpoint({
      id: 'post-capi', method: 'POST', path: '/capi/meta',
      responseShape: { type: 'object' }, responseBytes: 0,
      examples: { request: { url: 'https://mixed-fixture.com/capi/meta', headers: {} }, responsePreview: null },
    } as any);
    await writeFile(join(skillsDir, 'mixed-fixture.com.json'), JSON.stringify(
      signSkillFileAs(makeSkill({
        domain: 'mixed-fixture.com', baseUrl: 'https://mixed-fixture.com',
        endpoints: [makeEndpoint(), beaconEp],
      }), signingKey, 'self'),
    ));
    // tampered signature → invalid-signature finding on a third domain
    const tampered = signSkillFileAs(makeSkill({
      domain: 'tampered-fixture.com', baseUrl: 'https://tampered-fixture.com',
    }), signingKey, 'self') as any;
    tampered.capturedAt = '2026-07-02T00:00:00.000Z'; // breaks the HMAC
    await writeFile(join(skillsDir, 'tampered-fixture.com.json'), JSON.stringify(tampered));

    baseEnv = { APITAP_DIR: testDir, APITAP_SKILLS_DIR: skillsDir };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('whole-store run prints summary, not per-finding lines', async () => {
    const { stdout } = await runCli(['doctor'], baseEnv);
    assert.match(stdout, /Top domains/);
    assert.match(stdout, /--verbose/);
    // per-finding dump line shape "  <domain padded> <check>: <message>" absent
    assert.doesNotMatch(stdout, /^\s{2}\S+\s{2,}[a-z-]+: /m);
  });

  it('--verbose restores the full dump', async () => {
    const { stdout } = await runCli(['doctor', '--verbose'], baseEnv);
    assert.doesNotMatch(stdout, /Top domains/);
    assert.match(stdout, /^\s{2}\S+\s{2,}[a-z-]+: /m);
  });

  it('domain-scoped run keeps full detail without --verbose', async () => {
    const { stdout } = await runCli(['doctor', 'mixed-fixture.com'], baseEnv);
    assert.doesNotMatch(stdout, /Top domains/);
  });

  it('--json output is unchanged (full DoctorReport)', async () => {
    const { stdout } = await runCli(['doctor', '--json'], baseEnv);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.findings));
    assert.equal(typeof parsed.scanned, 'number');
  });
});

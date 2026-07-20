// test/cli/doctor-cli.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

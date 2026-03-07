import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AuthManager } from '../../src/auth/manager.js';

const execFileAsync = promisify(execFile);

async function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
    );
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function makeSkillFile(domain: string): string {
  return JSON.stringify({
    version: '1.1',
    domain,
    baseUrl: `https://${domain}`,
    capturedAt: '2026-03-01T00:00:00Z',
    endpoints: [
      { id: 'get-data', method: 'GET', path: '/data', headers: {}, queryParams: {}, responseShape: { type: 'object' } },
    ],
  }, null, 2);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('CLI forget command', () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-forget-'));
    skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should remove skill file and auth credentials', async () => {
    const domain = 'example.com';
    const skillPath = join(skillsDir, `${domain}.json`);
    await writeFile(skillPath, makeSkillFile(domain));

    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store(domain, { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });

    const { stdout } = await runCli(['forget', domain], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stdout.includes(`Forgot ${domain}`));
    assert.ok(stdout.includes('skill file'));
    assert.ok(stdout.includes('credentials'));

    // Verify skill file removed
    assert.equal(await fileExists(skillPath), false);

    // Verify auth removed
    const auth = await authManager.retrieve(domain);
    assert.equal(auth, null);
  });

  it('should remove skill file when no auth exists', async () => {
    const domain = 'noauth.com';
    const skillPath = join(skillsDir, `${domain}.json`);
    await writeFile(skillPath, makeSkillFile(domain));

    const { stdout } = await runCli(['forget', domain], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stdout.includes(`Forgot ${domain}`));
    assert.ok(stdout.includes('skill file'));
    assert.equal(await fileExists(skillPath), false);
  });

  it('should print not found for unknown domain', async () => {
    const { stdout } = await runCli(['forget', 'unknown.com'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stdout.includes('unknown.com not found'));
  });

  it('should show usage error when no domain provided', async () => {
    const { stderr } = await runCli(['forget'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stderr.includes('Domain required'));
  });

  it('should remove only auth when no skill file exists', async () => {
    const domain = 'authonly.com';
    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store(domain, { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });

    const { stdout } = await runCli(['forget', domain], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stdout.includes(`Forgot ${domain}`));
    assert.ok(stdout.includes('credentials'));

    const auth = await authManager.retrieve(domain);
    assert.equal(auth, null);
  });
});

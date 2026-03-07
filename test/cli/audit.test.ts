import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
      { id: 'get-items', method: 'GET', path: '/items', headers: {}, queryParams: {}, responseShape: { type: 'array' } },
    ],
  }, null, 2);
}

describe('CLI audit command', () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-audit-'));
    skillsDir = join(testDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should show empty message when no skill files exist', async () => {
    const { stdout } = await runCli(['audit'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stdout.includes('No skill files found'));
  });

  it('should list domains with endpoint counts and auth status', async () => {
    await writeFile(join(skillsDir, 'example.com.json'), makeSkillFile('example.com'));
    await writeFile(join(skillsDir, 'api.test.com.json'), makeSkillFile('api.test.com'));

    // Store auth for one domain
    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store('example.com', { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });

    const { stdout } = await runCli(['audit'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.ok(stdout.includes('example.com'));
    assert.ok(stdout.includes('api.test.com'));
    assert.ok(stdout.includes('DOMAIN'));
    assert.ok(stdout.includes('ENDPOINTS'));
    assert.ok(stdout.includes('AUTH'));
    assert.ok(stdout.includes('auth.enc last modified'));
  });

  it('should output JSON with --json flag', async () => {
    await writeFile(join(skillsDir, 'example.com.json'), makeSkillFile('example.com'));

    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store('example.com', { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });

    const { stdout } = await runCli(['audit', '--json'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.domains));
    assert.equal(parsed.domains.length, 1);
    assert.equal(parsed.domains[0].domain, 'example.com');
    assert.equal(parsed.domains[0].endpoints, 2);
    assert.equal(parsed.domains[0].auth, 'yes');
    assert.ok(parsed.authFileModified);
  });

  it('should show auth as no when domain has no stored credentials', async () => {
    await writeFile(join(skillsDir, 'noauth.com.json'), makeSkillFile('noauth.com'));

    const { stdout } = await runCli(['audit', '--json'], {
      APITAP_DIR: testDir,
      APITAP_SKILLS_DIR: skillsDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.domains[0].auth, 'no');
  });
});

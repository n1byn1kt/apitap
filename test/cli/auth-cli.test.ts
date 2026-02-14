// test/cli/auth-cli.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

describe('CLI auth command', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth-cli-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should list domains with --list', async () => {
    // Pre-populate auth storage
    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store('example.com', { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });
    await authManager.storeTokens('other.com', { csrf: { value: 'abc', refreshedAt: '2026-02-04T00:00:00Z' } });

    const { stdout } = await runCli(['auth', '--list', '--json'], {
      APITAP_DIR: testDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.domains));
    assert.ok(parsed.domains.includes('example.com'));
    assert.ok(parsed.domains.includes('other.com'));
  });

  it('should show auth status for domain', async () => {
    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store('example.com', { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });
    await authManager.storeTokens('example.com', { csrf_token: { value: 'token123', refreshedAt: '2026-02-04T00:00:00Z' } });

    const { stdout } = await runCli(['auth', 'example.com', '--json'], {
      APITAP_DIR: testDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.domain, 'example.com');
    assert.equal(parsed.hasHeaderAuth, true);
    assert.equal(parsed.headerAuthType, 'bearer');
    assert.ok(parsed.tokens.includes('csrf_token'));
  });

  it('should clear auth for domain', async () => {
    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store('example.com', { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });

    await runCli(['auth', 'example.com', '--clear'], {
      APITAP_DIR: testDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    // Verify cleared
    const auth = await authManager.retrieve('example.com');
    assert.equal(auth, null);
  });

  it('should show empty list when no auth stored', async () => {
    const { stdout } = await runCli(['auth', '--list', '--json'], {
      APITAP_DIR: testDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.domains, []);
  });
});

describe('CLI refresh command', () => {
  it('should show usage for refresh without domain', async () => {
    const { stderr } = await runCli(['refresh']);
    assert.ok(stderr.includes('Domain required') || stderr.includes('usage') || stderr.includes('Usage'));
  });
});

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

async function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
    );
    return { stdout, stderr, code: 0, killed: false };
  } catch (err: any) {
    // err.killed is set when execFile's own timeout fired — that means the CLI
    // hung rather than exiting, which no test here should tolerate.
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? null, killed: err.killed === true };
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

  // Regression: `apitap auth request <domain>` used to parse "request" as the
  // domain, print an empty-but-valid auth record and exit 0 — while `browse`
  // guidance told agents to run exactly that command.
  it('should not treat "request" as a domain name', async () => {
    // --timeout 1 drives the handoff to a deterministic, fast failure. Without
    // it the default 300s timeout outlives runCli's 10s kill, leaving empty
    // stdout — which would make every assertion below vacuously true.
    const { stdout, stderr, code, killed } = await runCli(
      ['auth', 'request', 'example.com', '--json', '--timeout', '1'],
      { APITAP_DIR: testDir, APITAP_MACHINE_ID: 'test-machine-id' },
    );

    assert.equal(killed, false, `CLI hung instead of exiting; stderr=${stderr}`);

    const parsed = JSON.parse(stdout); // must be real JSON, not empty output
    assert.equal(parsed.domain, 'example.com', 'the domain must come from positional[1], not "request"');
    assert.equal(parsed.success, false, 'no browser session is available in tests');
    assert.equal(code, 1, 'a failed handoff must exit non-zero');
    assert.doesNotMatch(stdout, /"domain":\s*"request"/);
  });

  it('should require a domain for `auth request`', async () => {
    const { stdout, stderr, code, killed } = await runCli(['auth', 'request', '--json'], {
      APITAP_DIR: testDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    assert.equal(killed, false, 'missing-domain path must exit immediately, not hang');
    assert.match(stderr, /domain required/i);
    assert.equal(code, 1);
    assert.doesNotMatch(stdout, /"domain":\s*"request"/);
  });

  for (const bad of ['-1', '0', 'abc']) {
    it(`should reject --timeout ${bad}`, async () => {
      const { stderr, code, killed } = await runCli(
        ['auth', 'request', 'example.com', '--json', '--timeout', bad],
        { APITAP_DIR: testDir, APITAP_MACHINE_ID: 'test-machine-id' },
      );

      assert.equal(killed, false, 'invalid --timeout must be rejected before any browser launch');
      assert.match(stderr, /--timeout must be a positive number of seconds/);
      assert.equal(code, 1);
    });
  }

  it('should still treat a bare positional as the domain', async () => {
    const authManager = new AuthManager(testDir, 'test-machine-id');
    await authManager.store('example.com', { type: 'bearer', header: 'authorization', value: 'Bearer xyz' });

    const { stdout } = await runCli(['auth', 'example.com', '--json'], {
      APITAP_DIR: testDir,
      APITAP_MACHINE_ID: 'test-machine-id',
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.domain, 'example.com');
  });
});

describe('CLI refresh command', () => {
  it('should show usage for refresh without domain', async () => {
    const { stderr } = await runCli(['refresh']);
    assert.ok(stderr.includes('Domain required') || stderr.includes('usage') || stderr.includes('Usage'));
  });
});

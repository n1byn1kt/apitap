// test/cli/json-error-contract.test.ts
//
// Issue #79: with `--json`, error-exit paths must honour the machine-output
// contract — a parseable envelope on stdout, not just human text on stderr.
//
// The contract:
//   - stdout parses as JSON: { success: false, error: string, usage?: string }
//   - stderr still carries the human line (interactive UX is preserved)
//   - exit code is non-zero
//
// These assert the *shape* per command, not just a non-zero exit, so the
// failure contract cannot regress silently the way `auth request` did.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { ...process.env, ...env }, timeout: 20000 },
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

/**
 * Assert the full JSON failure contract on a CLI result. Returns the parsed
 * envelope so callers can make command-specific assertions on top.
 */
function assertJsonFailure(result: CliResult, label: string): Record<string, unknown> {
  assert.notEqual(result.code, 0, `${label}: expected non-zero exit`);
  assert.notEqual(result.stdout.trim(), '', `${label}: stdout must not be empty under --json`);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label}: stdout is not valid JSON:\n${result.stdout}`);
  }

  assert.equal(parsed.success, false, `${label}: envelope must carry success:false`);
  assert.equal(typeof parsed.error, 'string', `${label}: envelope must carry a string error`);
  assert.notEqual(parsed.error, '', `${label}: error must not be empty`);
  assert.notEqual(result.stderr.trim(), '', `${label}: human line must still reach stderr`);

  return parsed;
}

describe('CLI --json failure contract (issue #79)', () => {
  let testDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-json-err-'));
    env = { APITAP_DIR: testDir, APITAP_SKILLS_DIR: join(testDir, 'skills') };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('missing required arguments', () => {
    const cases: Array<{ name: string; args: string[]; usageContains: string }> = [
      { name: 'show', args: ['show'], usageContains: 'apitap show' },
      { name: 'search', args: ['search'], usageContains: 'apitap search' },
      { name: 'replay', args: ['replay'], usageContains: 'apitap replay' },
      { name: 'refresh', args: ['refresh'], usageContains: 'apitap refresh' },
      { name: 'import', args: ['import'], usageContains: 'apitap import' },
      { name: 'capture', args: ['capture'], usageContains: 'apitap capture' },
      { name: 'discover', args: ['discover'], usageContains: 'apitap discover' },
      { name: 'inspect', args: ['inspect'], usageContains: 'apitap inspect' },
      { name: 'browse', args: ['browse'], usageContains: 'apitap browse' },
      { name: 'peek', args: ['peek'], usageContains: 'apitap peek' },
      { name: 'read', args: ['read'], usageContains: 'apitap read' },
      { name: 'forget', args: ['forget'], usageContains: 'apitap forget' },
      { name: 'auth request', args: ['auth', 'request'], usageContains: 'apitap auth request' },
      { name: 'auth', args: ['auth'], usageContains: 'apitap auth' },
    ];

    for (const c of cases) {
      it(`${c.name} emits a JSON envelope on stdout`, async () => {
        const result = await runCli([...c.args, '--json'], env);
        const parsed = assertJsonFailure(result, c.name);
        assert.equal(
          typeof parsed.usage,
          'string',
          `${c.name}: usage text belongs in its own field, not baked into error`,
        );
        assert.ok(
          (parsed.usage as string).includes(c.usageContains),
          `${c.name}: usage should mention "${c.usageContains}", got "${parsed.usage}"`,
        );
        assert.ok(
          !(parsed.error as string).includes('Usage:'),
          `${c.name}: error must not bake in the usage string`,
        );
      });
    }
  });

  describe('serve — envelope on stderr, not stdout', () => {
    // `apitap serve` reserves stdout for the MCP stdio transport; its `--json`
    // tool list already goes to stderr. The failure envelope follows that
    // channel rather than the repo-wide stdout default.
    it('serve emits the JSON envelope on stderr', async () => {
      const result = await runCli(['serve', '--json'], env);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout.trim(), '', 'serve must keep stdout free for the MCP transport');

      const jsonLine = result.stderr.slice(result.stderr.indexOf('{'), result.stderr.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonLine);
      assert.equal(parsed.success, false);
      assert.equal(typeof parsed.error, 'string');
      assert.ok((parsed.usage as string).includes('apitap serve'));
    });
  });

  describe('missing skill file', () => {
    for (const cmd of ['show', 'refresh']) {
      it(`${cmd} on an unknown domain emits a JSON envelope`, async () => {
        const result = await runCli([cmd, 'nonexistent-domain.invalid', '--json'], env);
        const parsed = assertJsonFailure(result, `${cmd} unknown domain`);
        assert.ok(
          (parsed.error as string).toLowerCase().includes('no skill file'),
          `${cmd}: error should name the missing skill file, got "${parsed.error}"`,
        );
      });
    }

    it('replay on an unknown domain emits a JSON envelope', async () => {
      const result = await runCli(['replay', 'nonexistent-domain.invalid', 'some-endpoint', '--json'], env);
      assertJsonFailure(result, 'replay unknown domain');
    });
  });

  describe('legacy `reason` alias', () => {
    it('import failures still carry reason alongside error', async () => {
      const result = await runCli(['import', '/nonexistent/path/to/skill.json', '--json'], env);
      const parsed = assertJsonFailure(result, 'import missing file');
      assert.equal(
        parsed.reason,
        parsed.error,
        'import kept a `reason` field historically; it must mirror `error` until deprecated',
      );
    });
  });

  describe('human mode is unchanged', () => {
    it('without --json, the error goes to stderr and stdout stays empty', async () => {
      const result = await runCli(['show'], env);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout.trim(), '', 'human mode must not emit JSON on stdout');
      assert.match(result.stderr, /Error: /);
      assert.match(result.stderr, /Usage: apitap show/);
    });
  });
});

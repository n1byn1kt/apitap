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
import { writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

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
    it('serve emits the JSON envelope on stderr, and nothing else', async () => {
      const result = await runCli(['serve', '--json'], env);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout.trim(), '', 'serve must keep stdout free for the MCP transport');

      // stderr is serve's only channel under --json, so it must parse whole —
      // no human line appended for an audience that has nowhere else to read.
      const parsed = JSON.parse(result.stderr);
      assert.equal(parsed.success, false);
      assert.equal(typeof parsed.error, 'string');
      assert.ok((parsed.usage as string).includes('apitap serve'));
    });

    it('serve without --json still prints the human line', async () => {
      const result = await runCli(['serve'], env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Error: Domain required\. Usage: apitap serve/);
      assert.ok(!result.stderr.includes('{'), 'human mode must not leak an envelope');
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

  describe('help prose stays out of `error`', () => {
    // An agent that surfaces `error` alone should get the defect, not a lecture.
    // Long guidance goes in `hint`, which also reaches the human stderr line.
    it('index build separates error, usage and hint', async () => {
      const result = await runCli(['index', 'bogus-subcommand', '--json'], env);
      const parsed = assertJsonFailure(result, 'index bogus');

      assert.equal(parsed.error, 'Unknown index subcommand');
      assert.equal(parsed.usage, 'apitap index build');
      assert.match(parsed.hint as string, /Force rebuild the search index/);
      assert.ok(
        !(parsed.error as string).includes('rebuild'),
        'help prose must not be jammed into `error`',
      );
      assert.match(result.stderr, /Force rebuild the search index/, 'humans keep the guidance too');
    });
  });

  describe('exit code agrees with the envelope', () => {
    // A failed `refresh --json` used to print success:false and exit 0, so a
    // caller keying on the exit code read it as a success. Same failure-contract
    // family as #79, and the exact shape of quiet regression that let the
    // original `auth request` bug through.
    //
    // A skill with no oauthConfig, no refreshable tokens and no auth.refreshUrl
    // takes refreshTokens' browser-free path and returns success:false without
    // launching Chrome or touching the network.
    function unrefreshableSkill(domain: string): SkillFile {
      return {
        version: '1.2',
        domain,
        capturedAt: '2026-02-04T12:00:00.000Z',
        baseUrl: `https://${domain}`,
        endpoints: [{
          id: 'get-thing',
          method: 'GET',
          path: '/thing',
          queryParams: {},
          headers: {},
          responseShape: { type: 'object', fields: ['id'] },
          examples: { request: { url: `https://${domain}/thing`, headers: {} }, responsePreview: null },
          replayability: { tier: 'green', verified: true, signals: [] },
        }],
        metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.4.0' },
        provenance: 'self',
      };
    }

    it('refresh --json exits non-zero when it reports success:false', async () => {
      const domain = 'unrefreshable.invalid';
      await writeSkillFile(unrefreshableSkill(domain), join(testDir, 'skills'));

      const result = await runCli(['refresh', domain, '--json', '--trust-unsigned'], env);

      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.success, false, 'expected the browser-free refresh path to report failure');
      assert.notEqual(
        result.code,
        0,
        'refresh printed success:false but exited 0 — exit code must agree with the envelope',
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

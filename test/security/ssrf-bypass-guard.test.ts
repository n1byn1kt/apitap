import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Issue #64: the _skipSsrfCheck / skipSsrf escape hatch exists for hermetic
// tests against loopback servers. It must be inert outside a test run —
// a production process setting it gets an error, not an SSRF bypass.
describe('SSRF bypass test-only guard (issue #64)', () => {
  const root = process.cwd();

  it('refuses skipSsrf/_skipSsrfCheck outside a test context', () => {
    const readUrl = pathToFileURL(join(root, 'src/read/index.ts')).href;
    const engineUrl = pathToFileURL(join(root, 'src/replay/engine.ts')).href;
    const script = `
      const { read } = await import(${JSON.stringify(readUrl)});
      const { replayEndpoint } = await import(${JSON.stringify(engineUrl)});
      const results = [];
      try {
        await read('http://127.0.0.1:9/x', { skipSsrf: true });
        results.push('read:no-throw');
      } catch (e) {
        results.push('read:' + (/test-only/.test(e.message) ? 'guarded' : 'other(' + e.message + ')'));
      }
      try {
        await replayEndpoint({}, 'x', { _skipSsrfCheck: true });
        results.push('replay:no-throw');
      } catch (e) {
        results.push('replay:' + (/test-only/.test(e.message) ? 'guarded' : 'other(' + e.message + ')'));
      }
      console.log('RESULT=' + results.join('|'));
    `;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_ENV;
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: root, env, encoding: 'utf-8' },
    );
    const line = out.split('\n').find((l) => l.startsWith('RESULT='));
    assert.strictEqual(line, 'RESULT=read:guarded|replay:guarded', `child said: ${out}`);
  });

  it('allows the bypass when the CLI danger flag set its acknowledgment env', () => {
    // --danger-disable-ssrf is a deliberate, warned, operator-facing flag;
    // the CLI exports APITAP_DANGER_DISABLE_SSRF=1 after printing its
    // warning, and the guard must honor that outside test contexts.
    const engineUrl = pathToFileURL(join(root, 'src/replay/engine.ts')).href;
    const script = `
      const { replayEndpoint } = await import(${JSON.stringify(engineUrl)});
      try {
        await replayEndpoint({ domain: 'x', endpoints: [] }, 'x', { _skipSsrfCheck: true });
        console.log('RESULT=no-throw');
      } catch (e) {
        console.log('RESULT=' + (/test-only/.test(e.message) ? 'guarded' : 'passed-guard'));
      }
    `;
    const env = { ...process.env, APITAP_DANGER_DISABLE_SSRF: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_ENV;
    const out = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: root, env, encoding: 'utf-8' },
    );
    const line = out.split('\n').find((l) => l.startsWith('RESULT='));
    // "passed-guard" = guard let it through and the (fake) skill errored later.
    assert.strictEqual(line, 'RESULT=passed-guard', `child said: ${out}`);
  });

  it('allows the bypass inside a test context (this very run)', async () => {
    const { read } = await import('../../src/read/index.js');
    // Unreachable port: fetch fails and read returns null — but the guard
    // must not throw while the node:test runner env marker is present.
    const result = await read('http://127.0.0.1:9/x', { skipSsrf: true });
    assert.strictEqual(result, null);
  });
});

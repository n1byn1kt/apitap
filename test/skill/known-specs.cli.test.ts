// test/skill/known-specs.cli.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '../../src/cli.ts');
const SKILLS_DIR = join(__dirname, '../../tmp/skills-test');

function runCli(args: string, opts = {}) {
  return execFileSync('node', ['--import', 'tsx', CLI, ...args.split(/\s+/)], { encoding: 'utf8', ...opts });
}

describe('known-specs CLI integration', () => {
  it('dispatches --from known', () => {
    const out = runCli('import --from known --query stripe --dry-run --json');
    const res = JSON.parse(out);
    assert.strictEqual(res.success, true);
    assert.ok(res.imported >= 0);
  });

  it('--dry-run does not write files', () => {
    if (existsSync(SKILLS_DIR)) rmSync(SKILLS_DIR, { recursive: true, force: true });
    runCli('import --from known --query stripe --dry-run');
    assert.ok(!existsSync(SKILLS_DIR), 'skills dir should not exist after dry-run');
  });

  it('handles provider fetch failure gracefully', () => {
    // Simulate by passing a nonsense query
    const out = runCli('import --from known --query nonexistingprovider --dry-run --json');
    const res = JSON.parse(out);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.imported, 0);
  });
});

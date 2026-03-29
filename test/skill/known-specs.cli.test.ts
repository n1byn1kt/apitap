// test/skill/known-specs.cli.test.ts
import { execSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnownSpecs } from '../../src/known-specs-loader.js';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '../../dist/cli.js');
const SKILLS_DIR = join(__dirname, '../../tmp/skills-test');

function runCli(args, opts = {}) {
  return execSync(`node ${CLI} ${args}`, { encoding: 'utf8', ...opts });
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

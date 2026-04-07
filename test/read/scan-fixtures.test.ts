// test/read/scan-fixtures.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanRawHtml } from '../../src/read/scan.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'read-traps');

async function load(name: string): Promise<string> {
  return await readFile(join(FIXTURES, name), 'utf8');
}

test('fixture: clean-article.html → 0 findings', async () => {
  const f = await load('clean-article.html');
  assert.equal(scanRawHtml(f).length, 0);
});

test('fixture: hidden-comment-trap.html → 1 finding, html_comment, hidden_role_marker', async () => {
  const f = await load('hidden-comment-trap.html');
  const findings = scanRawHtml(f);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scanner, 'hidden_role_marker');
  assert.equal(findings[0].hiddenBy, 'html_comment');
});

test('fixture: offscreen-span-trap.html → 1 finding, inline_style_offscreen', async () => {
  const f = await load('offscreen-span-trap.html');
  const findings = scanRawHtml(f);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].hiddenBy, 'inline_style_offscreen');
});

test('fixture: display-none-trap.html → 1 finding, inline_style_display_none', async () => {
  const f = await load('display-none-trap.html');
  const findings = scanRawHtml(f);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].hiddenBy, 'inline_style_display_none');
});

test('fixture: aria-hidden-trap.html → 1 finding, aria_hidden', async () => {
  const f = await load('aria-hidden-trap.html');
  const findings = scanRawHtml(f);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].hiddenBy, 'aria_hidden');
});

test('fixture: llm-docs-false-positive-guard.html → 0 findings (visible never fires)', async () => {
  const f = await load('llm-docs-false-positive-guard.html');
  const findings = scanRawHtml(f);
  assert.equal(findings.length, 0, 'visible matches must never fire in v1.0');
});

test('fixture: benign-hidden.html → 0 findings (decorative + too short)', async () => {
  const f = await load('benign-hidden.html');
  assert.equal(scanRawHtml(f).length, 0);
});

test('fixture: multiple-traps.html → 3 findings', async () => {
  const f = await load('multiple-traps.html');
  const findings = scanRawHtml(f);
  assert.equal(findings.length, 3);
});

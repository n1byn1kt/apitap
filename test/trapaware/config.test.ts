// test/trapaware/config.test.ts
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTrapAwareConfig, getConfigPath } from '../../src/trapaware/config.js';

let tempRoot: string;
const origXdgConfig = process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'apitap-config-'));
  process.env.XDG_CONFIG_HOME = tempRoot;
});

afterEach(async () => {
  if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdgConfig;
  await rm(tempRoot, { recursive: true, force: true });
});

test('config path resolves under XDG_CONFIG_HOME', () => {
  assert.equal(getConfigPath(), join(tempRoot, 'apitap', 'config.json'));
});

test('missing file returns defaults (off)', async () => {
  const cfg = await loadTrapAwareConfig();
  assert.deepEqual(cfg, { egressCheckAll: false, egressCheckAction: 'annotate' });
});

test('valid file is loaded', async () => {
  await mkdir(join(tempRoot, 'apitap'), { recursive: true });
  await writeFile(
    join(tempRoot, 'apitap', 'config.json'),
    JSON.stringify({ egressCheckAll: true, egressCheckAction: 'block' }),
  );
  const cfg = await loadTrapAwareConfig();
  assert.deepEqual(cfg, { egressCheckAll: true, egressCheckAction: 'block' });
});

test('malformed JSON falls back to defaults, does not throw', async () => {
  await mkdir(join(tempRoot, 'apitap'), { recursive: true });
  await writeFile(join(tempRoot, 'apitap', 'config.json'), '{not json');
  const cfg = await loadTrapAwareConfig();
  assert.deepEqual(cfg, { egressCheckAll: false, egressCheckAction: 'annotate' });
});

test('unknown action value falls back to annotate', async () => {
  await mkdir(join(tempRoot, 'apitap'), { recursive: true });
  await writeFile(
    join(tempRoot, 'apitap', 'config.json'),
    JSON.stringify({ egressCheckAll: true, egressCheckAction: 'nuke' }),
  );
  const cfg = await loadTrapAwareConfig();
  assert.equal(cfg.egressCheckAll, true);
  assert.equal(cfg.egressCheckAction, 'annotate');
});

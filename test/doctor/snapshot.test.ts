import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  snapshotOnce, quarantineSkill, restoreSkill, quarantinePath, snapshotPath,
} from '../../src/doctor/snapshot.js';

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('doctor snapshot/quarantine/restore', () => {
  let dir: string;
  const live = () => join(dir, 'a.com.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-snap-'));
    await writeFile(live(), '{"original":true}\n');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('snapshotOnce copies only on first touch', async () => {
    assert.equal(await snapshotOnce(dir, 'a.com'), true);
    await writeFile(live(), '{"edited":1}\n');
    assert.equal(await snapshotOnce(dir, 'a.com'), false); // second touch: no-op
    assert.equal(await readFile(snapshotPath(dir, 'a.com'), 'utf-8'), '{"original":true}\n');
  });

  it('quarantine moves the file; restore brings it back when no live file', async () => {
    await quarantineSkill(dir, 'a.com');
    assert.equal(await exists(live()), false);
    assert.equal(await exists(quarantinePath(dir, 'a.com')), true);
    assert.equal(await restoreSkill(dir, 'a.com'), 'quarantine');
    assert.equal(await readFile(live(), 'utf-8'), '{"original":true}\n');
  });

  it('quarantine restore REFUSES when a live file exists (re-captured)', async () => {
    await quarantineSkill(dir, 'a.com');
    await writeFile(live(), '{"recaptured":true}\n');
    await assert.rejects(() => restoreSkill(dir, 'a.com'), /refusing/i);
    assert.equal(await readFile(live(), 'utf-8'), '{"recaptured":true}\n'); // untouched
  });

  it('.orig beats quarantine and restores bytes-identical over a live file', async () => {
    await snapshotOnce(dir, 'a.com');
    await writeFile(live(), '{"edited":1}\n');
    await quarantineSkill(dir, 'a.com');          // both .orig and quarantine now exist
    await writeFile(live(), '{"recaptured":true}\n');
    assert.equal(await restoreSkill(dir, 'a.com'), 'orig');
    assert.equal(await readFile(live(), 'utf-8'), '{"original":true}\n');
  });

  it('restore with nothing to restore throws', async () => {
    await assert.rejects(() => restoreSkill(dir, 'nothing.com'), /nothing to restore/i);
  });

  it('restore rejects a path-traversal domain', async () => {
    await assert.rejects(() => restoreSkill(dir, '../evil'), /Invalid domain/);
  });

  it('quarantining the same domain twice never clobbers the first copy', async () => {
    await quarantineSkill(dir, 'a.com');
    assert.equal(await readFile(quarantinePath(dir, 'a.com'), 'utf-8'), '{"original":true}\n');

    await writeFile(live(), '{"recaptured":true}\n'); // recreate live file
    await quarantineSkill(dir, 'a.com');

    // unsuffixed copy untouched; a timestamped sibling holds the second one
    assert.equal(await readFile(quarantinePath(dir, 'a.com'), 'utf-8'), '{"original":true}\n');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(dir, '.quarantine'));
    const timestamped = entries.filter(e => e !== 'a.com.json' && e.startsWith('a.com.') && e.endsWith('.json'));
    assert.equal(timestamped.length, 1);
    assert.equal(
      await readFile(join(dir, '.quarantine', timestamped[0]), 'utf-8'),
      '{"recaptured":true}\n',
    );
  });
});

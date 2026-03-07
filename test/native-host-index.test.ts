import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleNativeMessage } from '../src/native-host.js';

describe('native host save_index', () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-test-'));
    skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes index.json atomically to parent of skills dir', async () => {
    const indexData = JSON.stringify({
      v: 1,
      updatedAt: '2026-03-07T12:00:00Z',
      entries: [{
        domain: 'discord.com',
        firstSeen: '2026-03-01T00:00:00Z',
        lastSeen: '2026-03-07T12:00:00Z',
        totalHits: 127,
        promoted: false,
        endpoints: [],
      }],
    });

    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: indexData } as any,
      skillsDir,
    );
    assert.ok(result.success, `Expected success but got: ${result.error}`);
    assert.ok(result.path);

    // Verify the file exists and is valid JSON
    const written = await fs.readFile(result.path!, 'utf-8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.entries[0].domain, 'discord.com');
  });

  it('rejects invalid JSON', async () => {
    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: 'not json' } as any,
      skillsDir,
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid JSON'));
  });

  it('rejects missing indexJson', async () => {
    const result = await handleNativeMessage(
      { action: 'save_index' as any } as any,
      skillsDir,
    );
    assert.equal(result.success, false);
  });

  it('rejects oversized indexJson (>5MB)', async () => {
    const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: oversized } as any,
      skillsDir,
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('too large'));
  });

  it('overwrites existing index.json', async () => {
    const indexPath = path.join(tmpDir, 'index.json');
    await fs.writeFile(indexPath, '{"v":1,"entries":[]}');

    const indexData = JSON.stringify({
      v: 1,
      updatedAt: '2026-03-07T14:00:00Z',
      entries: [{ domain: 'new.com', firstSeen: '2026-03-07T14:00:00Z', lastSeen: '2026-03-07T14:00:00Z', totalHits: 1, promoted: false, endpoints: [] }],
    });

    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: indexData } as any,
      skillsDir,
    );
    assert.ok(result.success);

    const written = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    assert.equal(written.entries[0].domain, 'new.com');
  });
});

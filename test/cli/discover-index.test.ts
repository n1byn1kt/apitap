import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CLI discover with index data', () => {
  let tmpDir: string;

  const sampleIndex = {
    v: 1,
    updatedAt: '2026-03-07T12:00:00Z',
    entries: [{
      domain: 'discord.com',
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-07T12:00:00Z',
      totalHits: 127,
      promoted: false,
      endpoints: [
        { path: '/api/v10/channels/:id', methods: ['GET', 'PATCH'], authType: 'Bearer', hasBody: true, hits: 42, lastSeen: '2026-03-07T12:00:00Z' },
        { path: '/api/v10/guilds/:id', methods: ['GET'], hasBody: true, hits: 30, lastSeen: '2026-03-07T11:00:00Z' },
      ],
    }],
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-cli-'));
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('readIndex returns entries for known domain', async () => {
    const { readIndexEntry } = await import('../../src/index/reader.js');
    const entry = await readIndexEntry('discord.com', tmpDir);
    assert.ok(entry);
    assert.equal(entry!.totalHits, 127);
    assert.equal(entry!.endpoints.length, 2);
  });
});

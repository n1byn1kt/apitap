import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readIndex, readIndexEntry } from '../../src/index/reader.js';

describe('index reader', () => {
  let tmpDir: string;

  const sampleIndex = {
    v: 1,
    updatedAt: '2026-03-07T12:00:00Z',
    entries: [
      {
        domain: 'discord.com',
        firstSeen: '2026-03-01T00:00:00Z',
        lastSeen: '2026-03-07T12:00:00Z',
        totalHits: 127,
        promoted: false,
        endpoints: [
          { path: '/api/v10/channels/:id', methods: ['GET', 'PATCH'], authType: 'Bearer', hasBody: true, hits: 42, lastSeen: '2026-03-07T12:00:00Z' },
          { path: '/api/v10/guilds/:id', methods: ['GET'], hasBody: true, hits: 30, lastSeen: '2026-03-07T11:00:00Z' },
        ],
      },
      {
        domain: 'github.com',
        firstSeen: '2026-03-02T00:00:00Z',
        lastSeen: '2026-03-07T10:00:00Z',
        totalHits: 43,
        promoted: true,
        lastPromoted: '2026-03-05T10:00:00Z',
        skillFileSource: 'extension',
        endpoints: [
          { path: '/api/v3/repos/:id', methods: ['GET'], hasBody: true, hits: 20, lastSeen: '2026-03-07T10:00:00Z' },
        ],
      },
    ],
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-idx-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads a valid index file', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
    const index = await readIndex(tmpDir);
    assert.ok(index);
    assert.equal(index!.v, 1);
    assert.equal(index!.entries.length, 2);
  });

  it('returns null when index.json does not exist', async () => {
    const index = await readIndex(tmpDir);
    assert.equal(index, null);
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), 'not json');
    const index = await readIndex(tmpDir);
    assert.equal(index, null);
  });

  it('filters entries by domain', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
    const entry = await readIndexEntry('discord.com', tmpDir);
    assert.ok(entry);
    assert.equal(entry!.domain, 'discord.com');
    assert.equal(entry!.endpoints.length, 2);
  });

  it('returns null for unknown domain', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
    const entry = await readIndexEntry('unknown.com', tmpDir);
    assert.equal(entry, null);
  });
});

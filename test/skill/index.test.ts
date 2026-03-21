// test/skill/index.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIndex,
  readIndex,
  updateIndex,
  removeFromIndex,
  checkStale,
  ensureIndex,
  type IndexFile,
} from '../../src/skill/index.js';

let skillsDir: string;

function makeSkillJSON(domain: string, endpoints: Array<{ id: string; method: string; path: string; tier?: string; verified?: boolean }>, provenance = 'imported-signed') {
  return JSON.stringify({
    version: '1.2',
    domain,
    baseUrl: `https://${domain}`,
    capturedAt: new Date().toISOString(),
    endpoints: endpoints.map(ep => ({
      ...ep,
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: `https://${domain}${ep.path}`, headers: {} }, responsePreview: null },
      ...(ep.tier ? { replayability: { tier: ep.tier, verified: ep.verified ?? false } } : {}),
    })),
    metadata: { captureCount: 0, filteredCount: 0, toolVersion: '1.0.0' },
    provenance,
  });
}

describe('search index', () => {
  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'apitap-index-'));
    skillsDir = join(base, 'skills');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(skillsDir, '..'), { recursive: true, force: true });
  });

  describe('buildIndex', () => {
    it('builds index from skill files on disk', async () => {
      await writeFile(
        join(skillsDir, 'api.example.com.json'),
        makeSkillJSON('api.example.com', [
          { id: 'get-users', method: 'GET', path: '/users' },
          { id: 'get-user', method: 'GET', path: '/users/:id' },
        ]),
      );
      await writeFile(
        join(skillsDir, 'api.test.com.json'),
        makeSkillJSON('api.test.com', [
          { id: 'get-items', method: 'GET', path: '/items' },
        ]),
      );

      const index = await buildIndex(skillsDir);

      assert.equal(index.version, 1);
      assert.equal(index.fileCount, 2);
      assert.equal(Object.keys(index.domains).length, 2);
      assert.equal(index.domains['api.example.com'].endpointCount, 2);
      assert.equal(index.domains['api.test.com'].endpointCount, 1);
      assert.equal(index.domains['api.example.com'].endpoints[0].id, 'get-users');
    });

    it('skips unparseable files', async () => {
      await writeFile(join(skillsDir, 'bad.json'), 'not valid json{{{');
      await writeFile(
        join(skillsDir, 'good.com.json'),
        makeSkillJSON('good.com', [{ id: 'get-data', method: 'GET', path: '/data' }]),
      );

      const index = await buildIndex(skillsDir);
      assert.equal(index.fileCount, 2); // fileCount = actual disk count
      assert.equal(Object.keys(index.domains).length, 1); // only good one indexed
    });

    it('persists index to disk', async () => {
      await writeFile(
        join(skillsDir, 'api.example.com.json'),
        makeSkillJSON('api.example.com', [{ id: 'get-data', method: 'GET', path: '/data' }]),
      );

      await buildIndex(skillsDir);
      const read = await readIndex(skillsDir);
      assert.ok(read);
      assert.equal(read.fileCount, 1);
      assert.equal(Object.keys(read.domains).length, 1);
    });

    it('includes tier and verified in index', async () => {
      await writeFile(
        join(skillsDir, 'api.example.com.json'),
        makeSkillJSON('api.example.com', [
          { id: 'get-data', method: 'GET', path: '/data', tier: 'green', verified: true },
        ]),
      );

      const index = await buildIndex(skillsDir);
      assert.equal(index.domains['api.example.com'].endpoints[0].tier, 'green');
      assert.equal(index.domains['api.example.com'].endpoints[0].verified, true);
    });
  });

  describe('updateIndex', () => {
    it('adds new domain and increments fileCount', async () => {
      // Start with one file
      await writeFile(
        join(skillsDir, 'existing.com.json'),
        makeSkillJSON('existing.com', [{ id: 'get-x', method: 'GET', path: '/x' }]),
      );
      await buildIndex(skillsDir);

      // Add new domain
      await updateIndex(
        'new.com',
        [{ id: 'get-y', method: 'GET', path: '/y' }],
        'imported-signed',
        skillsDir,
      );

      const index = await readIndex(skillsDir);
      assert.ok(index);
      assert.equal(Object.keys(index.domains).length, 2);
      assert.equal(index.fileCount, 2); // incremented
      assert.equal(index.domains['new.com'].endpointCount, 1);
    });

    it('updates existing domain without changing fileCount', async () => {
      await writeFile(
        join(skillsDir, 'api.com.json'),
        makeSkillJSON('api.com', [{ id: 'get-old', method: 'GET', path: '/old' }]),
      );
      await buildIndex(skillsDir);

      await updateIndex(
        'api.com',
        [
          { id: 'get-old', method: 'GET', path: '/old' },
          { id: 'get-new', method: 'GET', path: '/new' },
        ],
        'imported-signed',
        skillsDir,
      );

      const index = await readIndex(skillsDir);
      assert.ok(index);
      assert.equal(index.fileCount, 1); // unchanged
      assert.equal(index.domains['api.com'].endpointCount, 2);
    });

    it('creates index from scratch if missing', async () => {
      await updateIndex(
        'fresh.com',
        [{ id: 'get-data', method: 'GET', path: '/data' }],
        'self',
        skillsDir,
      );

      const index = await readIndex(skillsDir);
      assert.ok(index);
      assert.equal(index.fileCount, 1);
      assert.equal(index.domains['fresh.com'].endpointCount, 1);
    });
  });

  describe('removeFromIndex', () => {
    it('removes domain and decrements fileCount', async () => {
      await writeFile(
        join(skillsDir, 'a.com.json'),
        makeSkillJSON('a.com', [{ id: 'get-a', method: 'GET', path: '/a' }]),
      );
      await writeFile(
        join(skillsDir, 'b.com.json'),
        makeSkillJSON('b.com', [{ id: 'get-b', method: 'GET', path: '/b' }]),
      );
      await buildIndex(skillsDir);

      await removeFromIndex('a.com', skillsDir);

      const index = await readIndex(skillsDir);
      assert.ok(index);
      assert.equal(index.fileCount, 1);
      assert.ok(!index.domains['a.com']);
      assert.ok(index.domains['b.com']);
    });

    it('no-ops if index missing', async () => {
      await removeFromIndex('nonexistent.com', skillsDir);
      // Should not throw
    });
  });

  describe('checkStale', () => {
    it('reports missing index as stale', async () => {
      const result = await checkStale(null, skillsDir);
      assert.equal(result.stale, true);
      assert.equal(result.reason, 'missing');
    });

    it('reports fileCount mismatch as stale', async () => {
      await writeFile(
        join(skillsDir, 'a.com.json'),
        makeSkillJSON('a.com', [{ id: 'get-a', method: 'GET', path: '/a' }]),
      );
      await writeFile(
        join(skillsDir, 'b.com.json'),
        makeSkillJSON('b.com', [{ id: 'get-b', method: 'GET', path: '/b' }]),
      );

      const index: IndexFile = {
        version: 1,
        fileCount: 1, // Wrong — 2 files on disk
        builtAt: new Date().toISOString(),
        domains: {},
      };

      const result = await checkStale(index, skillsDir);
      assert.equal(result.stale, true);
      assert.equal(result.reason, 'filecount-mismatch');
    });

    it('reports fresh index as not stale', async () => {
      await writeFile(
        join(skillsDir, 'a.com.json'),
        makeSkillJSON('a.com', [{ id: 'get-a', method: 'GET', path: '/a' }]),
      );

      const index: IndexFile = {
        version: 1,
        fileCount: 1,
        builtAt: new Date().toISOString(),
        domains: {},
      };

      const result = await checkStale(index, skillsDir);
      assert.equal(result.stale, false);
      assert.equal(result.ageWarning, undefined);
    });

    it('reports age warning for old index', async () => {
      await writeFile(
        join(skillsDir, 'a.com.json'),
        makeSkillJSON('a.com', [{ id: 'get-a', method: 'GET', path: '/a' }]),
      );

      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
      const index: IndexFile = {
        version: 1,
        fileCount: 1,
        builtAt: old,
        domains: {},
      };

      const result = await checkStale(index, skillsDir);
      assert.equal(result.stale, false);
      assert.equal(result.ageWarning, true);
    });
  });

  describe('ensureIndex', () => {
    it('builds index on first call when none exists', async () => {
      await writeFile(
        join(skillsDir, 'api.com.json'),
        makeSkillJSON('api.com', [{ id: 'get-data', method: 'GET', path: '/data' }]),
      );

      const index = await ensureIndex(skillsDir);
      assert.equal(index.fileCount, 1);
      assert.equal(index.domains['api.com'].endpointCount, 1);
    });

    it('returns cached index when fresh', async () => {
      await writeFile(
        join(skillsDir, 'api.com.json'),
        makeSkillJSON('api.com', [{ id: 'get-data', method: 'GET', path: '/data' }]),
      );
      await buildIndex(skillsDir);

      const index = await ensureIndex(skillsDir);
      assert.equal(index.fileCount, 1);
    });

    it('rebuilds when file count changes', async () => {
      await writeFile(
        join(skillsDir, 'a.com.json'),
        makeSkillJSON('a.com', [{ id: 'get-a', method: 'GET', path: '/a' }]),
      );
      await buildIndex(skillsDir);

      // Add another file without going through writeSkillFile
      await writeFile(
        join(skillsDir, 'b.com.json'),
        makeSkillJSON('b.com', [{ id: 'get-b', method: 'GET', path: '/b' }]),
      );

      const index = await ensureIndex(skillsDir);
      assert.equal(index.fileCount, 2);
      assert.ok(index.domains['b.com']);
    });
  });
});

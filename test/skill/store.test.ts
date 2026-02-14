// test/skill/store.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile, readSkillFile, listSkillFiles } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

const makeSkill = (domain: string): SkillFile => ({
  version: '1.1',
  domain,
  capturedAt: '2026-02-04T12:00:00.000Z',
  baseUrl: `https://${domain}`,
  endpoints: [
    {
      id: 'get-api-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array', fields: ['id', 'name'] },
      examples: {
        request: { url: `https://${domain}/api/data`, headers: {} },
        responsePreview: [{ id: 1, name: 'test' }],
      },
    },
  ],
  metadata: { captureCount: 10, filteredCount: 8, toolVersion: '0.2.0' },
  provenance: 'unsigned',
});

describe('skill store', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('writes and reads a skill file', async () => {
    const skill = makeSkill('example.com');
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile('example.com', testDir);
    assert.deepEqual(loaded, skill);
  });

  it('lists skill files', async () => {
    await writeSkillFile(makeSkill('example.com'), testDir);
    await writeSkillFile(makeSkill('api.github.com'), testDir);

    const summaries = await listSkillFiles(testDir);
    const domains = summaries.map(s => s.domain).sort();
    assert.deepEqual(domains, ['api.github.com', 'example.com']);
    assert.equal(summaries[0].endpointCount, 1);
  });

  it('returns null for non-existent skill file', async () => {
    const result = await readSkillFile('nonexistent.com', testDir);
    assert.equal(result, null);
  });

  it('returns empty list when no skill files exist', async () => {
    const summaries = await listSkillFiles(testDir);
    assert.deepEqual(summaries, []);
  });

  it('creates .gitignore in base dir on first write', async () => {
    const baseDir = join(testDir, '.apitap');
    const skillsDir = join(baseDir, 'skills');
    await writeSkillFile(makeSkill('example.com'), skillsDir);

    const { readFile } = await import('node:fs/promises');
    const gitignore = await readFile(join(baseDir, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('auth.enc'));
  });

  it('does not overwrite existing .gitignore', async () => {
    const baseDir = join(testDir, '.apitap');
    const skillsDir = join(baseDir, 'skills');
    const { writeFile: wf, mkdir: mk, readFile: rf } = await import('node:fs/promises');
    await mk(baseDir, { recursive: true });
    await wf(join(baseDir, '.gitignore'), 'custom content\n');

    await writeSkillFile(makeSkill('example.com'), skillsDir);

    const gitignore = await rf(join(baseDir, '.gitignore'), 'utf-8');
    assert.equal(gitignore, 'custom content\n');
  });
});

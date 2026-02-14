import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSkillFile, writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

describe('F14: Domain path traversal', () => {
  it('rejects ../../etc/passwd', async () => {
    await assert.rejects(() => readSkillFile('../../etc/passwd'), /Invalid domain/);
  });

  it('rejects ../auth', async () => {
    await assert.rejects(() => readSkillFile('../auth'), /Invalid domain/);
  });

  it('rejects empty string', async () => {
    await assert.rejects(() => readSkillFile(''), /Invalid domain/);
  });

  it('rejects paths with slashes', async () => {
    await assert.rejects(() => readSkillFile('foo/bar'), /Invalid domain/);
  });

  it('rejects paths with backslashes', async () => {
    await assert.rejects(() => readSkillFile('foo\\bar'), /Invalid domain/);
  });

  it('accepts api.example.com', async () => {
    // Should not throw on validation — will return null because file doesn't exist
    const result = await readSkillFile('api.example.com', '/tmp/apitap-test-nonexistent');
    assert.equal(result, null);
  });

  it('accepts my-api.example.com', async () => {
    const result = await readSkillFile('my-api.example.com', '/tmp/apitap-test-nonexistent');
    assert.equal(result, null);
  });

  it('accepts domain with underscores', async () => {
    const result = await readSkillFile('my_api.example.com', '/tmp/apitap-test-nonexistent');
    assert.equal(result, null);
  });

  it('rejects domain starting with dot', async () => {
    await assert.rejects(() => readSkillFile('.hidden'), /Invalid domain/);
  });

  it('rejects domain starting with hyphen', async () => {
    await assert.rejects(() => readSkillFile('-flag'), /Invalid domain/);
  });
});

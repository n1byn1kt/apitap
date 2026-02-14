// test/skill/importer.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateImport, importSkillFile } from '../../src/skill/importer.js';
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    version: '1.1',
    domain: 'api.example.com',
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: 'https://api.example.com',
    endpoints: [{
      id: 'get-data',
      method: 'GET',
      path: '/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: {
        request: { url: 'https://api.example.com/data', headers: {} },
        responsePreview: null,
      },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
    provenance: 'unsigned',
    ...overrides,
  };
}

describe('skill file import', () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-import-'));
    skillsDir = join(testDir, 'skills');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validateImport', () => {
    it('accepts a valid unsigned skill file', () => {
      const result = validateImport(makeSkill());
      assert.equal(result.valid, true);
      assert.equal(result.signatureStatus, 'unsigned');
    });

    it('accepts a valid signed skill file with correct key', () => {
      const key = deriveKey('test-id');
      const signed = signSkillFile(makeSkill(), key);
      const result = validateImport(signed, key);
      assert.equal(result.valid, true);
      assert.equal(result.signatureStatus, 'valid');
    });

    it('rejects a tampered signed skill file', () => {
      const key = deriveKey('test-id');
      const signed = signSkillFile(makeSkill(), key);
      signed.domain = 'evil.com';
      const result = validateImport(signed, key);
      assert.equal(result.valid, false);
      assert.equal(result.signatureStatus, 'invalid');
    });

    it('rejects skill file with SSRF URLs', () => {
      const skill = makeSkill({ baseUrl: 'http://localhost:8080' });
      const result = validateImport(skill);
      assert.equal(result.valid, false);
      assert.ok(result.reason!.includes('SSRF'));
    });

    it('rejects skill file with SSRF in endpoint URLs', () => {
      const skill = makeSkill();
      skill.endpoints[0].examples.request.url = 'http://192.168.1.1/admin';
      const result = validateImport(skill);
      assert.equal(result.valid, false);
    });

    it('rejects invalid JSON structure', () => {
      const result = validateImport({} as SkillFile);
      assert.equal(result.valid, false);
    });
  });

  describe('importSkillFile', () => {
    it('copies skill file with provenance set to imported', async () => {
      const filePath = join(testDir, 'import.json');
      await writeFile(filePath, JSON.stringify(makeSkill()));

      const result = await importSkillFile(filePath, skillsDir);
      assert.equal(result.success, true);

      const { readSkillFile } = await import('../../src/skill/store.js');
      const loaded = await readSkillFile('api.example.com', skillsDir);
      assert.equal(loaded!.provenance, 'imported');
      assert.equal(loaded!.signature, undefined);
    });

    it('rejects file with SSRF URLs', async () => {
      const skill = makeSkill({ baseUrl: 'http://localhost:8080' });
      const filePath = join(testDir, 'bad.json');
      await writeFile(filePath, JSON.stringify(skill));

      const result = await importSkillFile(filePath, skillsDir);
      assert.equal(result.success, false);
      assert.ok(result.reason!.includes('SSRF'));
    });
  });
});

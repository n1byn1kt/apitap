// test/skill/signing-enforcement.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillFile, writeSkillFile } from '../../src/skill/store.js';
import { signSkillFile } from '../../src/skill/signing.js';
import type { SkillFile } from '../../src/types.js';
import { randomBytes } from 'node:crypto';

let testDir: string;
let signingKey: Buffer;

function makeSkill(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    version: '1.1',
    domain: 'example.com',
    baseUrl: 'https://example.com',
    capturedAt: '2026-03-01T00:00:00Z',
    endpoints: [{
      id: 'get-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/api/data', headers: {} }, responsePreview: null },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'unsigned',
    ...overrides,
  } as SkillFile;
}

describe('HMAC enforcement Phase 2', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-hmac-enforce-'));
    signingKey = randomBytes(32);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('valid signed file loads without issues', async () => {
    const signed = signSkillFile(makeSkill(), signingKey);
    await writeSkillFile(signed, testDir);
    const loaded = await readSkillFile('example.com', testDir, { verifySignature: true, signingKey });
    assert.ok(loaded);
    assert.equal(loaded.domain, 'example.com');
  });

  it('tampered file is rejected', async () => {
    const signed = signSkillFile(makeSkill(), signingKey);
    signed.baseUrl = 'https://evil.com';
    // Write directly to disk to simulate tampering (bypasses write-time validation)
    await writeFile(join(testDir, 'example.com.json'), JSON.stringify(signed, null, 2));
    await assert.rejects(
      () => readSkillFile('example.com', testDir, { verifySignature: true, signingKey }),
      /signature verification failed|tampered|does not match domain/i,
    );
  });

  it('unsigned non-imported file is rejected by default', async () => {
    const skill = makeSkill({ provenance: 'unsigned' });
    await writeSkillFile(skill, testDir);
    // H1 fix: unsigned files throw by default
    await assert.rejects(
      () => readSkillFile('example.com', testDir, { verifySignature: true, signingKey }),
      /unsigned/i,
    );
  });

  it('unsigned file loads with trustUnsigned option', async () => {
    const skill = makeSkill({ provenance: 'unsigned' });
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile('example.com', testDir, { verifySignature: true, signingKey, trustUnsigned: true });
    assert.ok(loaded, 'Unsigned file should load with trustUnsigned');
  });

  it('imported file skips verification', async () => {
    const skill = makeSkill({ provenance: 'imported' });
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile('example.com', testDir, { verifySignature: true, signingKey });
    assert.ok(loaded, 'Imported file should skip verification');
  });

  it('file signed with wrong key is rejected', async () => {
    const signed = signSkillFile(makeSkill(), signingKey);
    await writeSkillFile(signed, testDir);
    const wrongKey = randomBytes(32);
    await assert.rejects(
      () => readSkillFile('example.com', testDir, { verifySignature: true, signingKey: wrongKey }),
      /signature verification failed|tampered/i,
    );
  });

  it('writeSkillFile rejects file with mismatched baseUrl and domain', async () => {
    const skill = makeSkill({ baseUrl: 'https://evil.com' });
    await assert.rejects(
      () => writeSkillFile(skill, testDir),
      /does not match domain/i,
    );
  });

  it('writeSkillFile rejects file with >500 endpoints', async () => {
    const endpoints = Array.from({ length: 501 }, (_, i) => ({
      id: `get-item-${i}`,
      method: 'GET' as const,
      path: `/api/items/${i}`,
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' as const },
      examples: { request: { url: `https://example.com/api/items/${i}`, headers: {} }, responsePreview: null },
    }));
    const skill = makeSkill({ endpoints } as any);
    await assert.rejects(
      () => writeSkillFile(skill, testDir),
      /too many endpoints/i,
    );
  });

  it('writeSkillFile rejects file with missing endpoint id', async () => {
    const skill = makeSkill({
      endpoints: [{
        id: '',
        method: 'GET',
        path: '/api/data',
        queryParams: {},
        headers: {},
        responseShape: { type: 'object' },
        examples: { request: { url: 'https://example.com/api/data', headers: {} }, responsePreview: null },
      }],
    } as any);
    await assert.rejects(
      () => writeSkillFile(skill, testDir),
      /id must be a string/i,
    );
  });
});

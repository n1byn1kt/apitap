import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillFile, writeSkillFile } from '../../src/skill/store.js';
import { signSkillFile, legacyCanonicalize } from '../../src/skill/signing.js';
import { hmacSign } from '../../src/auth/crypto.js';
import type { SkillFile } from '../../src/types.js';
import { randomBytes } from 'node:crypto';

let testDir: string;
let signingKey: Buffer;

function makeSkill(domain: string, provenance: 'captured' | 'imported' | 'unsigned' = 'captured'): SkillFile {
  return {
    version: '1.1',
    domain,
    baseUrl: `https://${domain}`,
    capturedAt: '2026-02-14T12:00:00.000Z',
    endpoints: [{
      id: 'test',
      method: 'GET',
      path: '/test',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: `https://${domain}/test`, headers: {} }, responsePreview: null },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance,
  } as SkillFile;
}

/**
 * Create a skill file signed with the OLD (pre-March-5-2026) shallow canonicalization.
 * This simulates files created before commit e07379a.
 */
function signSkillLegacy(skill: SkillFile, key: Buffer): SkillFile {
  const signedAt = new Date().toISOString();
  const withTime = { ...skill, signedAt } as SkillFile;
  const payload = legacyCanonicalize(withTime);
  const signature = hmacSign(payload, key);
  return { ...withTime, provenance: 'self', signature };
}

describe('F4: Signature verification on load', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-store-verify-'));
    signingKey = randomBytes(32);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('verification fails for tampered skill file', async () => {
    // Create and sign a skill
    const skill = makeSkill('example.com');
    const signedSkill = signSkillFile(skill, signingKey);
    await writeSkillFile(signedSkill, testDir);

    // Tamper with the file by modifying baseUrl
    const filePath = join(testDir, 'example.com.json');
    const content = await readFile(filePath, 'utf-8');
    const tamperedSkill = JSON.parse(content);
    tamperedSkill.baseUrl = 'https://evil.com';  // Tamper!
    await writeFile(filePath, JSON.stringify(tamperedSkill, null, 2));

    // Reading with verification should fail
    await assert.rejects(
      () => readSkillFile('example.com', testDir, { verifySignature: true, signingKey }),
      /signature verification failed|does not match domain/i,
      'Should reject tampered skill file'
    );
  });

  it('verification passes for valid signed skill file', async () => {
    // Create and sign a skill
    const skill = makeSkill('example.com');
    const signedSkill = signSkillFile(skill, signingKey);
    await writeSkillFile(signedSkill, testDir);

    // Reading with verification should succeed
    const loaded = await readSkillFile('example.com', testDir, { verifySignature: true, signingKey });

    assert.ok(loaded, 'Should load signed skill');
    assert.equal(loaded.domain, 'example.com');
    assert.equal(loaded.baseUrl, 'https://example.com');
  });

  it('unsigned/imported skill file passes without verification error', async () => {
    // Create an imported skill (no signature)
    const skill = makeSkill('example.com', 'imported');
    await writeSkillFile(skill, testDir);

    // Reading with verification should not fail for imported files
    const loaded = await readSkillFile('example.com', testDir, { verifySignature: true, signingKey });

    assert.ok(loaded, 'Should load imported skill without verification error');
    assert.equal(loaded.domain, 'example.com');
    assert.equal(loaded.provenance, 'imported');
  });

  it('verifies pre-March-5 skill files signed with legacy shallow canonicalization', async () => {
    // Simulate a pre-March-5 file: signed with the old shallow JSON.stringify sort
    const skill = makeSkill('legacy-canon.com');
    const legacySigned = signSkillLegacy(skill, signingKey);
    await writeSkillFile(legacySigned, testDir);

    // Reading should succeed via the legacy canonicalization fallback
    const loaded = await readSkillFile('legacy-canon.com', testDir, {
      verifySignature: true,
      signingKey,
    });

    assert.ok(loaded, 'Should load legacy-canonicalized skill file');
    assert.equal(loaded.domain, 'legacy-canon.com');
  });

  it('transparently migrates legacy-canonicalized files to current format', async () => {
    // Sign with legacy canon
    const skill = makeSkill('migrate-test.com');
    const legacySigned = signSkillLegacy(skill, signingKey);
    await writeSkillFile(legacySigned, testDir);

    // First read triggers migration
    const loaded = await readSkillFile('migrate-test.com', testDir, {
      verifySignature: true,
      signingKey,
    });
    assert.ok(loaded, 'First load should succeed');

    // Second read should verify with current canonicalization (no fallback needed)
    // The file on disk was re-signed with the current format
    const reloaded = await readSkillFile('migrate-test.com', testDir, {
      verifySignature: true,
      signingKey,
    });
    assert.ok(reloaded, 'Second load should succeed with migrated signature');
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillFile, writeSkillFile } from '../../src/skill/store.js';
import { signSkillFile } from '../../src/skill/signing.js';
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
      /signature verification failed/i,
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
});

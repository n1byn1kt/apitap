// test/skill/signing.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signSkillFile, verifySignature, canonicalize } from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(): SkillFile {
  return {
    version: '1.1',
    domain: 'example.com',
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: 'https://example.com',
    endpoints: [{
      id: 'get-api-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: { 'authorization': '[stored]' },
      responseShape: { type: 'array', fields: ['id'] },
      examples: {
        request: { url: 'https://example.com/api/data', headers: {} },
        responsePreview: null,
      },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
    provenance: 'unsigned',
  };
}

describe('skill file signing', () => {
  const key = deriveKey('test-machine-id');

  it('signs a skill file and sets provenance to self', () => {
    const skill = makeSkill();
    const signed = signSkillFile(skill, key);

    assert.equal(signed.provenance, 'self');
    assert.ok(signed.signature?.startsWith('hmac-sha256:'));
  });

  it('verifies a valid signature', () => {
    const signed = signSkillFile(makeSkill(), key);
    assert.equal(verifySignature(signed, key), true);
  });

  it('rejects a tampered skill file', () => {
    const signed = signSkillFile(makeSkill(), key);
    signed.domain = 'evil.com';
    assert.equal(verifySignature(signed, key), false);
  });

  it('rejects a file signed with different key', () => {
    const signed = signSkillFile(makeSkill(), key);
    const otherKey = deriveKey('other-machine');
    assert.equal(verifySignature(signed, otherKey), false);
  });

  it('returns false for unsigned files', () => {
    const skill = makeSkill();
    assert.equal(verifySignature(skill, key), false);
  });

  it('canonicalize excludes signature and provenance', () => {
    const a = makeSkill();
    const b = { ...makeSkill(), signature: 'hmac-sha256:abc', provenance: 'self' as const };
    assert.equal(canonicalize(a), canonicalize(b));
  });
});

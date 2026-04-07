// test/skill/signing-egress-regression.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSkillFile, verifySignature } from '../../src/skill/signing.js';
import type { SkillFile } from '../../src/types.js';

const KEY = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');

function baseSkill(): SkillFile {
  return {
    version: '1.2',
    domain: 'api.example.com',
    capturedAt: '2026-04-06T00:00:00Z',
    baseUrl: 'https://api.example.com',
    endpoints: [],
    metadata: {
      captureCount: 0,
      filteredCount: 0,
      toolVersion: '1.9.4',
    },
    provenance: 'self',
  };
}

test('signing includes egress_check in the payload', () => {
  const noFlag = baseSkill();
  const withFlag: SkillFile = { ...baseSkill(), egress_check: true };

  const signedNoFlag = signSkillFile(noFlag, KEY);
  const signedWithFlag = signSkillFile(withFlag, KEY);

  assert.notEqual(signedNoFlag.signature, signedWithFlag.signature);
});

test('signing includes egress_action in the payload', () => {
  const annotate: SkillFile = { ...baseSkill(), egress_check: true, egress_action: 'annotate' };
  const block: SkillFile = { ...baseSkill(), egress_check: true, egress_action: 'block' };

  const signedAnnotate = signSkillFile(annotate, KEY);
  const signedBlock = signSkillFile(block, KEY);

  assert.notEqual(signedAnnotate.signature, signedBlock.signature);
});

test('flipping egress_check on a signed skill file invalidates signature', () => {
  const original: SkillFile = { ...baseSkill(), egress_check: true };
  const signed = signSkillFile(original, KEY);
  assert.equal(verifySignature(signed, KEY), true);

  const tampered: SkillFile = { ...signed, egress_check: false };
  assert.equal(verifySignature(tampered, KEY), false);
});

test('flipping egress_action on a signed skill file invalidates signature', () => {
  const original: SkillFile = { ...baseSkill(), egress_check: true, egress_action: 'block' };
  const signed = signSkillFile(original, KEY);
  assert.equal(verifySignature(signed, KEY), true);

  const tampered: SkillFile = { ...signed, egress_action: 'annotate' };
  assert.equal(verifySignature(tampered, KEY), false);
});

test('skill file without egress fields signs and verifies as before', () => {
  const skill = baseSkill();
  const signed = signSkillFile(skill, KEY);
  assert.equal(verifySignature(signed, KEY), true);
  assert.equal(signed.egress_check, undefined);
  assert.equal(signed.egress_action, undefined);
});

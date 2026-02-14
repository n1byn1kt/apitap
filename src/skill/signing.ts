// src/skill/signing.ts
import { hmacSign, hmacVerify } from '../auth/crypto.js';
import type { SkillFile } from '../types.js';

/**
 * Create a canonical JSON string from a skill file,
 * excluding `signature` and `provenance` fields.
 * This is the payload that gets signed.
 */
export function canonicalize(skill: SkillFile): string {
  const { signature: _sig, provenance: _prov, ...rest } = skill;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Sign a skill file. Returns a new object with signature and provenance: 'self'.
 */
export function signSkillFile(skill: SkillFile, key: Buffer): SkillFile {
  const payload = canonicalize(skill);
  const signature = hmacSign(payload, key);
  return {
    ...skill,
    provenance: 'self',
    signature,
  };
}

/**
 * Verify a skill file's signature.
 * Returns true if the signature is valid for the given key.
 */
export function verifySignature(skill: SkillFile, key: Buffer): boolean {
  if (!skill.signature) return false;
  const payload = canonicalize(skill);
  return hmacVerify(payload, skill.signature, key);
}

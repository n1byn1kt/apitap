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
  return JSON.stringify(sortKeysDeep(rest));
}

/**
 * Recursively sort all object keys for stable canonicalization (M10 fix).
 * Ensures identical skill files always produce the same canonical string
 * regardless of key insertion order at any nesting level.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Sign a skill file. Returns a new object with signature and provenance: 'self'.
 */
export function signSkillFile(skill: SkillFile, key: Buffer): SkillFile {
  const signedAt = new Date().toISOString();
  const payload = canonicalize({ ...skill, signedAt } as SkillFile);
  const signature = hmacSign(payload, key);
  return {
    ...skill,
    signedAt,
    provenance: 'self',
    signature,
  };
}

/**
 * Sign a skill file with a specific provenance value.
 * Use 'self' for captured files, 'imported-signed' for import-only files.
 */
export function signSkillFileAs(
  skill: SkillFile,
  key: Buffer,
  provenance: 'self' | 'imported-signed',
): SkillFile {
  const signedAt = new Date().toISOString();
  const payload = canonicalize({ ...skill, signedAt } as SkillFile);
  const signature = hmacSign(payload, key);
  return { ...skill, signedAt, provenance, signature };
}

/**
 * Legacy (pre-March-5-2026) canonicalization: shallow key sort only.
 * Used before commit e07379a introduced sortKeysDeep.
 * Needed for backward-compatible signature verification.
 */
export function legacyCanonicalize(skill: SkillFile): string {
  const { signature: _sig, provenance: _prov, ...rest } = skill;
  return JSON.stringify(rest, Object.keys(rest).sort());
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

/**
 * Verify using the legacy (shallow) canonicalization.
 * Returns true if the signature matches the old format.
 */
export function verifySignatureLegacyCanon(skill: SkillFile, key: Buffer): boolean {
  if (!skill.signature) return false;
  const payload = legacyCanonicalize(skill);
  return hmacVerify(payload, skill.signature, key);
}

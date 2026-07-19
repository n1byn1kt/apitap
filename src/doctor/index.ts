// src/doctor/index.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedSkill, SignatureStatus } from './types.js';
import type { SkillFile } from '../types.js';
import { validateSkillFile } from '../skill/validate.js';
import {
  verifySignature,
  verifySignatureLegacyCanon,
  verifySignaturePreProvenance,
} from '../skill/signing.js';

/** Mirrors store.ts MAX_SIGNATURE_AGE_DAYS (not exported there). */
const MAX_SIGNATURE_AGE_DAYS = 180;

function signatureStatusOf(skill: SkillFile, key: Buffer, now: Date): SignatureStatus {
  if (!skill.signature) return 'unsigned';
  const verified =
    verifySignature(skill, key) ||
    verifySignatureLegacyCanon(skill, key) ||
    verifySignaturePreProvenance(skill, key);
  if (!verified) return 'mismatch';
  if (skill.signedAt) {
    const signedAtMs = Date.parse(skill.signedAt);
    if (!Number.isNaN(signedAtMs) &&
        now.getTime() - signedAtMs > MAX_SIGNATURE_AGE_DAYS * 24 * 60 * 60 * 1000) {
      return 'expired';
    }
  }
  return 'valid';
}

/**
 * Doctor's soft loader. Enumerates by readdir of top-level *.json — NOT via
 * listSkillFiles (index-driven; buildIndex skips unparseable files, which are
 * exactly the files doctor exists to find). Never throws per-file: a broken
 * file becomes signatureStatus 'invalid-file' with skill: null.
 */
export async function loadSkillsForDoctor(
  skillsDir: string,
  signingKey: Buffer,
  now: Date,
): Promise<LoadedSkill[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const out: LoadedSkill[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name === 'index.json') continue;
    const domain = e.name.slice(0, -'.json'.length);
    const filePath = join(skillsDir, e.name);
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      const skill = validateSkillFile(raw);
      out.push({ domain, filePath, skill, signatureStatus: signatureStatusOf(skill, signingKey, now) });
    } catch (err) {
      out.push({
        domain, filePath, skill: null, signatureStatus: 'invalid-file',
        loadError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

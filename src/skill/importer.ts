// src/skill/importer.ts
import { readFile } from 'node:fs/promises';
import { verifySignature } from './signing.js';
import { validateSkillFileUrls } from './ssrf.js';
import { writeSkillFile } from './store.js';
import type { SkillFile } from '../types.js';

export interface ImportValidation {
  valid: boolean;
  reason?: string;
  signatureStatus: 'valid' | 'invalid' | 'unsigned';
  summary?: {
    domain: string;
    endpointCount: number;
    baseUrl: string;
  };
}

export interface ImportResult {
  success: boolean;
  reason?: string;
  skillFile?: string;
}

/**
 * Validate a skill file for import.
 * Checks structure, SSRF safety, and signature integrity.
 */
export function validateImport(skill: SkillFile, localKey?: Buffer): ImportValidation {
  // Basic structure validation
  if (!skill.domain || !skill.baseUrl || !Array.isArray(skill.endpoints)) {
    return { valid: false, reason: 'Invalid skill file structure', signatureStatus: 'unsigned' };
  }

  // Signature check
  let signatureStatus: ImportValidation['signatureStatus'] = 'unsigned';
  if (skill.signature) {
    if (localKey && verifySignature(skill, localKey)) {
      signatureStatus = 'valid';
    } else {
      return {
        valid: false,
        reason: 'Skill file signature is invalid — file was tampered with or signed by a different instance',
        signatureStatus: 'invalid',
      };
    }
  }

  // SSRF validation
  const ssrfResult = validateSkillFileUrls(skill);
  if (!ssrfResult.safe) {
    return {
      valid: false,
      reason: `SSRF risk: ${ssrfResult.reason}`,
      signatureStatus,
    };
  }

  return {
    valid: true,
    signatureStatus,
    summary: {
      domain: skill.domain,
      endpointCount: skill.endpoints.length,
      baseUrl: skill.baseUrl,
    },
  };
}

/**
 * Import a skill file from disk.
 * Validates, strips foreign signatures, sets provenance to 'imported'.
 */
export async function importSkillFile(
  filePath: string,
  skillsDir?: string,
  localKey?: Buffer,
): Promise<ImportResult> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    return { success: false, reason: `Cannot read file: ${(err as Error).message}` };
  }

  let skill: SkillFile;
  try {
    skill = JSON.parse(content);
  } catch {
    return { success: false, reason: 'File is not valid JSON' };
  }

  const validation = validateImport(skill, localKey);
  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  // Strip foreign signature, set provenance
  const importedSkill: SkillFile = {
    ...skill,
    provenance: 'imported',
    signature: undefined,
  };

  const writtenPath = await writeSkillFile(importedSkill, skillsDir);
  return { success: true, skillFile: writtenPath };
}

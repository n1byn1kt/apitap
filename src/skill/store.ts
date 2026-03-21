// src/skill/store.ts
import { readFile, writeFile, mkdir, readdir, access, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile, SkillSummary } from '../types.js';
import { validateSkillFile } from './validate.js';
import { updateIndex, ensureIndex } from './index.js';

const DEFAULT_SKILLS_DIR = join(homedir(), '.apitap', 'skills');

const BASE_GITIGNORE = `# ApiTap — prevent accidental credential commits
auth.enc
*.key
`;

function skillPath(domain: string, skillsDir: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  return join(skillsDir, `${domain}.json`);
}

async function ensureGitignore(skillsDir: string): Promise<void> {
  const baseDir = dirname(skillsDir);
  const gitignorePath = join(baseDir, '.gitignore');

  try {
    await access(gitignorePath);
    // File exists, don't overwrite
  } catch {
    // File doesn't exist, create it
    await mkdir(baseDir, { recursive: true });
    await writeFile(gitignorePath, BASE_GITIGNORE);
  }
}

export async function writeSkillFile(
  skill: SkillFile,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<string> {
  // Validate before writing — catch bad data at the source, not on read
  validateSkillFile(skill);

  await mkdir(skillsDir, { recursive: true, mode: 0o700 });
  await ensureGitignore(skillsDir);
  const filePath = skillPath(skill.domain, skillsDir);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const content = JSON.stringify(skill, null, 2) + '\n';
  await writeFile(tmpPath, content, { mode: 0o600 });
  await rename(tmpPath, filePath);

  // Incrementally update the search index
  try {
    await updateIndex(
      skill.domain,
      skill.endpoints.map(ep => ({
        id: ep.id,
        method: ep.method,
        path: ep.path,
        ...(ep.replayability?.tier ? { tier: ep.replayability.tier } : {}),
        ...(ep.replayability?.verified ? { verified: true } : {}),
      })),
      skill.provenance ?? 'unsigned',
      skillsDir,
      skill.capturedAt,
    );
  } catch {
    // Index update failure should not block writes
  }

  return filePath;
}

export async function readSkillFile(
  domain: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
  options?: {
    verifySignature?: boolean;
    signingKey?: Buffer;
    /** Allow loading unsigned files without throwing. Tampered signed files still reject. */
    trustUnsigned?: boolean;
  }
): Promise<SkillFile | null> {
  // Validate domain before file I/O — path traversal should throw, not return null
  const path = skillPath(domain, skillsDir);
  try {
    const content = await readFile(path, 'utf-8');
    const raw = JSON.parse(content);
    const skill = validateSkillFile(raw);

    // Signature verification is ON by default (H1 fix)
    const shouldVerify = options?.verifySignature !== false;
    if (shouldVerify) {
      // Auto-derive signing key if not provided
      let signingKey = options?.signingKey;
      if (!signingKey) {
        const { deriveSigningKey } = await import('../auth/crypto.js');
        const { getMachineId } = await import('../auth/manager.js');
        const machineId = await getMachineId();
        signingKey = deriveSigningKey(machineId);
      }

      if (skill.provenance === 'imported') {
        // Imported files had foreign signature stripped — can't verify
      } else if (!skill.signature) {
        // Unsigned files are rejected unless trustUnsigned is set
        if (!options?.trustUnsigned) {
          throw new Error(
            `Skill file for ${domain} is unsigned and cannot be verified. ` +
            `Re-capture or re-import the skill file, or use --trust-unsigned to load it.`
          );
        }
      } else {
        const { verifySignature } = await import('./signing.js');
        let verified = verifySignature(skill, signingKey);
        if (!verified) {
          // Fallback: try pre-v1.4.0 legacy key (before HKDF signing key separation)
          // Files signed with deriveKey() directly (not deriveSigningKey()) will match here
          const { deriveKey } = await import('../auth/crypto.js');
          const { getMachineId } = await import('../auth/manager.js');
          const machineId = await getMachineId();
          const legacyKey = deriveKey(machineId);
          verified = verifySignature(skill, legacyKey);
        }
        if (!verified) {
          throw new Error(`Skill file signature verification failed for ${domain} — file may be tampered`);
        }
      }
    }

    return skill;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Fault-tolerant wrapper around readSkillFile — returns null instead of
 * throwing on validation errors, bad signatures, etc.  ENOENT (missing
 * file) also returns null.  Use this when iterating many files where one
 * bad file should not abort the whole operation.
 */
export async function safeReadSkillFile(
  domain: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
  options?: Parameters<typeof readSkillFile>[2],
): Promise<SkillFile | null> {
  try {
    return await readSkillFile(domain, skillsDir, options);
  } catch {
    return null;
  }
}

export async function listSkillFiles(
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<SkillSummary[]> {
  const index = await ensureIndex(skillsDir);
  const summaries: SkillSummary[] = [];

  for (const [domain, entry] of Object.entries(index.domains)) {
    summaries.push({
      domain,
      skillFile: join(skillsDir, `${domain}.json`),
      endpointCount: entry.endpointCount,
      capturedAt: entry.capturedAt || index.builtAt,
      provenance: entry.provenance,
    });
  }

  return summaries;
}

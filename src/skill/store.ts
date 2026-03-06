// src/skill/store.ts
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile, SkillSummary } from '../types.js';
import { validateSkillFile } from './validate.js';

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
  await mkdir(skillsDir, { recursive: true, mode: 0o700 });
  await ensureGitignore(skillsDir);
  const filePath = skillPath(skill.domain, skillsDir);
  await writeFile(filePath, JSON.stringify(skill, null, 2) + '\n', { mode: 0o600 });
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
        if (!verifySignature(skill, signingKey)) {
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

export async function listSkillFiles(
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<SkillSummary[]> {
  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    return [];
  }

  const summaries: SkillSummary[] = [];
  const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const domain = file.replace(/\.json$/, '');
    if (!DOMAIN_RE.test(domain)) continue; // skip non-conforming filenames
    const skill = await readSkillFile(domain, skillsDir, { trustUnsigned: true });
    if (skill) {
      summaries.push({
        domain: skill.domain,
        skillFile: join(skillsDir, file),
        endpointCount: skill.endpoints.length,
        capturedAt: skill.capturedAt,
        provenance: skill.provenance ?? 'unsigned',
      });
    }
  }

  return summaries;
}

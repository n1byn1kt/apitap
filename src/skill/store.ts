// src/skill/store.ts
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile, SkillSummary } from '../types.js';

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
  await mkdir(skillsDir, { recursive: true });
  await ensureGitignore(skillsDir);
  const filePath = skillPath(skill.domain, skillsDir);
  await writeFile(filePath, JSON.stringify(skill, null, 2) + '\n');
  return filePath;
}

export async function readSkillFile(
  domain: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
  options?: { verifySignature?: boolean; signingKey?: Buffer }
): Promise<SkillFile | null> {
  // Validate domain before file I/O — path traversal should throw, not return null
  const path = skillPath(domain, skillsDir);
  try {
    const content = await readFile(path, 'utf-8');
    const skill = JSON.parse(content) as SkillFile;

    // If verification requested, check signature
    if (options?.verifySignature && options.signingKey) {
      if (skill.provenance === 'imported') {
        // Imported files had foreign signature stripped — can't verify, warn only
        // Future: re-sign on import with local key
      } else if (!skill.signature) {
        // No signature present on non-imported file
        throw new Error(`Skill file for ${domain} has no signature — file may be tampered`);
      } else {
        const { verifySignature } = await import('./signing.js');
        if (!verifySignature(skill, options.signingKey)) {
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
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const domain = file.replace(/\.json$/, '');
    const skill = await readSkillFile(domain, skillsDir);
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

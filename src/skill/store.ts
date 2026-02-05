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
): Promise<SkillFile | null> {
  try {
    const content = await readFile(skillPath(domain, skillsDir), 'utf-8');
    return JSON.parse(content) as SkillFile;
  } catch {
    return null;
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

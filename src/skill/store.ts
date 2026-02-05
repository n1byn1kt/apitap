// src/skill/store.ts
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile, SkillSummary } from '../types.js';

const DEFAULT_SKILLS_DIR = join(homedir(), '.apitap', 'skills');

function skillPath(domain: string, skillsDir: string): string {
  return join(skillsDir, `${domain}.json`);
}

export async function writeSkillFile(
  skill: SkillFile,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<string> {
  await mkdir(skillsDir, { recursive: true });
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
      });
    }
  }

  return summaries;
}

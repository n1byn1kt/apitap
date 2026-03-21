// src/skill/index.ts
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// --- Types ---

export interface IndexEndpoint {
  id: string;
  method: string;
  path: string;
  tier?: string;
  verified?: boolean;
}

export interface IndexDomain {
  endpointCount: number;
  provenance: 'self' | 'imported-signed' | 'imported' | 'unsigned';
  capturedAt: string;
  endpoints: IndexEndpoint[];
}

export interface IndexFile {
  version: number;
  fileCount: number;
  builtAt: string;
  domains: Record<string, IndexDomain>;
}

// --- Paths ---

const DEFAULT_SKILLS_DIR = join(homedir(), '.apitap', 'skills');
const INDEX_VERSION = 1;

function indexPath(skillsDir: string): string {
  return join(skillsDir, '..', 'index.json');
}

// --- Read ---

/**
 * Read the index file. Returns null if missing or unparseable.
 */
export async function readIndex(skillsDir: string = DEFAULT_SKILLS_DIR): Promise<IndexFile | null> {
  try {
    const content = await readFile(indexPath(skillsDir), 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed.version !== INDEX_VERSION) return null;
    return parsed as IndexFile;
  } catch {
    return null;
  }
}

// --- Stale detection ---

const STALE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function countSkillFiles(skillsDir: string): Promise<number> {
  try {
    const files = await readdir(skillsDir);
    return files.filter(f => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export interface StaleCheck {
  stale: boolean;
  reason?: 'missing' | 'filecount-mismatch' | 'version-mismatch';
  ageWarning?: boolean;
}

/**
 * Check if the index is stale. Returns { stale, reason, ageWarning }.
 * ageWarning is true if the index is >24h old but fileCount matches (soft signal).
 */
export async function checkStale(
  index: IndexFile | null,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<StaleCheck> {
  if (!index) return { stale: true, reason: 'missing' };
  if (index.version !== INDEX_VERSION) return { stale: true, reason: 'version-mismatch' };

  const diskCount = await countSkillFiles(skillsDir);
  if (diskCount !== index.fileCount) return { stale: true, reason: 'filecount-mismatch' };

  const age = Date.now() - new Date(index.builtAt).getTime();
  if (age > STALE_AGE_MS) return { stale: false, ageWarning: true };

  return { stale: false };
}

// --- Build (full rebuild) ---

/**
 * Full rebuild of the index from all skill files on disk.
 * No validation or HMAC checks — index is a read-only metadata cache.
 */
export async function buildIndex(skillsDir: string = DEFAULT_SKILLS_DIR): Promise<IndexFile> {
  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    files = [];
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  const domains: Record<string, IndexDomain> = {};

  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(skillsDir, file), 'utf-8');
      const skill = JSON.parse(content);
      const domain = file.replace(/\.json$/, '');

      if (!skill.endpoints || !Array.isArray(skill.endpoints)) continue;

      domains[domain] = {
        endpointCount: skill.endpoints.length,
        provenance: skill.provenance ?? 'unsigned',
        capturedAt: skill.capturedAt ?? '',
        endpoints: skill.endpoints.map((ep: any) => ({
          id: ep.id ?? '',
          method: ep.method ?? 'GET',
          path: ep.path ?? '/',
          ...(ep.replayability?.tier ? { tier: ep.replayability.tier } : {}),
          ...(ep.replayability?.verified ? { verified: true } : {}),
        })),
      };
    } catch {
      // Skip unparseable files
    }
  }

  const index: IndexFile = {
    version: INDEX_VERSION,
    fileCount: jsonFiles.length,
    builtAt: new Date().toISOString(),
    domains,
  };

  await writeIndexAtomic(index, skillsDir);
  return index;
}

// --- Incremental update ---

/**
 * Update a single domain entry in the index after writeSkillFile().
 * Increments fileCount only for genuinely new domains.
 */
export async function updateIndex(
  domain: string,
  endpoints: IndexEndpoint[],
  provenance: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
  capturedAt: string = '',
): Promise<void> {
  const existing = await readIndex(skillsDir);
  const index: IndexFile = existing ?? {
    version: INDEX_VERSION,
    fileCount: 0,
    builtAt: '',
    domains: {},
  };

  const isNew = !(domain in index.domains);

  index.domains[domain] = {
    endpointCount: endpoints.length,
    provenance: (provenance ?? 'unsigned') as IndexDomain['provenance'],
    capturedAt,
    endpoints,
  };

  if (isNew) {
    index.fileCount += 1;
  }
  index.builtAt = new Date().toISOString();

  await writeIndexAtomic(index, skillsDir);
}

// --- Remove from index ---

/**
 * Remove a domain from the index after forgetSkillFile().
 */
export async function removeFromIndex(
  domain: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<void> {
  const existing = await readIndex(skillsDir);
  if (!existing) return;

  if (domain in existing.domains) {
    delete existing.domains[domain];
    existing.fileCount -= 1;
    existing.builtAt = new Date().toISOString();
    await writeIndexAtomic(existing, skillsDir);
  }
}

// --- Ensure index (read with stale check + auto-rebuild) ---

/**
 * Read the index, rebuilding if stale or missing.
 * Logs warnings to stderr for observability.
 */
export async function ensureIndex(skillsDir: string = DEFAULT_SKILLS_DIR): Promise<IndexFile> {
  let index = await readIndex(skillsDir);
  const staleCheck = await checkStale(index, skillsDir);

  if (staleCheck.stale) {
    if (staleCheck.reason === 'missing') {
      process.stderr.write('Search index not found — rebuilding (this may take a moment)...\n');
    } else {
      process.stderr.write('Search index is stale — rebuilding...\n');
    }
    index = await buildIndex(skillsDir);
  } else if (staleCheck.ageWarning) {
    process.stderr.write(
      "Search index is over 24h old — run 'apitap index build' if you've edited skill files manually\n",
    );
  }

  return index!;
}

// --- Internal ---

async function writeIndexAtomic(index: IndexFile, skillsDir: string): Promise<void> {
  const path = indexPath(skillsDir);
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(index));
  await rename(tmpPath, path);
}

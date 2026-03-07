import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Types re-declared here (extension types can't be imported due to different tsconfig).
// Keep in sync with extension/src/types.ts IndexFile/IndexEntry/IndexEndpoint.
export interface IndexFile {
  v: 1;
  updatedAt: string;
  entries: IndexEntry[];
}

export interface IndexEntry {
  domain: string;
  firstSeen: string;
  lastSeen: string;
  totalHits: number;
  promoted: boolean;
  lastPromoted?: string;
  skillFileSource?: 'extension' | 'cli';
  endpoints: IndexEndpoint[];
}

export interface IndexEndpoint {
  path: string;
  methods: string[];
  authType?: string;
  hasBody: boolean;
  hits: number;
  lastSeen: string;
  pagination?: string;
  type?: 'graphql';
  queryParamNames?: string[];
}

const DEFAULT_APITAP_DIR = path.join(os.homedir(), '.apitap');

/**
 * Read the full passive index from disk.
 * Returns null if index.json doesn't exist or is invalid.
 */
export async function readIndex(apitapDir: string = DEFAULT_APITAP_DIR): Promise<IndexFile | null> {
  const indexPath = path.join(apitapDir, 'index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed as IndexFile;
  } catch {
    return null;
  }
}

/**
 * Read a single domain's index entry.
 * Returns null if the domain is not in the index.
 */
export async function readIndexEntry(
  domain: string,
  apitapDir: string = DEFAULT_APITAP_DIR,
): Promise<IndexEntry | null> {
  const index = await readIndex(apitapDir);
  if (!index) return null;
  return index.entries.find(e => e.domain === domain) ?? null;
}

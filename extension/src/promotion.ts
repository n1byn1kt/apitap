import type { IndexFile } from './types.js';

/**
 * Mark a domain as promoted in the index.
 * Called after a successful CDP capture generates a skill file.
 */
export function markPromoted(
  index: IndexFile,
  domain: string,
  source: 'extension' | 'cli',
): IndexFile {
  const entries = index.entries.map(entry => {
    if (entry.domain !== domain) return entry;
    return {
      ...entry,
      promoted: true,
      lastPromoted: new Date().toISOString(),
      skillFileSource: source,
    };
  });

  return { ...index, entries, updatedAt: new Date().toISOString() };
}

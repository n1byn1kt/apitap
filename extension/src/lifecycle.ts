import type { IndexFile } from './types.js';

const STALE_DAYS = 90;
const DELETE_DAYS = 180;
const DOMAIN_CAP = 500;

export interface LifecycleResult {
  index: IndexFile;
  stale: string[];    // domains flagged as stale (90+ days inactive)
  deleted: string[];  // domains removed (180+ days inactive)
  overCap: boolean;   // true if entry count > 500
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Apply lifecycle rules to the index.
 * - Flags stale entries (90+ days inactive)
 * - Removes dead entries (180+ days inactive)
 * - Warns on soft cap (500+ domains)
 * Never silently drops entries below the hard-delete threshold.
 */
export function applyLifecycle(index: IndexFile): LifecycleResult {
  const stale: string[] = [];
  const deleted: string[] = [];

  const surviving = index.entries.filter(entry => {
    const inactiveDays = daysSince(entry.lastSeen);

    if (inactiveDays >= DELETE_DAYS) {
      deleted.push(entry.domain);
      return false;
    }

    if (inactiveDays >= STALE_DAYS) {
      stale.push(entry.domain);
    }

    return true;
  });

  return {
    index: { ...index, entries: surviving, updatedAt: new Date().toISOString() },
    stale,
    deleted,
    overCap: surviving.length > DOMAIN_CAP,
  };
}

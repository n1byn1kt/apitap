import { mkdir, rename, copyFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

const QUARANTINE_DIR = '.quarantine';
const SNAPSHOT_DIR = '.doctor';

/**
 * Mirrors store.ts's skillPath regex + forget's '..' rejection. Every join()
 * in this module is derived from `domain`, so this guard confines all of
 * them to the skills dir — no traversal via crafted --restore/--domain args.
 */
function assertValidDomain(domain: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(domain) || domain.includes('..')) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

export function quarantinePath(skillsDir: string, domain: string): string {
  assertValidDomain(domain);
  return join(skillsDir, QUARANTINE_DIR, `${domain}.json`);
}

export function snapshotPath(skillsDir: string, domain: string): string {
  assertValidDomain(domain);
  return join(skillsDir, SNAPSHOT_DIR, `${domain}.json.orig`);
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Copy the live file to .doctor/<domain>.json.orig — first touch only. */
export async function snapshotOnce(skillsDir: string, domain: string): Promise<boolean> {
  assertValidDomain(domain);
  await mkdir(join(skillsDir, SNAPSHOT_DIR), { recursive: true, mode: 0o700 });
  try {
    await copyFile(join(skillsDir, `${domain}.json`), snapshotPath(skillsDir, domain), fsConstants.COPYFILE_EXCL);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Move (never delete) a skill file into quarantine. Never clobbers an
 * existing quarantined copy for the same domain — if the unsuffixed
 * destination is already taken, move to a timestamped name instead. The
 * existence check has a tiny TOCTOU window, which is fine under this tool's
 * same-user threat model.
 */
export async function quarantineSkill(skillsDir: string, domain: string): Promise<void> {
  assertValidDomain(domain);
  await mkdir(join(skillsDir, QUARANTINE_DIR), { recursive: true, mode: 0o700 });
  const dest = quarantinePath(skillsDir, domain);
  const target = (await exists(dest))
    ? join(skillsDir, QUARANTINE_DIR, `${domain}.${Date.now()}.json`)
    : dest;
  await rename(join(skillsDir, `${domain}.json`), target);
}

/**
 * Restore rules (spec): .orig wins (oldest pre-doctor original, overwrites a
 * doctor-edited live file by design); quarantine restore refuses when a live
 * file exists (re-captured after quarantine). Bytes verbatim, never re-signs.
 */
export async function restoreSkill(skillsDir: string, domain: string): Promise<'orig' | 'quarantine'> {
  assertValidDomain(domain);
  const live = join(skillsDir, `${domain}.json`);
  const orig = snapshotPath(skillsDir, domain);
  const quar = quarantinePath(skillsDir, domain);
  if (await exists(orig)) {
    await copyFile(orig, live);
    return 'orig';
  }
  if (await exists(quar)) {
    if (await exists(live)) {
      throw new Error(
        `refusing to overwrite live skill for ${domain} — it was re-captured after quarantine. ` +
        `The quarantined copy stays at ${quar}.`,
      );
    }
    await rename(quar, live);
    return 'quarantine';
  }
  throw new Error(`nothing to restore for ${domain}`);
}

import { mkdir, rename, copyFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

const QUARANTINE_DIR = '.quarantine';
const SNAPSHOT_DIR = '.doctor';

export function quarantinePath(skillsDir: string, domain: string): string {
  return join(skillsDir, QUARANTINE_DIR, `${domain}.json`);
}

export function snapshotPath(skillsDir: string, domain: string): string {
  return join(skillsDir, SNAPSHOT_DIR, `${domain}.json.orig`);
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Copy the live file to .doctor/<domain>.json.orig — first touch only. */
export async function snapshotOnce(skillsDir: string, domain: string): Promise<boolean> {
  await mkdir(join(skillsDir, SNAPSHOT_DIR), { recursive: true, mode: 0o700 });
  try {
    await copyFile(join(skillsDir, `${domain}.json`), snapshotPath(skillsDir, domain), fsConstants.COPYFILE_EXCL);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/** Move (never delete) a skill file into quarantine. */
export async function quarantineSkill(skillsDir: string, domain: string): Promise<void> {
  await mkdir(join(skillsDir, QUARANTINE_DIR), { recursive: true, mode: 0o700 });
  await rename(join(skillsDir, `${domain}.json`), quarantinePath(skillsDir, domain));
}

/**
 * Restore rules (spec): .orig wins (oldest pre-doctor original, overwrites a
 * doctor-edited live file by design); quarantine restore refuses when a live
 * file exists (re-captured after quarantine). Bytes verbatim, never re-signs.
 */
export async function restoreSkill(skillsDir: string, domain: string): Promise<'orig' | 'quarantine'> {
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

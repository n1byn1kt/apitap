// src/doctor/index.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedSkill, SignatureStatus } from './types.js';
import type { SkillFile } from '../types.js';
import { validateSkillFile } from '../skill/validate.js';
import {
  verifySignature,
  verifySignatureLegacyCanon,
  verifySignaturePreProvenance,
  signSkillFileAs,
  provenanceForSigning,
} from '../skill/signing.js';
import { writeSkillFile } from '../skill/store.js';
import { removeFromIndex } from '../skill/index.js';
import { quarantineSkill, snapshotOnce } from './snapshot.js';
import { junkDomain } from './checks/junk-domain.js';
import { beaconEndpoints } from './checks/beacon-endpoints.js';
import { duplicateEndpoints } from './checks/duplicate-endpoints.js';
import { staleCapture } from './checks/stale-capture.js';
import { unverifiedTier } from './checks/unverified-tier.js';
import { unparameterizedPaths } from './checks/unparameterized-paths.js';
import { emptySkill } from './checks/empty-skill.js';
import { signatureFindings } from './checks/invalid-signature.js';
import type { AppliedFix, Check, CheckContext, DoctorReport, Finding } from './types.js';

/** Mirrors store.ts MAX_SIGNATURE_AGE_DAYS (not exported there). */
const MAX_SIGNATURE_AGE_DAYS = 180;

function signatureStatusOf(skill: SkillFile, key: Buffer, now: Date): SignatureStatus {
  if (!skill.signature) return 'unsigned';
  const verified =
    verifySignature(skill, key) ||
    verifySignatureLegacyCanon(skill, key) ||
    verifySignaturePreProvenance(skill, key);
  if (!verified) return 'mismatch';
  if (skill.signedAt) {
    const signedAtMs = Date.parse(skill.signedAt);
    if (!Number.isNaN(signedAtMs) &&
        now.getTime() - signedAtMs > MAX_SIGNATURE_AGE_DAYS * 24 * 60 * 60 * 1000) {
      return 'expired';
    }
  }
  return 'valid';
}

/**
 * Doctor's soft loader. Enumerates by readdir of top-level *.json — NOT via
 * listSkillFiles (index-driven; buildIndex skips unparseable files, which are
 * exactly the files doctor exists to find). Never throws per-file: a broken
 * file becomes signatureStatus 'invalid-file' with skill: null.
 */
export async function loadSkillsForDoctor(
  skillsDir: string,
  signingKey: Buffer,
  now: Date,
): Promise<LoadedSkill[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const out: LoadedSkill[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name === 'index.json') continue;
    const domain = e.name.slice(0, -'.json'.length);
    const filePath = join(skillsDir, e.name);
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      const skill = validateSkillFile(raw);
      out.push({ domain, filePath, skill, signatureStatus: signatureStatusOf(skill, signingKey, now) });
    } catch (err) {
      out.push({
        domain, filePath, skill: null, signatureStatus: 'invalid-file',
        loadError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export const CHECKS: Check[] = [
  junkDomain, beaconEndpoints, duplicateEndpoints, emptySkill,
  staleCapture, unverifiedTier, unparameterizedPaths,
];

export interface DoctorOptions {
  skillsDir: string;
  signingKey: Buffer;
  fix?: boolean;
  domain?: string;
  staleDays?: number;
  now?: Date;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const ctx: CheckContext = { now: opts.now ?? new Date(), staleDays: opts.staleDays ?? 90 };
  let loaded = await loadSkillsForDoctor(opts.skillsDir, opts.signingKey, ctx.now);
  if (opts.domain) loaded = loaded.filter(l => l.domain === opts.domain);

  const findings: Finding[] = [];
  const fixes: AppliedFix[] = [];
  const quarantined: string[] = [];

  for (const l of loaded) {
    findings.push(...signatureFindings(l));
    if (!l.skill) continue;

    const fileFindings = CHECKS.flatMap(c => c.scan(l.skill!, ctx));
    findings.push(...fileFindings);
    if (!opts.fix) continue;

    // Integrity gate: edits only on files whose signature verifies —
    // editing + re-signing anything else would launder tampering.
    const canEdit = l.signatureStatus === 'valid';

    // Quarantine wins: if any fixable finding plans a quarantine, do only that.
    const fixableIds = new Set(fileFindings.filter(f => f.fixable).map(f => f.checkId));
    let current = l.skill;
    let edited = false;
    let doQuarantine = false;
    let quarantineCheckId = '';

    for (const check of CHECKS) {
      if (!fixableIds.has(check.id) || !check.fix) continue;
      // Re-scan against the current (possibly already-edited) skill so
      // chained fixes don't act on stale findings.
      const fresh = check.scan(current, ctx).find(f => f.fixable);
      if (!fresh) continue;
      const plan = check.fix(current, fresh);
      if (plan.action === 'quarantine') {
        doQuarantine = true;
        quarantineCheckId = check.id;
        break;
      }
      if (!canEdit) continue; // refused: reported but not applied
      current = plan.skill;
      edited = true;
      fixes.push({ domain: l.domain, checkId: check.id, action: 'edit' });
    }

    if (doQuarantine) {
      await quarantineSkill(opts.skillsDir, l.domain);
      try { await removeFromIndex(l.domain, opts.skillsDir); } catch { /* index best-effort */ }
      quarantined.push(l.domain);
      fixes.push({ domain: l.domain, checkId: quarantineCheckId, action: 'quarantine' });
      // edits before a quarantine never hit disk — drop their fix records
      for (let i = fixes.length - 2; i >= 0; i--) {
        if (fixes[i].domain === l.domain && fixes[i].action === 'edit') fixes.splice(i, 1);
      }
      continue;
    }

    if (edited) {
      await snapshotOnce(opts.skillsDir, l.domain);
      const resigned = signSkillFileAs(
        { ...current, signature: undefined, signedAt: undefined } as typeof current,
        opts.signingKey,
        provenanceForSigning(current),
      );
      await writeSkillFile(resigned, opts.skillsDir);
    }
  }

  const fixedKey = new Set(fixes.map(f => `${f.domain} ${f.checkId}`));
  const remaining = findings.filter(f => !(f.fixable && fixedKey.has(`${f.domain} ${f.checkId}`)));
  return { scanned: loaded.length, findings, fixes, remaining, quarantined };
}

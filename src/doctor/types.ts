// src/doctor/types.ts
import type { SkillFile } from '../types.js';

export type Severity = 'junk' | 'warn' | 'info';

export interface EndpointKey {
  method: string;
  path: string;
}

export interface Finding {
  checkId: string;
  domain: string;
  severity: Severity;
  message: string;
  endpointKeys?: EndpointKey[];
  fixable: boolean;
}

export type FixPlan =
  | { action: 'quarantine' }
  | { action: 'edit'; skill: SkillFile };

export interface CheckContext {
  now: Date;
  staleDays: number;
}

export interface Check {
  id: string;
  title: string;
  /** Pure: never touches disk. */
  scan(skill: SkillFile, ctx: CheckContext): Finding[];
  /** Pure: returns a plan; the engine does all I/O. */
  fix?(skill: SkillFile, finding: Finding): FixPlan;
}

export type SignatureStatus = 'valid' | 'unsigned' | 'mismatch' | 'expired' | 'invalid-file';

export interface LoadedSkill {
  domain: string; // from filename
  filePath: string;
  skill: SkillFile | null; // null when unparseable/invalid
  signatureStatus: SignatureStatus;
  loadError?: string;
}

export interface AppliedFix {
  domain: string;
  checkId: string;
  action: 'quarantine' | 'edit';
}

export interface DoctorReport {
  scanned: number;
  findings: Finding[];
  fixes: AppliedFix[];
  remaining: Finding[];
  quarantined: string[];
}

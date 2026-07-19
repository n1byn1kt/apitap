// src/doctor/checks/invalid-signature.ts
import type { Finding, LoadedSkill } from '../types.js';

const MESSAGES: Record<string, string> = {
  unsigned: 'file is unsigned — hard-verify loads reject it',
  mismatch: 'signature verification FAILED — possible tampering; edit fixes disabled for this file',
  expired: 'signature older than 180 days — readSkillFile rejects it; re-capture or re-import',
  'invalid-file': 'unparseable or structurally invalid skill file',
};

export function signatureFindings(loaded: LoadedSkill): Finding[] {
  if (loaded.signatureStatus === 'valid') return [];
  const detail = loaded.loadError ? ` (${loaded.loadError})` : '';
  return [{
    checkId: 'invalid-signature',
    domain: loaded.domain,
    severity: 'warn',
    message: `${MESSAGES[loaded.signatureStatus]}${detail}`,
    fixable: false, // deliberate: re-signing unverified content would launder tampering
  }];
}

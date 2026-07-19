// src/doctor/checks/unverified-tier.ts
import type { SkillFile } from '../../types.js';
import type { Check, Finding } from '../types.js';

export const unverifiedTier: Check = {
  id: 'unverified-tier',
  title: 'Never-verified endpoints',
  scan(skill: SkillFile): Finding[] {
    const n = skill.endpoints.filter(ep => (ep.replayability?.tier ?? 'unknown') === 'unknown').length;
    if (n === 0) return [];
    return [{
      checkId: 'unverified-tier', domain: skill.domain, severity: 'info', fixable: false,
      message: `${n} endpoint(s) never verified (tier unknown) — future --live will rank these`,
    }];
  },
};

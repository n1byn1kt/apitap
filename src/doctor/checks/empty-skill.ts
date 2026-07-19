// src/doctor/checks/empty-skill.ts
import type { SkillFile } from '../../types.js';
import type { Check, Finding, FixPlan } from '../types.js';

export const emptySkill: Check = {
  id: 'empty-skill',
  title: 'Empty skill files',
  scan(skill: SkillFile): Finding[] {
    if (skill.endpoints.length > 0) return [];
    return [{
      checkId: 'empty-skill', domain: skill.domain, severity: 'junk', fixable: true,
      message: 'zero endpoints — no replay value',
    }];
  },
  fix(): FixPlan {
    return { action: 'quarantine' };
  },
};

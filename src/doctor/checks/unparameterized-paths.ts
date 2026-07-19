// src/doctor/checks/unparameterized-paths.ts
import { classifySegment } from '../../capture/parameterize.js';
import type { SkillFile } from '../../types.js';
import type { Check, Finding } from '../types.js';

/**
 * Detects >=3 sibling endpoints (same method) whose paths differ in exactly
 * one segment that classifySegment considers ID-like — evidence that
 * parameterize.ts missed a family (polymarket resolved-market pattern).
 * Reuses parameterize's classifier: one taxonomy, not two.
 */
export const unparameterizedPaths: Check = {
  id: 'unparameterized-paths',
  title: 'Unparameterized endpoint families',
  scan(skill: SkillFile): Finding[] {
    const families = new Map<string, Set<string>>();
    for (const ep of skill.endpoints) {
      const segs = ep.path.split('?')[0].split('/');
      segs.forEach((seg, i) => {
        if (!seg || seg.startsWith(':') || !classifySegment(seg)) return;
        const family = [...segs.slice(0, i), '*', ...segs.slice(i + 1)].join('/');
        const key = `${ep.method.toUpperCase()} ${family}`;
        if (!families.has(key)) families.set(key, new Set());
        families.get(key)!.add(ep.path);
      });
    }
    const findings: Finding[] = [];
    for (const [key, paths] of families) {
      if (paths.size < 3) continue;
      findings.push({
        checkId: 'unparameterized-paths', domain: skill.domain, severity: 'info', fixable: false,
        message: `${paths.size} sibling paths look like an unparameterized family: ${key}`,
      });
    }
    return findings;
  },
};

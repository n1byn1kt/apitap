// src/doctor/checks/stale-capture.ts
import type { SkillFile } from '../../types.js';
import type { Check, CheckContext, Finding } from '../types.js';

export const staleCapture: Check = {
  id: 'stale-capture',
  title: 'Stale captures',
  scan(skill: SkillFile, ctx: CheckContext): Finding[] {
    const base = { checkId: 'stale-capture', domain: skill.domain, severity: 'warn' as const, fixable: false };
    const ts = Date.parse(skill.capturedAt ?? '');
    if (Number.isNaN(ts)) {
      return [{ ...base, message: 'missing or unparseable capturedAt' }];
    }
    const days = Math.floor((ctx.now.getTime() - ts) / 86_400_000);
    if (days <= ctx.staleDays) return [];
    return [{
      ...base,
      message:
        `captured ${skill.capturedAt.slice(0, 10)} (${days} days ago) — re-capture, or verify with --live when available. ` +
        `Note: file date is an upper bound; merged endpoints may be older.`,
    }];
  },
};

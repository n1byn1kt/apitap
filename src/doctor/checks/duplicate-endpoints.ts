// src/doctor/checks/duplicate-endpoints.ts
import { normalizePath } from '../../skill/merge.js';
import { TIER_RANK } from '../../skill/search.js';
import type { SkillEndpoint, SkillFile } from '../../types.js';
import type { Check, Finding, FixPlan } from '../types.js';

function dupKey(ep: SkillEndpoint): string {
  let p = normalizePath(ep.path);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1); // normalizePath keeps trailing slashes
  return `${ep.method.toUpperCase()} ${p}`;
}

/**
 * Richness rank — lower is better on every dimension. There is no
 * schemaSample field and no per-endpoint timestamp; rank on real fields.
 */
function rank(ep: SkillEndpoint): number[] {
  return [
    ep.replayability?.verified ? 0 : 1,
    TIER_RANK[ep.replayability?.tier ?? 'unknown'] ?? 2,
    ep.responseSchema ? 0 : 1,
    ep.examples?.responsePreview != null ? 0 : 1,
    -(ep.responseShape?.fields?.length ?? 0),
    -(ep.responseBytes ?? 0),
  ];
}

const rankLte = (a: number[], b: number[]) => a.every((v, i) => v <= b[i]);

function rankCmp(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Winner must carry every queryParams key and (for object templates) every requestBody key the loser has. */
function paramsSuperset(w: SkillEndpoint, l: SkillEndpoint): boolean {
  for (const k of Object.keys(l.queryParams ?? {})) {
    if (!(k in (w.queryParams ?? {}))) return false;
  }
  if (l.requestBody) {
    if (!w.requestBody) return false;
    const lt = l.requestBody.template;
    const wt = w.requestBody.template;
    if (typeof lt === 'object' && lt !== null) {
      if (typeof wt !== 'object' || wt === null) return false;
      for (const k of Object.keys(lt)) if (!(k in wt)) return false;
    }
  }
  return true;
}

function dominates(w: SkillEndpoint, l: SkillEndpoint): boolean {
  return rankLte(rank(w), rank(l)) && paramsSuperset(w, l);
}

interface Groups { winner: SkillEndpoint; dominated: SkillEndpoint[]; contested: SkillEndpoint[]; }

function groupDuplicates(skill: SkillFile): Map<string, Groups> {
  const byKey = new Map<string, SkillEndpoint[]>();
  for (const ep of skill.endpoints) {
    const k = dupKey(ep);
    byKey.set(k, [...(byKey.get(k) ?? []), ep]);
  }
  const out = new Map<string, Groups>();
  for (const [k, eps] of byKey) {
    if (eps.length < 2) continue;
    const winner = [...eps].sort((a, b) => rankCmp(rank(a), rank(b)))[0];
    const losers = eps.filter(e => e !== winner);
    out.set(k, {
      winner,
      dominated: losers.filter(l => dominates(winner, l)),
      contested: losers.filter(l => !dominates(winner, l)),
    });
  }
  return out;
}

export const duplicateEndpoints: Check = {
  id: 'duplicate-endpoints',
  title: 'Duplicate endpoints',
  scan(skill: SkillFile): Finding[] {
    const findings: Finding[] = [];
    for (const [key, g] of groupDuplicates(skill)) {
      if (g.dominated.length > 0) {
        findings.push({
          checkId: 'duplicate-endpoints', domain: skill.domain, severity: 'warn', fixable: true,
          message: `${key}: ${g.dominated.length + 1} copies → keep ${g.winner.path}, drop dominated duplicate(s)`,
          endpointKeys: g.dominated.map(e => ({ method: e.method, path: e.path })),
        });
      }
      if (g.contested.length > 0) {
        findings.push({
          checkId: 'duplicate-endpoints', domain: skill.domain, severity: 'warn', fixable: false,
          message: `${key}: duplicate not strictly dominated (unique params/body on the duplicate) — review manually`,
          endpointKeys: g.contested.map(e => ({ method: e.method, path: e.path })),
        });
      }
    }
    return findings;
  },
  /** Recomputes groups (identity-based) — endpointKeys alone cannot disambiguate exact-same-path dupes. */
  fix(skill: SkillFile): FixPlan {
    const drop = new Set<SkillEndpoint>();
    for (const g of groupDuplicates(skill).values()) {
      for (const l of g.dominated) drop.add(l);
    }
    return { action: 'edit', skill: { ...skill, endpoints: skill.endpoints.filter(e => !drop.has(e)) } };
  },
};

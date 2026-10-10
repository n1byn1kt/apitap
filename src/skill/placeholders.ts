// src/skill/placeholders.ts
import type { SkillEndpoint } from '../types.js';

/** Query params whose credential was captured into auth storage. */
export function storedQueryAuthNames(ep: SkillEndpoint): string[] {
  return Object.entries(ep.queryParams ?? {})
    .filter(([, q]) => q.example === '[stored]')
    .map(([name]) => name);
}

/** Whether replaying this endpoint needs stored credentials (header or query). */
export function hasAuthPlaceholder(ep: SkillEndpoint): boolean {
  return Object.values(ep.headers).some(v => v === '[stored]')
    || storedQueryAuthNames(ep).length > 0;
}

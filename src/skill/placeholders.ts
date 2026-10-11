// src/skill/placeholders.ts
import type { SkillEndpoint } from '../types.js';

/**
 * Query param names whose values are reusable credentials: captured into
 * encrypted auth storage and re-injected on replay. One-time or
 * request-bound params (code, state, nonce, sig*, otp, password, session ids,
 * refresh/id tokens, CSRF-shaped `token`) are deliberately excluded and stay
 * [scrubbed].
 */
const REUSABLE_QUERY_AUTH = /^(?:access[-_]?token|api[-_]?token|auth[-_]?token|api[-_]?key|apikey|app[-_]?key|access[-_]?key|x-[a-z0-9-]+-api-key)$/i;
/** Generic names that are only credentials when the value looks like a token (`?key=title` is a sort key). */
const GENERIC_QUERY_AUTH = /^(?:key|appid)$/i;

/** Classify a query param name as a reusable credential, a generic maybe-credential, or neither. */
export function queryCredentialKind(name: string): 'reusable' | 'generic' | null {
  if (REUSABLE_QUERY_AUTH.test(name)) return 'reusable';
  if (GENERIC_QUERY_AUTH.test(name)) return 'generic';
  return null;
}

/**
 * Tag binding a stored query credential to the endpoint it was captured on:
 * method + parameterized path, the generator's dedup identity. Not the
 * endpoint id, which drops :param segments (GET /search and GET /search/:q
 * are both get-search).
 */
export function queryAuthTag(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

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

/** Drop [stored] query credentials from a URL (for requests made without auth, e.g. verification). */
export function withoutStoredQueryAuth(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const [name, value] of [...u.searchParams]) {
      if (value === '[stored]') { u.searchParams.delete(name); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

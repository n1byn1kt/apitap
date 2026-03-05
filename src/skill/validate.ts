// src/skill/validate.ts
import type { SkillFile } from '../types.js';
import { validateUrl } from './ssrf.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Validate a parsed JSON object as a SkillFile.
 * Throws on invalid input — fail fast, fail loud.
 * SSRF checks are optional here (default: off) because the replay engine
 * already enforces SSRF at request time with DNS resolution.
 */
export function validateSkillFile(raw: unknown, options?: { checkSsrf?: boolean }): SkillFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Skill file must be an object');
  }
  const obj = raw as Record<string, unknown>;

  // domain
  if (typeof obj.domain !== 'string' || obj.domain.length === 0 || obj.domain.length > 253) {
    throw new Error('Invalid domain: must be a string of 1-253 characters');
  }

  // baseUrl — must be a valid URL; SSRF checked at replay time
  if (typeof obj.baseUrl !== 'string') {
    throw new Error('Missing baseUrl');
  }
  try {
    const url = new URL(obj.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('non-HTTP scheme');
    }
  } catch {
    throw new Error(`Invalid baseUrl: must be a valid HTTP(S) URL`);
  }
  if (options?.checkSsrf) {
    const ssrf = validateUrl(obj.baseUrl);
    if (!ssrf.safe) {
      throw new Error(`Unsafe baseUrl: ${ssrf.reason}`);
    }
  }

  // endpoints
  if (!Array.isArray(obj.endpoints)) {
    throw new Error('Missing or invalid endpoints array');
  }
  if (obj.endpoints.length > 500) {
    throw new Error('Too many endpoints (max 500)');
  }

  for (let i = 0; i < obj.endpoints.length; i++) {
    const ep = obj.endpoints[i];
    if (!ep || typeof ep !== 'object') {
      throw new Error(`Endpoint ${i}: must be an object`);
    }
    const e = ep as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 200) {
      throw new Error(`Endpoint ${i}: id must be a string of 1-200 characters`);
    }
    if (typeof e.method !== 'string' || !ALLOWED_METHODS.has(e.method)) {
      throw new Error(`Endpoint ${i}: method must be one of ${[...ALLOWED_METHODS].join(', ')}`);
    }
    if (typeof e.path !== 'string' || !e.path.startsWith('/')) {
      throw new Error(`Endpoint ${i}: path must start with /`);
    }
    if (e.path.length > 2000) {
      throw new Error(`Endpoint ${i}: path exceeds 2000 characters`);
    }
  }

  return raw as SkillFile;
}

// src/capture/verifier.ts
import type { SkillFile, SkillEndpoint, Replayability } from '../types.js';

/**
 * Heuristic tier classification for non-GET endpoints (or when verification is skipped).
 * Based on header analysis only.
 */
export function classifyHeuristic(endpoint: SkillEndpoint): Replayability {
  const signals: string[] = [];

  const hasAuth = Object.values(endpoint.headers).some(v => v === '[stored]');
  if (hasAuth) signals.push('auth-required');

  const hasCsrf = Object.keys(endpoint.headers).some(k => {
    const lower = k.toLowerCase();
    return lower.includes('csrf') || lower.includes('xsrf');
  });
  if (hasCsrf) signals.push('csrf-token');

  let tier: Replayability['tier'];
  if (hasCsrf) {
    tier = 'orange';
  } else if (hasAuth) {
    tier = 'yellow';
  } else {
    tier = 'green';
  }

  return { tier, verified: false, signals };
}

/**
 * Verify a single GET endpoint by replaying it with raw fetch().
 * Compares status and response shape.
 */
async function verifySingle(
  endpoint: SkillEndpoint,
): Promise<Replayability> {
  const url = endpoint.examples.request.url;
  if (!url) return classifyHeuristic(endpoint);

  // Build headers: use endpoint headers but exclude [stored] auth placeholders
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(endpoint.headers)) {
    if (v !== '[stored]') {
      headers[k] = v;
    }
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const signals: string[] = ['status-match'];

      // Check if response shape matches
      const ct = response.headers.get('content-type') ?? '';
      if (ct.includes('json')) {
        try {
          const data = await response.json();
          const responseType = Array.isArray(data) ? 'array' : typeof data === 'object' && data !== null ? 'object' : typeof data;
          if (responseType === endpoint.responseShape.type) {
            signals.push('shape-match');
          }
        } catch {
          // JSON parse failure — still count status match
        }
      }

      return { tier: 'green', verified: true, signals };
    }

    if (response.status === 401 || response.status === 403) {
      return { tier: 'yellow', verified: true, signals: ['auth-required'] };
    }

    return { tier: 'orange', verified: true, signals: [`status-${response.status}`] };
  } catch {
    return { tier: 'red', verified: true, signals: ['connection-failed'] };
  }
}

/**
 * Verify a single POST/PUT/PATCH endpoint by replaying it with the captured body.
 * Same classification logic as verifySingle but includes the request body.
 */
async function verifySinglePost(
  endpoint: SkillEndpoint,
): Promise<Replayability> {
  const url = endpoint.examples.request.url;
  if (!url || !endpoint.requestBody) return classifyHeuristic(endpoint);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(endpoint.headers)) {
    if (v !== '[stored]') {
      headers[k] = v;
    }
  }

  const body = typeof endpoint.requestBody.template === 'object'
    ? JSON.stringify(endpoint.requestBody.template)
    : endpoint.requestBody.template;

  try {
    const response = await fetch(url, {
      method: endpoint.method,
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const signals: string[] = ['status-match'];

      const ct = response.headers.get('content-type') ?? '';
      if (ct.includes('json')) {
        try {
          const data = await response.json();
          const responseType = Array.isArray(data) ? 'array' : typeof data === 'object' && data !== null ? 'object' : typeof data;
          if (responseType === endpoint.responseShape.type) {
            signals.push('shape-match');
          }
        } catch {
          // JSON parse failure — still count status match
        }
      }

      return { tier: 'green', verified: true, signals };
    }

    if (response.status === 401 || response.status === 403) {
      return { tier: 'yellow', verified: true, signals: ['auth-required'] };
    }

    return { tier: 'orange', verified: true, signals: [`status-${response.status}`] };
  } catch {
    return { tier: 'red', verified: true, signals: ['connection-failed'] };
  }
}

export interface VerifyOptions {
  /** Verify POST/PUT/PATCH endpoints by replaying them (opt-in, may cause side effects). */
  verifyPosts?: boolean;
}

/**
 * Verify all GET endpoints in a skill file by replaying them.
 * Non-GET endpoints get heuristic classification by default.
 * With verifyPosts: true, POST/PUT/PATCH endpoints are also replayed.
 * Returns a new skill file with replayability tags on all endpoints.
 */
export async function verifyEndpoints(skill: SkillFile, opts?: VerifyOptions): Promise<SkillFile> {
  const verifiedEndpoints = await Promise.all(
    skill.endpoints.map(async (ep) => {
      let replayability: Replayability;
      if (ep.method === 'GET') {
        replayability = await verifySingle(ep);
      } else if (opts?.verifyPosts) {
        replayability = await verifySinglePost(ep);
      } else {
        replayability = classifyHeuristic(ep);
      }
      return { ...ep, replayability };
    }),
  );

  return { ...skill, endpoints: verifiedEndpoints };
}

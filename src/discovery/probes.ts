// src/discovery/probes.ts
import type { ProbeResult } from '../types.js';
import { safeFetch } from './fetch.js';

/** Common API paths to probe */
const PROBE_PATHS = [
  '/api/',
  '/api/v1/',
  '/api/v2/',
  '/_api/',
  '/rest/',
  '/graphql',
  '/gql',
  '/api/graphql',
];

export interface ProbeOptions {
  skipSsrf?: boolean;
}

/**
 * Probe common API paths with GET requests.
 * Returns results for paths that respond with API-like content types.
 */
export async function probeApiPaths(baseUrl: string, options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const origin = new URL(baseUrl).origin;
  const results: ProbeResult[] = [];

  const checks = PROBE_PATHS.map(async (path): Promise<ProbeResult | null> => {
    const url = `${origin}${path}`;
    const result = await safeFetch(url, { timeout: 5000, method: 'GET', maxBodySize: 4096, skipSsrf: options.skipSsrf });
    if (!result) return null;

    // Don't count redirects to login pages or error pages
    if (result.status >= 400 && result.status !== 401 && result.status !== 403) return null;

    const ct = result.contentType.toLowerCase();
    const isApi = isApiContentType(ct, result.body, result.status);

    return {
      method: 'GET',
      path,
      status: result.status,
      contentType: result.contentType,
      isApi,
    };
  });

  const settled = await Promise.all(checks);
  for (const result of settled) {
    if (result) results.push(result);
  }

  return results;
}

function isApiContentType(contentType: string, body: string, status: number): boolean {
  // JSON responses are API
  if (contentType.includes('json')) return true;
  // XML/SOAP
  if (contentType.includes('xml')) return true;
  // 401/403 at an API path means something is there (but needs auth)
  if ((status === 401 || status === 403) && !contentType.includes('html')) return true;
  // GraphQL introspection response
  if (body.includes('"data"') && body.includes('"__schema"')) return true;
  // Check if body looks like JSON even without proper content-type
  if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      JSON.parse(body);
      return true;
    } catch {
      // Not JSON
    }
  }
  return false;
}

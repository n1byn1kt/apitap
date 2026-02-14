// src/capture/filter.ts
import { isBlocklisted } from './blocklist.js';

export interface FilterableResponse {
  url: string;
  status: number;
  contentType: string;
}

const JSON_CONTENT_TYPES = [
  'application/json',
  'application/vnd.api+json',
  'text/json',
];

/** Exact path matches that are telemetry/framework noise */
const NOISE_PATHS = new Set([
  '/monitoring',
  '/telemetry',
  '/track',
  '/manifest.json',
]);

/**
 * Check if a URL path is framework or telemetry noise.
 * Exported for testing.
 */
export function isPathNoise(pathname: string): boolean {
  // Exact match noise paths
  if (NOISE_PATHS.has(pathname)) return true;

  // Next.js static build assets (not data routes)
  if (pathname.startsWith('/_next/static/')) return true;

  return false;
}

export function shouldCapture(response: FilterableResponse): boolean {
  // Only keep 2xx success responses
  if (response.status < 200 || response.status >= 300) return false;

  // Content-type must indicate JSON
  const ct = response.contentType.toLowerCase().split(';')[0].trim();
  if (!JSON_CONTENT_TYPES.some(t => ct === t)) return false;

  // Check domain and path
  try {
    const url = new URL(response.url);
    if (isBlocklisted(url.hostname)) return false;
    if (isPathNoise(url.pathname)) return false;
  } catch {
    return false;
  }

  return true;
}

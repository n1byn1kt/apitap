export const BLOCKED_SCHEMES = [
  'chrome-extension:',
  'chrome:',
  'devtools:',
  'data:',
  'blob:',
  'file:',
  'javascript:',
  'about:',
  'ws:',
  'wss:',
];

const NOISE_URL_PATTERNS = [
  /__webpack/,
  /\.hot-update\.(json|js)$/,
  /\/sockjs-node\//,
  /\/ws$/,
  /\/_next\/webpack-hmr/,
];

export function isAllowedUrl(url: string): boolean {
  if (!url) return false;

  // Block non-http(s) schemes
  const lowerUrl = url.toLowerCase();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lowerUrl.startsWith(scheme)) return false;
  }

  // Must be valid http(s)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  // Block dev tooling noise
  for (const pattern of NOISE_URL_PATTERNS) {
    if (pattern.test(url)) return false;
  }

  return true;
}

/** Headers whose values must never appear in exported skill files */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-xsrf-token',
]);

/**
 * Scrub auth/session credentials from skill file JSON before export.
 * Replaces sensitive header values with '[stored]' placeholder.
 */
export function scrubAuthFromSkillJson(json: string): string {
  const skill = JSON.parse(json);
  if (Array.isArray(skill.endpoints)) {
    for (const ep of skill.endpoints) {
      if (ep.headers && typeof ep.headers === 'object') {
        for (const key of Object.keys(ep.headers)) {
          if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            ep.headers[key] = '[stored]';
          }
        }
      }
      // Also scrub from example request headers if present
      if (ep.exampleRequestHeaders && typeof ep.exampleRequestHeaders === 'object') {
        for (const key of Object.keys(ep.exampleRequestHeaders)) {
          if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            ep.exampleRequestHeaders[key] = '[stored]';
          }
        }
      }
    }
  }
  return JSON.stringify(skill, null, 2);
}

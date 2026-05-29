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

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;

export function isAllowedUrl(url: string): boolean {
  if (!url) return false;

  // Block non-http(s) schemes
  const lowerUrl = url.toLowerCase();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lowerUrl.startsWith(scheme)) return false;
  }

  // Must be valid http(s)
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  // Block private/internal addresses (SSRF prevention + privacy)
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return false;

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
/**
 * Body field names that carry credentials. Normalizes the key (strip
 * separators, lowercase) and matches credential stems so camelCase/prefixed
 * variants (accessToken, clientSecret, userPassword) are caught too. Weak
 * stems match only as a whole word or suffix to avoid scrubbing e.g.
 * `tokenCount`. Keep in sync with src/skill/generator.ts isSensitiveBodyKey.
 */
const STRONG_BODY_KEY_STEMS = [
  'password', 'passwd', 'secret', 'credential', 'privatekey', 'apikey',
  'refreshtoken', 'accesstoken', 'clientsecret', 'sessiontoken', 'csrf', 'xsrf', 'bearer',
];
const WEAK_BODY_KEY_STEMS = ['token', 'pass', 'auth', 'pwd'];

function isSensitiveBodyKey(key: string): boolean {
  const n = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (STRONG_BODY_KEY_STEMS.some((s) => n.includes(s))) return true;
  if (WEAK_BODY_KEY_STEMS.some((s) => n === s || n.endsWith(s))) return true;
  return false;
}

function scrubObjectFields(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (isSensitiveBodyKey(key) && typeof obj[key] === 'string') {
      obj[key] = '[scrubbed]';
    } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      scrubObjectFields(obj[key] as Record<string, unknown>);
    }
  }
}

function scrubHeaderFields(headers: Record<string, unknown>): void {
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase()) && typeof headers[key] === 'string') {
      headers[key] = '[stored]';
    }
  }
}

export function scrubAuthFromSkillJson(json: string): string {
  let skill: any;
  try {
    skill = JSON.parse(json);
  } catch {
    return json; // Return original if parse fails
  }
  if (Array.isArray(skill.endpoints)) {
    for (const ep of skill.endpoints) {
      if (ep.headers && typeof ep.headers === 'object') {
        scrubHeaderFields(ep.headers);
      }

      // Also scrub from schema-aligned example request headers.
      if (ep.examples?.request?.headers && typeof ep.examples.request.headers === 'object') {
        scrubHeaderFields(ep.examples.request.headers);
      }

      // Backward-compat for older extension-generated shape.
      if (ep.exampleRequestHeaders && typeof ep.exampleRequestHeaders === 'object') {
        scrubHeaderFields(ep.exampleRequestHeaders);
      }

      // Scrub sensitive fields from request body templates
      if (ep.requestBody?.template && typeof ep.requestBody.template === 'object') {
        scrubObjectFields(ep.requestBody.template);
      }
    }
  }
  return JSON.stringify(skill, null, 2);
}

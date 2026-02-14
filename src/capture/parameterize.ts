// src/capture/parameterize.ts

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_NUMERIC_RE = /^\d+$/;
const LONG_DIGITS_RE = /\d{8,}/;
const NEXT_DATA_PREFIX_RE = /^\/_next\/data\/[^/]+\//;

/**
 * Check if a path segment is a dynamic value that should be parameterized.
 * Returns the parameter name (:id, :hash, :slug) or null if static.
 */
function classifySegment(segment: string): string | null {
  // Pure numeric → :id
  if (PURE_NUMERIC_RE.test(segment)) return ':id';

  // UUID → :id
  if (UUID_RE.test(segment)) return ':id';

  // Slug with embedded long number (8+ consecutive digits) — check before hash
  // because slugs like "btc-updown-15m-1770254100" would also match the hash rule
  if (LONG_DIGITS_RE.test(segment)) {
    return ':slug';
  }

  // Strip hyphens/underscores for character analysis
  const stripped = segment.replace(/[-_]/g, '');

  // Hash-like: 12+ alphanumeric chars with both letters and digits
  if (stripped.length >= 12 && /[a-zA-Z]/.test(stripped) && /\d/.test(stripped)) {
    return ':hash';
  }

  return null;
}

/**
 * Replace dynamic path segments with :param placeholders.
 *
 * Rules:
 * - Pure numeric → :id
 * - UUID → :id
 * - 12+ alphanum with mixed letters+digits → :hash
 * - Contains 8+ consecutive digits → :slug
 */
export function parameterizePath(path: string): string {
  const segments = path.split('/');
  const result = segments.map(seg => {
    if (seg === '') return seg;
    return classifySegment(seg) ?? seg;
  });
  return result.join('/');
}

/**
 * Strip framework-specific path noise for clean endpoint IDs.
 *
 * - Strips /_next/data/<hash>/ prefix (Next.js data routes)
 * - Strips .json suffix
 */
export function cleanFrameworkPath(path: string): string {
  let cleaned = path;
  // Strip _next/data/<hash>/ prefix
  cleaned = cleaned.replace(NEXT_DATA_PREFIX_RE, '/');
  // Strip .json suffix
  cleaned = cleaned.replace(/\.json$/, '');
  // Ensure we have at least /
  return cleaned || '/';
}

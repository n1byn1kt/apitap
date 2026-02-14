// src/capture/entropy.ts

const MIN_TOKEN_LENGTH = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TokenClassification {
  isToken: boolean;
  confidence: 'high' | 'medium';
  format: 'jwt' | 'opaque';
  jwtClaims?: JwtClaims;
}

export interface JwtClaims {
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string;
  scope?: string;
}

/**
 * Calculate Shannon entropy (bits per character) of a string.
 * Higher values indicate more randomness.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = value.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Parse JWT claims from a token string.
 * Returns null if not a valid JWT structure.
 */
export function parseJwtClaims(token: string): JwtClaims | null {
  // JWT: starts with eyJ, has exactly 2 dots
  if (!token.startsWith('eyJ')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    // Decode payload (second part), base64url → JSON
    const payload = parts[1]!;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const claims = JSON.parse(json);

    if (typeof claims !== 'object' || claims === null) return null;

    const result: JwtClaims = {};
    if (typeof claims.exp === 'number') result.exp = claims.exp;
    if (typeof claims.iat === 'number') result.iat = claims.iat;
    if (typeof claims.iss === 'string') result.iss = claims.iss;
    if (typeof claims.aud === 'string') result.aud = claims.aud;
    if (typeof claims.scope === 'string') result.scope = claims.scope;

    return result;
  } catch {
    return null;
  }
}

/**
 * Classify whether a header/cookie value is likely an auth token.
 *
 * Detection hierarchy:
 * 1. JWT (eyJ prefix, 2 dots) → decode and classify with rich metadata
 * 2. UUID → skip (entity ID, not token)
 * 3. Short values (<16 chars) → skip
 * 4. High-entropy opaque string → classify by entropy threshold
 */
export function isLikelyToken(name: string, value: string): TokenClassification {
  // Strip "Bearer " prefix for analysis
  const raw = value.startsWith('Bearer ') ? value.slice(7) : value;

  // JWT detection — takes priority
  const jwtClaims = parseJwtClaims(raw);
  if (jwtClaims) {
    return {
      isToken: true,
      confidence: 'high',
      format: 'jwt',
      jwtClaims,
    };
  }

  // UUID exclusion — almost always entity IDs, not tokens
  if (UUID_PATTERN.test(raw)) {
    return { isToken: false, confidence: 'medium', format: 'opaque' };
  }

  // Minimum length gate
  if (raw.length < MIN_TOKEN_LENGTH) {
    return { isToken: false, confidence: 'medium', format: 'opaque' };
  }

  // Entropy-based classification
  const entropy = shannonEntropy(raw);

  if (entropy >= 4.5) {
    return { isToken: true, confidence: 'high', format: 'opaque' };
  }
  if (entropy >= 3.5) {
    return { isToken: true, confidence: 'medium', format: 'opaque' };
  }

  // Below threshold — not a token
  return { isToken: false, confidence: 'medium', format: 'opaque' };
}

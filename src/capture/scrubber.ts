// src/capture/scrubber.ts
// NOTE: this module is bundled into the browser extension too, so it must not
// import Node-only built-ins (e.g. node:net). IPv6 is validated with a pure helper.

/**
 * Pure (browser-safe) IPv6 validator for scrubber candidates. Rejects strings
 * that merely look colon-separated (e.g. timestamps "12:34:56"): a full address
 * needs 8 groups, a "::"-compressed one needs fewer with exactly one "::", and
 * every group must be 0-4 hex digits. ReDoS-safe (split + per-group test).
 */
function looksLikeIpv6(s: string): boolean {
  if (!s.includes(':')) return false;
  const doubleColons = s.split('::').length - 1;
  if (doubleColons > 1) return false; // at most one "::"
  const groups = s.split(':');
  if (groups.length > 8) return false;
  if (!groups.every((g) => /^[0-9a-fA-F]{0,4}$/.test(g))) return false;
  return doubleColons === 1 ? groups.length <= 8 : groups.length === 8;
}

// Email: standard pattern
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone (international): requires + prefix
const PHONE_INTL_RE = /\+[1-9]\d{7,14}/g;

// Phone (US): requires separators — (123) 456-7890 or 123-456-7890 or 123.456.7890
const PHONE_US_RE = /\(\d{3}\)[-.\s]\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}/g;

// IPv4: four octets, each 0-255, validated programmatically
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

// Credit card: 16 digits with optional dashes or spaces every 4
const CARD_RE = /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g;

// US SSN: 123-45-6789
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Auth tokens
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/g;
const JWT_RE = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;

// M12: Cloud provider keys and private key material
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GCP_API_KEY_RE = /\bAIza[A-Za-z0-9_-]{35}\b/g;
const PRIVATE_KEY_RE = /-----BEGIN[\s]+(?:RSA\s+|EC\s+|DSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END[\s]+(?:RSA\s+|EC\s+|DSA\s+)?PRIVATE\s+KEY-----/g;
const BASIC_AUTH_RE = /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}\b/g;

// Provider-prefixed secrets: Stripe (sk_/pk_/rk_ live|test), GitHub (ghp_/gho_/
// ghu_/ghs_/ghr_), Slack (xox[baprs]-), GitLab (glpat-).
const STRIPE_KEY_RE = /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g;
const GITHUB_TOKEN_RE = /\bgh[posru]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const GITLAB_TOKEN_RE = /\bglpat-[A-Za-z0-9_-]{16,}\b/g;

// IBAN: 2-letter country + 2 check digits + up to 30 alphanumerics.
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

// IPv6 candidate: 2-7 colon-separated hex groups (allowing :: compression).
// Bounded quantifiers (no nested unbounded repetition) keep this ReDoS-safe;
// each candidate is validated with net.isIPv6 to avoid false positives
// (e.g. timestamps like 12:34:56).
const IPV6_CANDIDATE_RE = /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;

/**
 * Scrub PII from a string. Returns the string with PII replaced by placeholders.
 * Order matters: SSN before phone (SSN is more specific).
 */
export function scrubPII(input: string): string {
  let result = input;

  // Email first (most distinctive pattern)
  result = result.replace(EMAIL_RE, '[email]');

  // SSN before phone (SSN pattern 123-45-6789 could be confused)
  result = result.replace(SSN_RE, '[ssn]');

  // Credit cards
  result = result.replace(CARD_RE, '[card]');

  // IBAN (before IPv4 — disjoint, but keep bank identifiers grouped)
  result = result.replace(IBAN_RE, '[iban]');

  // IPv4 with octet validation
  result = result.replace(IPV4_RE, (_match, o1, o2, o3, o4) => {
    const octets = [o1, o2, o3, o4].map(Number);
    if (octets.every(o => o <= 255)) return '[ip]';
    return _match;
  });

  // IPv6 (validated with isIPv6 to avoid false positives)
  result = result.replace(IPV6_CANDIDATE_RE, (m) => (looksLikeIpv6(m) ? '[ip]' : m));

  // Phone (international, then US)
  result = result.replace(PHONE_INTL_RE, '[phone]');
  result = result.replace(PHONE_US_RE, '[phone]');

  // Auth tokens
  result = result.replace(BEARER_TOKEN_RE, '[token]');
  result = result.replace(JWT_RE, '[token]');

  // M12: Cloud provider keys and private key material
  result = result.replace(PRIVATE_KEY_RE, '[private-key]');
  result = result.replace(AWS_ACCESS_KEY_RE, '[aws-key]');
  result = result.replace(GCP_API_KEY_RE, '[gcp-key]');
  result = result.replace(BASIC_AUTH_RE, '[token]');

  // Provider-prefixed secrets
  result = result.replace(STRIPE_KEY_RE, '[token]');
  result = result.replace(GITHUB_TOKEN_RE, '[token]');
  result = result.replace(SLACK_TOKEN_RE, '[token]');
  result = result.replace(GITLAB_TOKEN_RE, '[token]');

  return result;
}

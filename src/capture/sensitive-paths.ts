// src/capture/sensitive-paths.ts
// Sensitive path patterns — enforced at COLLECTION time on the capture path
// (CLI/MCP/CDP). Requests matching these are never captured, never written;
// data that was never written can never leak.
//
// SCOPE: this list deliberately covers human PII / financial / account-security
// surfaces that should never become a replayable skill endpoint. It does NOT
// include OAuth/token-grant/login endpoints — capturing those is the whole
// point of ApiTap's auth subsystem (the secret is extracted into the encrypted
// auth store and scrubbed from the skill file, only oauthConfig metadata is
// kept). The browser extension uses a broader list (extension/src/
// sensitive-paths.ts) because it passively indexes traffic across every site
// the user visits, where suppressing auth endpoints is appropriate.
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\/password/i,
  /\/passwd/i,
  /\/reset-password/i,
  /\/forgot-password/i,
  /\/2fa/i,
  /\/mfa\b/i,
  /\/otp\b/i,
  /\/verify-email/i,
  /\/account\/security/i,
  /\/checkout/i,
  /\/payment/i,
  /\/billing/i,
];

/**
 * Check if a URL path matches a sensitive pattern.
 * Returns true if the path should be BLOCKED from capture/indexing.
 */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

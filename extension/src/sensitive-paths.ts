/**
 * Sensitive path patterns — enforced at collection time.
 * Requests matching these patterns are never observed, never stored.
 * Data that was never written can never leak.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\/login/i,
  /\/oauth/i,
  /\/token/i,
  /\/password/i,
  /\/passwd/i,
  /\/2fa/i,
  /\/mfa/i,
  /\/auth\b/i,          // /auth but not /authors
  /\/authenticate/i,
  /\/authorization/i,
  /\/session\/new/i,
  /\/signup/i,
  /\/register/i,
  /\/forgot/i,
  /\/reset-password/i,
  /\/verify-email/i,
  /\/account\/security/i,
  /\/api-key/i,
  /\/credentials/i,
  /\/sso\b/i,
  /\/saml\b/i,
  /\/oidc\b/i,
  /\/connect\/token/i,
  /\/checkout/i,
  /\/payment/i,
  /\/billing/i,
  /\/\.well-known\/openid/i,
  /\/health\b/i,
  /\/metrics\b/i,
  /\/debug\b/i,
];

/**
 * Check if a URL path matches a sensitive pattern.
 * Returns true if the path should be BLOCKED from indexing.
 */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(path));
}

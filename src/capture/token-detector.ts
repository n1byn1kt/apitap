// src/capture/token-detector.ts

/**
 * Token Detection for Auth Refresh
 *
 * Identifies tokens in request bodies that are:
 * 1. Session-generated (CSRF, nonces) — need refresh via browser
 * 2. NOT user credentials (access tokens, API keys) — should not auto-refresh
 *
 * Detection uses pattern matching on names and value heuristics (hex, base64).
 */

// Token name patterns that indicate session-generated values
const TOKEN_NAME_PATTERNS = /csrf|token|nonce|xsrf|_token$/i;

// Exclude user-provided credentials (should not auto-refresh)
const TOKEN_NAME_EXCLUDE = /access.?token|auth.?token|api.?token|bearer/i;

// Token value patterns (high-entropy session tokens)
const TOKEN_VALUE_HEX = /^[a-f0-9]{32,64}$/i;
const TOKEN_VALUE_BASE64 = /^[A-Za-z0-9+/]{20,}={0,2}$/;

/**
 * Check if a name/value pair represents a refreshable session token.
 *
 * @param name - Field name (e.g., "csrf_token", "nonce")
 * @param value - Field value
 * @returns true if this is a refreshable token
 */
export function isRefreshableToken(name: string, value: string): boolean {
  // Must match token name pattern
  if (!TOKEN_NAME_PATTERNS.test(name)) {
    return false;
  }

  // Exclude user credentials
  if (TOKEN_NAME_EXCLUDE.test(name)) {
    return false;
  }

  // Value must look like a token (hex or base64, sufficient length)
  const isHex = TOKEN_VALUE_HEX.test(value);
  const isBase64 = TOKEN_VALUE_BASE64.test(value);

  return isHex || isBase64;
}

/**
 * Scan a request body for refreshable tokens.
 *
 * @param body - Parsed request body (object or string)
 * @param prefix - JSON path prefix for nested objects
 * @returns Array of JSON paths to refreshable tokens (e.g., ["csrf_token", "data.nonce"])
 */
export function detectRefreshableTokens(
  body: unknown,
  prefix = ''
): string[] {
  const tokens: string[] = [];

  if (typeof body !== 'object' || body === null) {
    return tokens;
  }

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string' && isRefreshableToken(key, value)) {
      tokens.push(path);
    } else if (typeof value === 'object' && value !== null) {
      tokens.push(...detectRefreshableTokens(value, path));
    }
  }

  return tokens;
}

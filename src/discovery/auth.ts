// src/discovery/auth.ts

export interface AuthDetectionResult {
  authRequired: boolean;
  signals: string[];
  loginUrl?: string;  // detected login page URL if found
}

// Paths that indicate auth/login
const AUTH_PATH_PATTERNS = [
  /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth\//i,
  /\/sso/i, /\/saml/i, /\/oauth/i, /\/cas\/login/i,
];

// OAuth provider patterns in URLs
const OAUTH_PATTERNS = [
  /accounts\.google\.com\/o\/oauth/i,
  /github\.com\/login\/oauth/i,
  /login\.microsoftonline\.com/i,
  /facebook\.com\/v\d+.*\/dialog\/oauth/i,
  /appleid\.apple\.com\/auth/i,
];

/**
 * Scan fetched HTML and response headers for indicators that a site requires authentication.
 *
 * Checks for:
 * - Login forms (password inputs)
 * - Meta redirects to auth paths
 * - OAuth login links
 * - WWW-Authenticate response header
 * - Location header redirecting to login
 * - SAML/SSO form patterns
 */
export function detectAuthRequired(
  html: string,
  url: string,
  headers: Record<string, string>,
): AuthDetectionResult {
  const signals: string[] = [];
  let loginUrl: string | undefined;

  // 1. WWW-Authenticate header
  if (headers['www-authenticate']) {
    signals.push(`WWW-Authenticate header: ${headers['www-authenticate']}`);
  }

  // 2. Location header redirecting to auth path
  const location = headers['location'];
  if (location) {
    if (AUTH_PATH_PATTERNS.some(p => p.test(location))) {
      signals.push(`Location redirect to auth path: ${location}`);
      loginUrl = loginUrl ?? location;
    }
  }

  // 3. Login form with password input
  const hasPasswordInput = /<input[^>]*type\s*=\s*["']password["'][^>]*>/i.test(html);
  const hasFormAction = /<form[^>]*action\s*=\s*["'][^"']*(?:login|signin|sign-in|auth)[^"']*["'][^>]*>/i.test(html);
  if (hasPasswordInput && hasFormAction) {
    signals.push('Detected login form with password input');
    // Try to extract login URL from form action
    const formMatch = html.match(/<form[^>]*action\s*=\s*["']([^"']*(?:login|signin|sign-in|auth)[^"']*)["']/i);
    if (formMatch) {
      loginUrl = loginUrl ?? formMatch[1];
    }
  } else if (hasPasswordInput) {
    signals.push('Detected login form with password input');
  }

  // 4. Meta redirect to auth path
  const metaRefresh = html.match(/<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'\s>]+)/i);
  if (metaRefresh) {
    const redirectUrl = metaRefresh[1];
    if (AUTH_PATH_PATTERNS.some(p => p.test(redirectUrl))) {
      signals.push(`Meta redirect to auth path: ${redirectUrl}`);
      loginUrl = loginUrl ?? redirectUrl;
    }
  }

  // 5. OAuth provider links
  const oauthMatch = OAUTH_PATTERNS.find(p => p.test(html));
  if (oauthMatch) {
    signals.push('OAuth provider login link detected');
  }

  // 6. SAML/SSO form
  const hasSaml = /SAMLRequest/i.test(html) || /saml/i.test(html);
  const hasSsoForm = /<form[^>]*action\s*=\s*["'][^"']*(?:sso|saml)[^"']*["'][^>]*>/i.test(html);
  if (hasSaml && hasSsoForm) {
    signals.push('SSO/SAML authentication form detected');
  }

  return {
    authRequired: signals.length > 0,
    signals,
    loginUrl,
  };
}

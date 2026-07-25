// src/auth/handoff.ts
import type { AuthManager } from './manager.js';
import type { StoredSession, StoredAuth } from '../types.js';
import { launchBrowser } from '../capture/browser.js';

export interface HandoffOptions {
  domain: string;
  loginUrl?: string;        // URL to navigate to (defaults to https://<domain>)
  timeout?: number;          // ms, default 300000 (5 minutes)
  /**
   * @internal Run the handoff browser headless — for tests only, and refused
   * outside a test run. A real handoff is a human logging in, so it is always
   * headed; a headless one would sit invisibly waiting for input that can
   * never come. Without this the flow cannot be exercised on a machine with
   * no display.
   */
  _headless?: boolean;
}

export interface HandoffResult {
  success: boolean;
  cookieCount: number;
  authDetected?: 'bearer' | 'cookie' | 'api-key';
  error?: string;
}

export interface OAuthTokenDetection {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

/** Specific OAuth token-endpoint patterns — an access_token here is trusted as an OAuth grant. */
const SPECIFIC_TOKEN_URL_PATTERNS = [
  /\/oauth\/token/i,
  /\/oauth2\/token/i,
  /\/o\/oauth2\/token/i,
  /securetoken\.googleapis\.com/i,
];

/** Broad token-endpoint pattern — matches any /token segment; requires a
 *  corroborating OAuth field in the body before we treat it as a grant. */
const BROAD_TOKEN_URL_PATTERN = /\/token\b/i;

/**
 * Detect OAuth token endpoint response from URL, status, and body.
 * Returns extracted token info or null if not an OAuth token response.
 */
export function detectOAuthTokenResponse(
  url: string,
  status: number,
  body: string,
): OAuthTokenDetection | null {
  if (status < 200 || status >= 300) return null;
  const specific = SPECIFIC_TOKEN_URL_PATTERNS.some(p => p.test(url));
  const broad = BROAD_TOKEN_URL_PATTERN.test(url);
  if (!specific && !broad) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed.access_token !== 'string') return null;

  // For broad /token matches (not a specific OAuth path), require a
  // corroborating OAuth field so we don't mis-capture non-OAuth endpoints
  // that merely return an `access_token`-named value.
  if (!specific) {
    const hasOAuthShape =
      typeof parsed.token_type === 'string' ||
      typeof parsed.expires_in === 'number' ||
      typeof parsed.refresh_token === 'string';
    if (!hasOAuthShape) return null;
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
  };
}

// Session-like cookie name patterns
const SESSION_COOKIE_PATTERNS = [
  /sess/i, /auth/i, /token/i, /jwt/i, /login/i,
  /sid$/i, /^_session/i, /^connect\.sid$/i,
];

// Tracking/analytics cookie patterns (exclude from session detection)
const TRACKING_COOKIE_PATTERNS = [
  /^_ga/i, /^_gid/i, /^_fb/i, /^_gcl/i, /^__utm/i,
];

// Common anonymous/bootstrap cookies that should not end auth flow
const ANONYMOUS_COOKIE_PATTERNS = [
  /^anon/i, /^guest/i, /^visitor/i, /^ab[_-]?test/i, /^optanon/i, /^consent/i,
];

/**
 * Detect whether a response indicates successful login.
 * Checks for session-like Set-Cookie headers on 2xx responses.
 */
export function detectLoginSuccess(
  headers: Map<string, string>,
  status: number,
): boolean {
  if (status < 200 || status >= 300) return false;

  // Check for auth header
  const authHeader = headers.get('authorization');
  if (authHeader && (authHeader.startsWith('Bearer ') || authHeader.startsWith('Basic '))) {
    return true;
  }

  // Check for session-like cookies
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return false;

  // Parse cookie name from Set-Cookie header
  const cookieName = setCookie.split('=')[0].trim();

  // Exclude tracking cookies
  if (TRACKING_COOKIE_PATTERNS.some(p => p.test(cookieName))) return false;

  // Match session-like cookies
  return SESSION_COOKIE_PATTERNS.some(p => p.test(cookieName));
}

function isSessionLikeCookieName(name: string): boolean {
  return SESSION_COOKIE_PATTERNS.some(p => p.test(name));
}

function isTrackingCookieName(name: string): boolean {
  return TRACKING_COOKIE_PATTERNS.some(p => p.test(name));
}

function isAnonymousCookieName(name: string): boolean {
  return ANONYMOUS_COOKIE_PATTERNS.some(p => p.test(name));
}

export function hasHighConfidenceAuthTransition(
  baselineCookieValues: Map<string, string>,
  currentCookies: Array<{ name: string; value: string }>,
): boolean {
  return currentCookies.some((cookie) => {
    const baseline = baselineCookieValues.get(cookie.name);
    const changedOrNew = baseline === undefined || baseline !== cookie.value;
    if (!changedOrNew) return false;
    if (!isSessionLikeCookieName(cookie.name)) return false;
    if (isTrackingCookieName(cookie.name)) return false;
    if (isAnonymousCookieName(cookie.name)) return false;
    return true;
  });
}

// Mutex to prevent concurrent handoffs for the same domain
const handoffLocks = new Map<string, Promise<HandoffResult>>();

/**
 * Open a visible browser for human authentication.
 *
 * Flow:
 * 1. Launch visible Chromium browser
 * 2. Navigate to login URL
 * 3. Wait for human to log in and close the browser
 * 4. Capture all cookies + detected auth from last snapshot
 * 5. Store encrypted via AuthManager
 * 6. Return result
 *
 * The user closing the browser is the primary signal that login is complete.
 * This avoids false positives from cookie-based heuristics that fire on
 * anonymous session cookies set during normal page load.
 */
/**
 * The handoff is a human logging in at a visible window, so headless is a
 * test-only affordance. Mirrors assertSsrfBypassAllowed: an internal flag
 * that would change security-relevant behaviour is refused outside a test
 * run rather than trusted to stay internal by comment alone.
 */
function assertHeadlessHandoffAllowed(flag: unknown): void {
  if (!flag) return;
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
  throw new Error(
    'Headless login handoff (_headless) is test-only and refused outside a test run — ' +
    'a real handoff needs a visible window for the human to log in',
  );
}

export async function requestAuth(
  authManager: AuthManager,
  options: HandoffOptions,
): Promise<HandoffResult> {
  const { domain } = options;

  // Mutex: prevent concurrent handoffs for same domain
  const existing = handoffLocks.get(domain);
  if (existing) return existing;

  const promise = doHandoff(authManager, options);
  handoffLocks.set(domain, promise);

  try {
    return await promise;
  } finally {
    handoffLocks.delete(domain);
  }
}

async function doHandoff(
  authManager: AuthManager,
  options: HandoffOptions,
): Promise<HandoffResult> {
  const { domain } = options;
  const loginUrl = options.loginUrl || `https://${domain}`;
  const timeout = options.timeout ?? 300_000; // 5 minutes

  assertHeadlessHandoffAllowed(options._headless);
  const { browser, context } = await launchBrowser({ headless: options._headless === true });

  try {

    // Restore existing session cookies if available (warm start)
    const cachedSession = await authManager.retrieveSessionWithFallback(domain);
    if (cachedSession?.cookies?.length) {
      await context.addCookies(cachedSession.cookies);
    }

    const page = await context.newPage();
    let authDetected: 'bearer' | 'cookie' | 'api-key' | undefined;
    let detectedAuth: StoredAuth | undefined;
    let detectedOAuth: OAuthTokenDetection | undefined;
    let latestCookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }> = [];

    // M13 fix: Only capture auth from requests targeting the handoff domain
    const targetDomain = domain;

    // Watch network responses for auth signals (bearer tokens, API keys, OAuth tokens)
    page.on('response', async (response) => {
      // M13: Filter by request origin — only capture auth from target domain
      let reqHost: string;
      try {
        reqHost = new URL(response.request().url()).hostname;
      } catch { return; }
      if (reqHost !== targetDomain && !reqHost.endsWith('.' + targetDomain)) {
        return; // Skip cross-origin requests
      }

      const reqHeaders = response.request().headers();

      // Detect auth from request headers
      const authHeader = reqHeaders['authorization'];
      if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
          authDetected = 'bearer';
          detectedAuth = {
            type: 'bearer',
            header: 'authorization',
            value: authHeader,
          };
        } else if (authHeader.toLowerCase().startsWith('apikey ') || authHeader.toLowerCase().startsWith('api-key ')) {
          authDetected = 'api-key';
          detectedAuth = {
            type: 'api-key',
            header: 'authorization',
            value: authHeader,
          };
        }
      }

      // Detect OAuth token endpoint responses
      try {
        const status = response.status();
        const url = response.url();
        if ((SPECIFIC_TOKEN_URL_PATTERNS.some(p => p.test(url)) || BROAD_TOKEN_URL_PATTERN.test(url)) && status >= 200 && status < 300) {
          const body = await response.text();
          const oauth = detectOAuthTokenResponse(url, status, body);
          if (oauth) {
            detectedOAuth = oauth;
          }
        }
      } catch { /* response body may not be available */ }
    });

    // Navigate to login page
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Inject a banner so the user knows what to do
    await page.evaluate(() => {
      const banner = document.createElement('div');
      banner.textContent = '\u{1F511} ApiTap — Log in, then close this browser window to save your session';
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:#1a1a2e;color:#e0e0e0;padding:8px 16px;font:14px/1.4 system-ui,sans-serif;' +
        'text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      document.body.prepend(banner);
    }).catch(() => {}); // Non-critical — page may block script execution

    // Continuously snapshot cookies so we have the latest when browser closes.
    // We can't read cookies after the browser disconnects.
    const cookieInterval = setInterval(async () => {
      try {
        latestCookies = await context.cookies();
      } catch {
        // Browser may be closing — keep last snapshot
      }
    }, 2000);

    // Wait for user to close browser (primary signal) or timeout.
    // The user logs in at their own pace, then closes the browser when done.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeout);
      browser.on('disconnected', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    clearInterval(cookieInterval);

    // Try to get final cookies (may fail if browser already disconnected)
    try {
      latestCookies = await context.cookies();
    } catch {
      // Browser disconnected — use last snapshot from interval
    }

    // M4 fix: Filter cookies to only the target domain and its subdomains
    const cookies = latestCookies.filter(c => {
      const cookieDomain = (c.domain || '').replace(/^\./, ''); // Remove leading dot
      return cookieDomain === domain ||
        cookieDomain.endsWith('.' + domain) ||
        (domain.endsWith('.' + cookieDomain) && cookieDomain.includes('.'));
    });

    if (cookies.length === 0 && !authDetected) {
      return {
        success: false,
        cookieCount: 0,
        error: 'No cookies captured. Browser may have been closed before page loaded.',
      };
    }

    const session: StoredSession = {
      cookies,
      savedAt: new Date().toISOString(),
      maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    };

    // ORDER MATTERS: authManager.store() replaces the whole record, while
    // storeSession/storeOAuthCredentials merge into it. The credential goes
    // in first and the sidecars after — the other way round, store() wiped
    // the session (and the OAuth refresh token) that had just been saved,
    // so the next handoff's warm start found nothing and the human had to
    // log in again.
    if (detectedOAuth) {
      detectedAuth = {
        type: 'bearer',
        header: 'authorization',
        value: `Bearer ${detectedOAuth.accessToken}`,
        ...(detectedOAuth.expiresIn ? {
          expiresAt: new Date(Date.now() + detectedOAuth.expiresIn * 1000).toISOString(),
        } : {}),
      };
      authDetected = 'bearer';
    }

    // Store detected auth header if found
    if (detectedAuth) {
      await authManager.store(domain, detectedAuth);
    } else if (cookies.length > 0) {
      // Store as cookie auth
      const sessionCookies = cookies
        .filter(c => SESSION_COOKIE_PATTERNS.some(p => p.test(c.name)))
        .filter(c => !TRACKING_COOKIE_PATTERNS.some(p => p.test(c.name)));

      if (sessionCookies.length > 0) {
        authDetected = 'cookie';
        const cookieHeader = sessionCookies
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        await authManager.store(domain, {
          type: 'cookie',
          header: 'cookie',
          value: cookieHeader,
        });
      }
    }

    // Sidecars last — see the ORDER MATTERS note above.
    await authManager.storeSession(domain, session);
    if (detectedOAuth?.refreshToken) {
      await authManager.storeOAuthCredentials(domain, {
        refreshToken: detectedOAuth.refreshToken,
      });
    }

    return {
      success: true,
      cookieCount: cookies.length,
      authDetected,
    };
  } catch (error) {
    return {
      success: false,
      cookieCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      // Browser already disconnected by user
    }
  }
}

// src/auth/handoff.ts
import type { AuthManager } from './manager.js';
import type { StoredSession, StoredAuth } from '../types.js';
import { launchBrowser } from '../capture/browser.js';

export interface HandoffOptions {
  domain: string;
  loginUrl?: string;        // URL to navigate to (defaults to https://<domain>)
  timeout?: number;          // ms, default 300000 (5 minutes)
}

export interface HandoffResult {
  success: boolean;
  cookieCount: number;
  authDetected?: 'bearer' | 'cookie' | 'api-key';
  error?: string;
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

// Mutex to prevent concurrent handoffs for the same domain
const handoffLocks = new Map<string, Promise<HandoffResult>>();

/**
 * Open a visible browser for human authentication.
 *
 * Flow:
 * 1. Launch visible Chromium browser
 * 2. Navigate to login URL
 * 3. Wait for human to log in (watches for session cookies / auth headers)
 * 4. Capture all cookies + detected auth
 * 5. Store encrypted via AuthManager
 * 6. Close browser, return result
 */
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

  const { browser, context } = await launchBrowser({ headless: false });

  try {

    // Restore existing session cookies if available (warm start)
    const cachedSession = await authManager.retrieveSessionWithFallback(domain);
    if (cachedSession?.cookies?.length) {
      await context.addCookies(cachedSession.cookies);
    }

    const page = await context.newPage();
    let authDetected: 'bearer' | 'cookie' | 'api-key' | undefined;
    let detectedAuth: StoredAuth | undefined;

    // Watch network responses for auth signals
    page.on('response', (response) => {
      const headers = new Map<string, string>();
      for (const [key, value] of Object.entries(response.headers())) {
        headers.set(key, value);
      }

      // Detect auth from request headers
      const authHeader = response.request().headers()['authorization'];
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
    });

    // Navigate to login page
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Poll for login success: check cookies periodically
    const startTime = Date.now();
    let loginDetected = false;

    while (Date.now() - startTime < timeout) {
      await page.waitForTimeout(2000);

      // Check if we've detected session cookies
      const cookies = await context.cookies();
      const hasSessionCookie = cookies.some(c =>
        SESSION_COOKIE_PATTERNS.some(p => p.test(c.name)) &&
        !TRACKING_COOKIE_PATTERNS.some(p => p.test(c.name))
      );

      if (hasSessionCookie || authDetected) {
        // Grace period: 4 additional polls at 2s each (~8s total)
        // Allows time for MFA, CAPTCHAs, and post-login redirects
        for (let grace = 0; grace < 4; grace++) {
          if (page.isClosed()) break;
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }
        loginDetected = true;
        break;
      }

      // Check if browser was closed by user
      if (page.isClosed()) break;
    }

    // Capture final cookies
    const cookies = await context.cookies();

    if (cookies.length === 0 && !authDetected) {
      return {
        success: false,
        cookieCount: 0,
        error: loginDetected ? undefined : 'Timeout: no login detected within the allowed time',
      };
    }

    // Store session cookies
    const session: StoredSession = {
      cookies,
      savedAt: new Date().toISOString(),
      maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    };
    await authManager.storeSession(domain, session);

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
    await browser.close();
  }
}

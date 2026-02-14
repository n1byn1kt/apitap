// src/auth/refresh.ts
import type { SkillFile, StoredToken, StoredSession } from '../types.js';
import type { AuthManager } from './manager.js';
import { refreshOAuth, type OAuthRefreshResult } from './oauth-refresh.js';

export interface RefreshOptions {
  domain: string;
  refreshUrl?: string;
  browserMode?: 'headless' | 'visible';
  timeout?: number; // ms, default 30000, extended to 300000 for captcha
  /** @internal Skip SSRF check — for testing only */
  _skipSsrfCheck?: boolean;
}

export interface RefreshResult {
  success: boolean;
  tokens: Record<string, string>;
  captchaDetected?: 'cloudflare' | 'recaptcha' | 'hcaptcha';
  oauthRefreshed?: boolean;
  error?: string;
}

// Mutex to prevent concurrent refreshes for the same domain
const refreshLocks = new Map<string, Promise<RefreshResult>>();

/**
 * Extract token values from a request body string.
 *
 * @param body - Raw request body (string)
 * @param tokenNames - JSON paths of tokens to extract (e.g., ["csrf_token", "data.nonce"])
 * @returns Map of token name to value
 */
export function extractTokensFromRequest(
  body: string,
  tokenNames: string[]
): Record<string, string> {
  const result: Record<string, string> = {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return result;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return result;
  }

  for (const path of tokenNames) {
    const value = getNestedValue(parsed as Record<string, unknown>, path);
    if (typeof value === 'string') {
      result[path] = value;
    }
  }

  return result;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Detect captcha challenge in page content.
 */
export function detectCaptcha(
  html: string
): 'cloudflare' | 'recaptcha' | 'hcaptcha' | null {
  // Cloudflare challenge
  if (
    html.includes('Just a moment...') ||
    html.includes('cdn-cgi/challenge-platform') ||
    html.includes('cf-browser-verification')
  ) {
    return 'cloudflare';
  }

  // reCAPTCHA
  if (
    html.includes('g-recaptcha') ||
    html.includes('google.com/recaptcha')
  ) {
    return 'recaptcha';
  }

  // hCaptcha
  if (
    html.includes('h-captcha') ||
    html.includes('hcaptcha.com')
  ) {
    return 'hcaptcha';
  }

  return null;
}

/**
 * Refresh tokens by spawning a browser and intercepting requests.
 *
 * This is the main entry point for token refresh. It:
 * 1. Launches a browser (visible if captchaRisk is true)
 * 2. Navigates to the refresh URL
 * 3. Intercepts outgoing requests to capture fresh token values
 * 4. Returns the captured tokens
 *
 * @param skill - Skill file with auth config and endpoint info
 * @param authManager - Auth manager for storing refreshed tokens
 * @param options - Refresh options
 */
export async function refreshTokens(
  skill: SkillFile,
  authManager: AuthManager,
  options: RefreshOptions
): Promise<RefreshResult> {
  const { domain } = options;

  // Check for existing refresh in progress (mutex)
  const existingRefresh = refreshLocks.get(domain);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = doRefresh(skill, authManager, options);
  refreshLocks.set(domain, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(domain);
  }
}

async function doRefresh(
  skill: SkillFile,
  authManager: AuthManager,
  options: RefreshOptions
): Promise<RefreshResult> {
  let oauthRefreshed = false;

  // Step 1: OAuth path — if oauthConfig + stored credentials available
  const oauthConfig = skill.auth?.oauthConfig;
  if (oauthConfig) {
    const oauthCreds = await authManager.retrieveOAuthCredentials(options.domain);
    const canOAuth =
      (oauthConfig.grantType === 'refresh_token' && oauthCreds?.refreshToken) ||
      (oauthConfig.grantType === 'client_credentials');

    if (canOAuth) {
      const oauthResult = await refreshOAuth(options.domain, oauthConfig, authManager, { _skipSsrfCheck: options._skipSsrfCheck });
      if (oauthResult.success) {
        oauthRefreshed = true;
      } else {
        // OAuth failed — fall through to browser path if available
      }
    }
  }

  // Step 2: Browser path — if refreshable tokens exist or refreshUrl is present
  const tokenNames = new Set<string>();
  for (const endpoint of skill.endpoints) {
    if (endpoint.requestBody?.refreshableTokens) {
      for (const name of endpoint.requestBody.refreshableTokens) {
        tokenNames.add(name);
      }
    }
  }

  const needsBrowser = tokenNames.size > 0 || (skill.auth?.refreshUrl && !oauthRefreshed);

  if (!needsBrowser) {
    // No browser refresh needed — return OAuth result
    return { success: oauthRefreshed, tokens: {}, oauthRefreshed: oauthRefreshed || undefined };
  }

  return doBrowserRefresh(skill, authManager, options, tokenNames, oauthRefreshed);
}

async function doBrowserRefresh(
  skill: SkillFile,
  authManager: AuthManager,
  options: RefreshOptions,
  tokenNames: Set<string>,
  oauthRefreshed: boolean
): Promise<RefreshResult> {
  if (tokenNames.size === 0 && !skill.auth?.refreshUrl) {
    return { success: oauthRefreshed, tokens: {}, oauthRefreshed: oauthRefreshed || undefined };
  }

  const { chromium } = await import('playwright');

  const browserMode = options.browserMode || skill.auth?.browserMode || 'headless';
  const refreshUrl = options.refreshUrl || skill.auth?.refreshUrl || skill.baseUrl;
  const timeout = options.timeout || (skill.auth?.captchaRisk ? 300_000 : 30_000);

  // Try to restore session from cache
  const cachedSession = await authManager.retrieveSession(options.domain);
  const sessionValid = cachedSession && isSessionValid(cachedSession);

  const browser = await chromium.launch({
    headless: browserMode === 'headless',
  });

  try {
    const context = await browser.newContext();

    // Restore cookies if session is valid
    if (sessionValid && cachedSession) {
      await context.addCookies(cachedSession.cookies);
    }

    const page = await context.newPage();
    const capturedTokens: Record<string, string> = {};
    let captchaDetected: 'cloudflare' | 'recaptcha' | 'hcaptcha' | null = null;

    // Intercept requests to capture token values
    if (tokenNames.size > 0) {
      page.on('request', (request) => {
        const body = request.postData();
        if (body) {
          const extracted = extractTokensFromRequest(body, [...tokenNames]);
          Object.assign(capturedTokens, extracted);
        }
      });
    }

    // Navigate and wait for network idle
    await page.goto(refreshUrl, { waitUntil: 'networkidle', timeout });

    // Check for captcha
    const content = await page.content();
    captchaDetected = detectCaptcha(content);

    if (captchaDetected) {
      // Extended timeout for captcha solving
      console.error(`\u26a0\ufe0f  Captcha detected (${captchaDetected}). Please solve it in the browser window.`);
      await page.waitForTimeout(timeout);

      // Re-check for tokens after captcha
      // User interaction will trigger requests containing tokens
    }

    // Wait a bit for any final requests
    await page.waitForTimeout(2000);

    // Save session for next time
    const cookies = await context.cookies();
    await authManager.storeSession(options.domain, {
      cookies,
      savedAt: new Date().toISOString(),
      maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Store captured tokens
    if (Object.keys(capturedTokens).length > 0) {
      const storedTokens: Record<string, StoredToken> = {};
      for (const [name, value] of Object.entries(capturedTokens)) {
        storedTokens[name] = {
          value,
          refreshedAt: new Date().toISOString(),
        };
      }
      await authManager.storeTokens(options.domain, storedTokens);
    }

    const browserSuccess = tokenNames.size === 0 || Object.keys(capturedTokens).length > 0;

    return {
      success: oauthRefreshed || browserSuccess,
      tokens: capturedTokens,
      captchaDetected: captchaDetected || undefined,
      oauthRefreshed: oauthRefreshed || undefined,
    };
  } catch (error) {
    return {
      success: oauthRefreshed, // OAuth may have succeeded even if browser failed
      tokens: {},
      error: error instanceof Error ? error.message : String(error),
      oauthRefreshed: oauthRefreshed || undefined,
    };
  } finally {
    await browser.close();
  }
}

function isSessionValid(session: StoredSession): boolean {
  const maxAge = session.maxAgeMs || 24 * 60 * 60 * 1000;
  const savedAt = new Date(session.savedAt).getTime();
  return Date.now() - savedAt < maxAge;
}

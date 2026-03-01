// src/capture/browser.ts
import type { Browser, BrowserContext } from 'playwright';
import type { PlaywrightCookie } from '../types.js';

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Normalize cookies for Playwright's storageState API.
 * storageState requires all fields (expires, httpOnly, secure, sameSite)
 * while addCookies() fills in defaults for missing fields.
 */
export function normalizeCookiesForStorageState(
  cookies: PlaywrightCookie[],
): Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }> {
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite ?? 'Lax',
  }));
}

/**
 * Launch args that reduce Playwright's automation fingerprint.
 */
export function getLaunchArgs(): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
  ];
}

/**
 * Realistic Chrome user-agent string for anti-detection.
 */
export function getChromeUserAgent(): string {
  return CHROME_USER_AGENT;
}

export function shouldPreferSystemChrome(): boolean {
  return process.env.APITAP_PREFER_SYSTEM_CHROME === '1';
}

/**
 * Launch a Chromium browser with anti-detection measures.
 *
 * Three layers:
 * 1. --disable-blink-features=AutomationControlled in launch args
 * 2. Realistic Chrome UA on context
 * 3. navigator.webdriver = false via addInitScript
 * 4. Viewport 1920x1080
 */
export async function launchBrowser(options: {
  headless: boolean;
  storageState?: { cookies: any[]; origins: any[] };
}): Promise<{ browser: Browser; context: BrowserContext }> {
  const { chromium } = await import('playwright');

  const launchOptions = {
    headless: options.headless,
    args: getLaunchArgs(),
  };

  let browser: Browser;
  if (shouldPreferSystemChrome()) {
    try {
      browser = await chromium.launch({
        ...launchOptions,
        channel: 'chrome',
      });
    } catch {
      browser = await chromium.launch(launchOptions);
    }
  } else {
    browser = await chromium.launch(launchOptions);
  }

  const context = await browser.newContext({
    userAgent: CHROME_USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3],
      configurable: true,
    });
    if (!(window as any).chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        configurable: true,
      });
    }
  });

  return { browser, context };
}

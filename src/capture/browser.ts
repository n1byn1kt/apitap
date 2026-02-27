// src/capture/browser.ts
import type { Browser, BrowserContext } from 'playwright';

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Launch args that reduce Playwright's automation fingerprint.
 */
export function getLaunchArgs(): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
  ];
}

/**
 * Realistic Chrome user-agent string for anti-detection.
 */
export function getChromeUserAgent(): string {
  return CHROME_USER_AGENT;
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
export async function launchBrowser(options: { headless: boolean }): Promise<{ browser: Browser; context: BrowserContext }> {
  const { chromium } = await import('playwright');

  const browser = await chromium.launch({
    headless: options.headless,
    args: getLaunchArgs(),
  });

  const context = await browser.newContext({
    userAgent: CHROME_USER_AGENT,
    viewport: { width: 1920, height: 1080 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
  });

  return { browser, context };
}

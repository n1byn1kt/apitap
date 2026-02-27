// test/e2e/anti-bot.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../../src/capture/browser.js';

describe('anti-bot measures', () => {
  it('navigator.webdriver is false in launched browser', async () => {
    const { browser, context } = await launchBrowser({ headless: true });
    try {
      const page = await context.newPage();
      const webdriver = await page.evaluate(() => navigator.webdriver);
      assert.equal(webdriver, false);
    } finally {
      await browser.close();
    }
  });

  it('user agent is realistic Chrome UA', async () => {
    const { browser, context } = await launchBrowser({ headless: true });
    try {
      const page = await context.newPage();
      const ua = await page.evaluate(() => navigator.userAgent);
      assert.ok(ua.includes('Chrome/120.0.0.0'));
      assert.ok(!ua.includes('Headless'));
    } finally {
      await browser.close();
    }
  });

  it('viewport is 1920x1080', async () => {
    const { browser, context } = await launchBrowser({ headless: true });
    try {
      const page = await context.newPage();
      const size = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      assert.equal(size.width, 1920);
      assert.equal(size.height, 1080);
    } finally {
      await browser.close();
    }
  });
});

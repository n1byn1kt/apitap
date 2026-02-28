// test/capture/browser.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLaunchArgs, getChromeUserAgent, shouldPreferSystemChrome } from '../../src/capture/browser.js';

describe('getLaunchArgs', () => {
  it('includes AutomationControlled disable flag', () => {
    const args = getLaunchArgs();
    assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
  });

  it('returns an array', () => {
    const args = getLaunchArgs();
    assert.ok(Array.isArray(args));
    assert.ok(args.length > 0);
  });

  it('includes additional anti-fingerprint flags', () => {
    const args = getLaunchArgs();
    assert.ok(args.includes('--disable-dev-shm-usage'));
    assert.ok(args.includes('--disable-features=IsolateOrigins,site-per-process'));
  });
});

describe('getChromeUserAgent', () => {
  it('returns a Chrome UA string', () => {
    const ua = getChromeUserAgent();
    assert.ok(ua.includes('Chrome/'));
    assert.ok(ua.includes('Windows NT'));
  });

  it('does not contain Playwright or Headless markers', () => {
    const ua = getChromeUserAgent();
    assert.ok(!ua.includes('Headless'));
    assert.ok(!ua.includes('Playwright'));
  });
});

describe('shouldPreferSystemChrome', () => {
  it('is false by default', () => {
    const original = process.env.APITAP_PREFER_SYSTEM_CHROME;
    try {
      delete process.env.APITAP_PREFER_SYSTEM_CHROME;
      assert.equal(shouldPreferSystemChrome(), false);
    } finally {
      if (original !== undefined) {
        process.env.APITAP_PREFER_SYSTEM_CHROME = original;
      } else {
        delete process.env.APITAP_PREFER_SYSTEM_CHROME;
      }
    }
  });
});

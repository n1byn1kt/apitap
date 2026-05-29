// test/capture/cdp-attach-integration.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';

const TEST_PORT = 9333; // avoid conflicting with user's 9222

// Check if Chrome is installed (skip gracefully on CI without Chrome)
let chromeAvailable = false;
try {
  execFileSync('which', ['google-chrome'], { stdio: 'ignore' });
  chromeAvailable = true;
} catch { /* Chrome not installed */ }

function cdpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

describe('CDP attach integration', { skip: !chromeAvailable ? 'Chrome not installed' : undefined }, () => {
  let chrome: ChildProcess;
  // Chrome being installed doesn't guarantee its remote-debugging port comes
  // up — in constrained CI sandboxes the port sometimes never binds. Track
  // readiness and skip (not fail) the tests when it doesn't, so this stays a
  // signal about cdp-attach behavior rather than a flaky env check.
  let cdpReady = false;

  before(async () => {
    chrome = spawn('google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      `--remote-debugging-port=${TEST_PORT}`,
      '--user-data-dir=/tmp/apitap-attach-test-chrome',
    ], { stdio: 'ignore' });

    // Wait for CDP to be ready
    for (let i = 0; i < 20; i++) {
      try {
        await cdpGet(`http://127.0.0.1:${TEST_PORT}/json/version`);
        cdpReady = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  });

  after(() => {
    if (chrome) chrome.kill();
  });

  it('discovers browser WebSocket URL and tab count', async (t) => {
    if (!cdpReady) {
      t.skip('Chrome remote-debugging port never became ready');
      return;
    }
    const { discoverBrowserWsUrl } = await import('../../src/capture/cdp-attach.js');

    const info = await discoverBrowserWsUrl(TEST_PORT);
    assert.ok(info.wsUrl.startsWith('ws://'));
    assert.ok(info.browser.includes('Chrome') || info.browser.includes('Headless'));
    assert.equal(typeof info.tabCount, 'number');
  });
});

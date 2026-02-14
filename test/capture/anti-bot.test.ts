// test/capture/anti-bot.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAntiBot } from '../../src/capture/anti-bot.js';

describe('detectAntiBot', () => {
  it('detects Cloudflare via cf-ray header', () => {
    const result = detectAntiBot({
      headers: { 'cf-ray': '1234abc', 'content-type': 'application/json' },
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('cloudflare'));
  });

  it('detects Cloudflare via __cf_bm cookie', () => {
    const result = detectAntiBot({
      headers: { 'content-type': 'text/html' },
      cookies: '__cf_bm=abc123; session=xyz',
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('cloudflare'));
  });

  it('detects Akamai via _abck cookie', () => {
    const result = detectAntiBot({
      headers: {},
      cookies: '_abck=abc123',
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('akamai'));
  });

  it('detects rate limiting via Retry-After', () => {
    const result = detectAntiBot({
      headers: { 'retry-after': '60' },
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('rate-limited'));
  });

  it('detects rate limiting via X-RateLimit-* headers', () => {
    const result = detectAntiBot({
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '100' },
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('rate-limited'));
  });

  it('detects CAPTCHA in response body', () => {
    const result = detectAntiBot({
      headers: {},
      body: '<div class="g-recaptcha" data-sitekey="abc"></div>',
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('captcha'));
  });

  it('detects hCaptcha', () => {
    const result = detectAntiBot({
      headers: {},
      body: '<script src="https://hcaptcha.com/1/api.js"></script>',
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('captcha'));
  });

  it('detects challenge page (403 + HTML)', () => {
    const result = detectAntiBot({
      headers: {},
      status: 403,
      contentType: 'text/html; charset=utf-8',
    });
    assert.ok(result.detected);
    assert.ok(result.signals.includes('challenge'));
  });

  it('does not flag challenge for 403 + JSON', () => {
    const result = detectAntiBot({
      headers: {},
      status: 403,
      contentType: 'application/json',
    });
    assert.ok(!result.signals.includes('challenge'));
  });

  it('returns multiple signals', () => {
    const result = detectAntiBot({
      headers: { 'cf-ray': '123', 'retry-after': '30' },
      body: 'Please complete the captcha',
    });
    assert.ok(result.signals.includes('cloudflare'));
    assert.ok(result.signals.includes('rate-limited'));
    assert.ok(result.signals.includes('captcha'));
  });

  it('returns empty for clean response', () => {
    const result = detectAntiBot({
      headers: { 'content-type': 'application/json' },
    });
    assert.ok(!result.detected);
    assert.deepEqual(result.signals, []);
  });

  it('handles case-insensitive headers', () => {
    const result = detectAntiBot({
      headers: { 'CF-Ray': '1234', 'Retry-After': '60' },
    });
    assert.ok(result.signals.includes('cloudflare'));
    assert.ok(result.signals.includes('rate-limited'));
  });
});

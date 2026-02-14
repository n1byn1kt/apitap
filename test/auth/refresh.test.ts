// test/auth/refresh.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTokensFromRequest,
  detectCaptcha,
} from '../../src/auth/refresh.js';

describe('extractTokensFromRequest', () => {
  it('should extract token from JSON body', () => {
    const body = JSON.stringify({
      action: 'submit',
      csrf_token: '89f1d8b1568692c9160dee459f4ae000',
    });
    const tokenNames = ['csrf_token'];

    const result = extractTokensFromRequest(body, tokenNames);

    assert.deepEqual(result, {
      csrf_token: '89f1d8b1568692c9160dee459f4ae000',
    });
  });

  it('should extract nested token', () => {
    const body = JSON.stringify({
      data: { xsrf: 'abcdef123456789012345678901234567890' },
    });
    const tokenNames = ['data.xsrf'];

    const result = extractTokensFromRequest(body, tokenNames);

    assert.deepEqual(result, {
      'data.xsrf': 'abcdef123456789012345678901234567890',
    });
  });

  it('should handle multiple tokens', () => {
    const body = JSON.stringify({
      csrf: 'token1111111111111111111111111111',
      nonce: 'token2222222222222222222222222222',
    });
    const tokenNames = ['csrf', 'nonce'];

    const result = extractTokensFromRequest(body, tokenNames);

    assert.equal(Object.keys(result).length, 2);
  });

  it('should return empty object for missing tokens', () => {
    const body = JSON.stringify({ foo: 'bar' });
    const tokenNames = ['csrf_token'];

    const result = extractTokensFromRequest(body, tokenNames);

    assert.deepEqual(result, {});
  });

  it('should handle non-JSON body gracefully', () => {
    const body = 'not json';
    const tokenNames = ['csrf_token'];

    const result = extractTokensFromRequest(body, tokenNames);

    assert.deepEqual(result, {});
  });
});

describe('detectCaptcha', () => {
  it('should detect Cloudflare challenge', () => {
    const html = '<html><title>Just a moment...</title><script src="cdn-cgi/challenge-platform"></script></html>';
    const result = detectCaptcha(html);
    assert.equal(result, 'cloudflare');
  });

  it('should detect reCAPTCHA', () => {
    const html = '<html><div class="g-recaptcha"></div></html>';
    const result = detectCaptcha(html);
    assert.equal(result, 'recaptcha');
  });

  it('should detect hCaptcha', () => {
    const html = '<html><div class="h-captcha"></div></html>';
    const result = detectCaptcha(html);
    assert.equal(result, 'hcaptcha');
  });

  it('should return null for normal pages', () => {
    const html = '<html><body>Normal content</body></html>';
    const result = detectCaptcha(html);
    assert.equal(result, null);
  });
});

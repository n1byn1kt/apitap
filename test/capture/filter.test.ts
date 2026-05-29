// test/capture/filter.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCapture } from '../../src/capture/filter.js';

describe('shouldCapture', () => {
  it('keeps JSON responses from non-blocklisted domains', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 200,
      contentType: 'application/json',
    }), true);
  });

  describe('drops sensitive PII / financial / account-security paths', () => {
    const sensitive = [
      'https://api.example.com/account/security',
      'https://api.example.com/checkout',
      'https://api.example.com/payment/methods',
      'https://api.example.com/billing/invoices',
      'https://api.example.com/users/me/password',
      'https://api.example.com/reset-password',
      'https://api.example.com/2fa/verify',
    ];
    for (const url of sensitive) {
      it(`drops ${url} even when 2xx JSON`, () => {
        assert.equal(
          shouldCapture({ url, status: 200, contentType: 'application/json' }),
          false,
          `${url} is a sensitive path and must not be captured`,
        );
      });
    }

    it('still captures OAuth/token endpoints (auth capture is intentional)', () => {
      // ApiTap's auth subsystem is designed to capture these; the secret is
      // extracted to the encrypted store and scrubbed from the skill file.
      for (const url of [
        'https://api.example.com/oauth/token',
        'https://api.example.com/login',
        'https://api.example.com/authors', // also: must not match a credential pattern
      ]) {
        assert.equal(
          shouldCapture({ url, status: 200, contentType: 'application/json' }),
          true,
          `${url} should remain capturable`,
        );
      }
    });
  });

  it('keeps JSON responses with charset parameter', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 200,
      contentType: 'application/json; charset=utf-8',
    }), true);
  });

  it('keeps vnd.api+json content type', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 200,
      contentType: 'application/vnd.api+json',
    }), true);
  });

  it('drops non-JSON content types', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/style.css',
      status: 200,
      contentType: 'text/css',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://example.com/page',
      status: 200,
      contentType: 'text/html',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://example.com/image.png',
      status: 200,
      contentType: 'image/png',
    }), false);
  });

  it('drops error responses', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 404,
      contentType: 'application/json',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 500,
      contentType: 'application/json',
    }), false);
  });

  it('drops blocklisted domains', () => {
    assert.equal(shouldCapture({
      url: 'https://google-analytics.com/collect',
      status: 200,
      contentType: 'application/json',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://o123.ingest.sentry.io/envelope',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('keeps redirect responses (3xx) with JSON body', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/redirect',
      status: 301,
      contentType: 'application/json',
    }), false);
  });

  it('keeps 2xx responses', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/created',
      status: 201,
      contentType: 'application/json',
    }), true);

    assert.equal(shouldCapture({
      url: 'https://api.example.com/accepted',
      status: 204,
      contentType: 'application/json',
    }), true);
  });

  it('drops _next/static build assets', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/_next/static/TjugEgeSUE4oCdg-1g2I1/_clientMiddlewareManifest.json',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('keeps _next/data routes (data API, not static assets)', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/_next/data/TjugEgeSUE4oCdg-1g2I1/en/tech.json',
      status: 200,
      contentType: 'application/json',
    }), true);
  });

  it('drops /monitoring telemetry path', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/monitoring',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('drops /telemetry and /track paths', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/telemetry',
      status: 200,
      contentType: 'application/json',
    }), false);
    assert.equal(shouldCapture({
      url: 'https://example.com/track',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('drops manifest.json', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/manifest.json',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('keeps normal API paths that contain noise words as segments', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/api/monitoring/status',
      status: 200,
      contentType: 'application/json',
    }), true);
  });

  it('rejects chrome-extension:// URLs', () => {
    assert.equal(shouldCapture({
      url: 'chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/api/data',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('rejects moz-extension:// URLs', () => {
    assert.equal(shouldCapture({
      url: 'moz-extension://abcd1234/api/data',
      status: 200,
      contentType: 'application/json',
    }), false);
  });
});

// test/discovery/frameworks.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectFrameworks } from '../../src/discovery/frameworks.js';

describe('detectFrameworks', () => {
  describe('WordPress', () => {
    it('detects WordPress from wp-json link', () => {
      const result = detectFrameworks({
        html: '<link rel="https://api.w.org/" href="https://example.com/wp-json/">',
        headers: {},
        url: 'https://example.com',
      });
      assert.ok(result.some(f => f.name === 'WordPress'));
      const wp = result.find(f => f.name === 'WordPress')!;
      assert.ok(wp.apiPatterns.includes('/wp-json/wp/v2/posts'));
    });

    it('detects WordPress from wp-content + wp-includes (high confidence)', () => {
      const result = detectFrameworks({
        html: '<link rel="stylesheet" href="/wp-content/themes/x/style.css"><script src="/wp-includes/js/jquery.js">',
        headers: {},
        url: 'https://example.com',
      });
      const wp = result.find(f => f.name === 'WordPress')!;
      assert.ok(wp);
      assert.equal(wp.confidence, 'high');
    });

    it('detects WordPress from Link header', () => {
      const result = detectFrameworks({
        html: '<html><body>Hello</body></html>',
        headers: { 'Link': '</wp-json/>; rel="https://api.w.org/"' },
        url: 'https://example.com',
      });
      assert.ok(result.some(f => f.name === 'WordPress'));
    });

    it('returns medium confidence with single signal', () => {
      const result = detectFrameworks({
        html: '<html><link href="/wp-json/"><body>Hello</body></html>',
        headers: {},
        url: 'https://example.com',
      });
      const wp = result.find(f => f.name === 'WordPress')!;
      assert.ok(wp);
      assert.equal(wp.confidence, 'medium');
    });
  });

  describe('Shopify', () => {
    it('detects Shopify from CDN link + Shopify.theme', () => {
      const result = detectFrameworks({
        html: '<script src="https://cdn.shopify.com/s/files/1/theme.js"></script><script>Shopify.theme = {};</script>',
        headers: {},
        url: 'https://mystore.com',
      });
      const shopify = result.find(f => f.name === 'Shopify')!;
      assert.ok(shopify);
      assert.equal(shopify.confidence, 'high');
      assert.ok(shopify.apiPatterns.includes('/products.json'));
    });
  });

  describe('Next.js', () => {
    it('detects Next.js from __NEXT_DATA__ + /_next/', () => {
      const result = detectFrameworks({
        html: '<script id="__NEXT_DATA__" type="application/json">{"buildId":"abc123"}</script><script src="/_next/static/chunks/main.js">',
        headers: {},
        url: 'https://example.com',
      });
      const nextjs = result.find(f => f.name === 'Next.js')!;
      assert.ok(nextjs);
      assert.equal(nextjs.confidence, 'high');
      assert.ok(nextjs.apiPatterns.includes('/api/'));
    });

    it('extracts buildId for _next/data pattern', () => {
      const result = detectFrameworks({
        html: '<script id="__NEXT_DATA__">{"buildId":"xYz123"}</script><link href="/_next/static/css/app.css">',
        headers: {},
        url: 'https://example.com',
      });
      const nextjs = result.find(f => f.name === 'Next.js')!;
      assert.ok(nextjs.apiPatterns.some(p => p.includes('xYz123')));
    });

    it('detects Next.js from X-Powered-By header', () => {
      const result = detectFrameworks({
        html: '<html><body>App</body></html>',
        headers: { 'X-Powered-By': 'Next.js' },
        url: 'https://example.com',
      });
      assert.ok(result.some(f => f.name === 'Next.js'));
    });
  });

  describe('Nuxt', () => {
    it('detects Nuxt from __NUXT__ + /_nuxt/', () => {
      const result = detectFrameworks({
        html: '<script>window.__NUXT__={}</script><script src="/_nuxt/entry.js">',
        headers: {},
        url: 'https://example.com',
      });
      const nuxt = result.find(f => f.name === 'Nuxt')!;
      assert.ok(nuxt);
      assert.equal(nuxt.confidence, 'high');
    });
  });

  describe('GraphQL', () => {
    it('detects GraphQL from Apollo + /graphql', () => {
      const result = detectFrameworks({
        html: '<script>window.__APOLLO_STATE__={}</script><script src="/graphql-client.js">',
        headers: {},
        url: 'https://example.com',
      });
      const gql = result.find(f => f.name === 'GraphQL')!;
      assert.ok(gql);
      assert.ok(gql.apiPatterns.includes('/graphql'));
    });
  });

  describe('Drupal', () => {
    it('detects Drupal from headers + jsonapi', () => {
      const result = detectFrameworks({
        html: '<html><link href="/jsonapi/node/article"><body></body></html>',
        headers: { 'X-Drupal-Cache': 'HIT', 'X-Drupal-Dynamic-Cache': 'MISS' },
        url: 'https://example.com',
      });
      const drupal = result.find(f => f.name === 'Drupal')!;
      assert.ok(drupal);
      assert.equal(drupal.confidence, 'high');
    });
  });

  describe('Strapi', () => {
    it('detects Strapi from X-Powered-By header', () => {
      const result = detectFrameworks({
        html: '',
        headers: { 'X-Powered-By': 'Strapi <strapi.io>' },
        url: 'https://example.com',
      });
      const strapi = result.find(f => f.name === 'Strapi')!;
      assert.ok(strapi);
      assert.equal(strapi.confidence, 'high');
    });
  });

  describe('Laravel', () => {
    it('detects Laravel from session cookie', () => {
      const result = detectFrameworks({
        html: '',
        headers: { 'Set-Cookie': 'laravel_session=abc123; path=/; HttpOnly' },
        url: 'https://example.com',
      });
      assert.ok(result.some(f => f.name === 'Laravel'));
    });
  });

  it('returns empty array for unknown sites', () => {
    const result = detectFrameworks({
      html: '<html><body>Hello World</body></html>',
      headers: {},
      url: 'https://example.com',
    });
    assert.equal(result.length, 0);
  });

  it('detects multiple frameworks', () => {
    const result = detectFrameworks({
      html: '<script>window.__NEXT_DATA__={}</script><script src="/_next/x.js"></script><script src="/graphql-client.js">window.__APOLLO_STATE__={}</script>',
      headers: {},
      url: 'https://example.com',
    });
    assert.ok(result.some(f => f.name === 'Next.js'));
    assert.ok(result.some(f => f.name === 'GraphQL'));
  });

  it('sorts results by confidence (high first)', () => {
    const result = detectFrameworks({
      html: '<script>window.__NEXT_DATA__={}</script><script src="/_next/x.js"></script><script>django stuff</script>',
      headers: { 'X-Frame-Options': 'DENY', 'Vary': 'Cookie' },
      url: 'https://example.com',
    });
    if (result.length >= 2) {
      const order = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < result.length; i++) {
        assert.ok(order[result[i - 1].confidence] <= order[result[i].confidence]);
      }
    }
  });

  it('normalizes header case', () => {
    const result = detectFrameworks({
      html: '',
      headers: { 'X-POWERED-BY': 'Strapi <strapi.io>' },
      url: 'https://example.com',
    });
    assert.ok(result.some(f => f.name === 'Strapi'));
  });
});

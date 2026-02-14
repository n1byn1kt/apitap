// src/discovery/frameworks.ts
import type { DetectedFramework } from '../types.js';

export interface PageInfo {
  html: string;
  headers: Record<string, string>;
  url: string;
}

interface FrameworkDetector {
  name: string;
  detect(page: PageInfo): DetectedFramework | null;
}

const detectors: FrameworkDetector[] = [
  {
    name: 'wordpress',
    detect({ html, headers }) {
      const signals: string[] = [];
      if (html.includes('/wp-json/')) signals.push('wp-json link');
      if (html.includes('/wp-content/')) signals.push('wp-content');
      if (html.includes('/wp-includes/')) signals.push('wp-includes');
      if (headers['link']?.includes('/wp-json/')) signals.push('Link header');
      if (headers['x-powered-by']?.toLowerCase().includes('wordpress')) signals.push('X-Powered-By');

      if (signals.length === 0) return null;
      return {
        name: 'WordPress',
        confidence: signals.length >= 2 ? 'high' : 'medium',
        apiPatterns: [
          '/wp-json/wp/v2/posts',
          '/wp-json/wp/v2/pages',
          '/wp-json/wp/v2/categories',
          '/wp-json/wp/v2/tags',
          '/wp-json/wp/v2/media',
          '/wp-json/wp/v2/users',
          '/wp-json/wp/v2/comments',
          '/wp-json/wp/v2/search',
        ],
      };
    },
  },
  {
    name: 'shopify',
    detect({ html, url }) {
      const signals: string[] = [];
      if (html.includes('cdn.shopify.com')) signals.push('Shopify CDN');
      if (html.includes('Shopify.theme')) signals.push('Shopify.theme');
      if (html.includes('myshopify.com')) signals.push('myshopify domain');
      if (html.includes('shopify-section')) signals.push('shopify-section');

      if (signals.length === 0) return null;
      const origin = new URL(url).origin;
      return {
        name: 'Shopify',
        confidence: signals.length >= 2 ? 'high' : 'medium',
        apiPatterns: [
          '/products.json',
          '/collections.json',
          '/cart.json',
          '/search/suggest.json',
        ],
      };
    },
  },
  {
    name: 'nextjs',
    detect({ html, headers }) {
      const signals: string[] = [];
      if (html.includes('__NEXT_DATA__')) signals.push('__NEXT_DATA__');
      if (html.includes('/_next/')) signals.push('_next assets');
      if (headers['x-nextjs-cache']) signals.push('X-Nextjs-Cache');
      if (headers['x-powered-by']?.toLowerCase().includes('next.js')) signals.push('X-Powered-By');

      if (signals.length === 0) return null;

      // Extract build ID from __NEXT_DATA__ if available
      const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/);
      const patterns: string[] = ['/api/'];
      if (buildIdMatch) {
        patterns.push(`/_next/data/${buildIdMatch[1]}/`);
      }

      return {
        name: 'Next.js',
        confidence: signals.length >= 2 ? 'high' : 'medium',
        apiPatterns: patterns,
      };
    },
  },
  {
    name: 'nuxt',
    detect({ html, headers }) {
      const signals: string[] = [];
      if (html.includes('__NUXT__')) signals.push('__NUXT__');
      if (html.includes('/_nuxt/')) signals.push('_nuxt assets');
      if (html.includes('_payload.json')) signals.push('_payload.json');
      if (html.includes('nuxt-link')) signals.push('nuxt-link');

      if (signals.length === 0) return null;
      return {
        name: 'Nuxt',
        confidence: signals.length >= 2 ? 'high' : 'medium',
        apiPatterns: ['/api/', '/_payload.json'],
      };
    },
  },
  {
    name: 'graphql',
    detect({ html }) {
      const signals: string[] = [];
      if (html.includes('/graphql')) signals.push('/graphql reference');
      if (html.includes('__APOLLO_STATE__')) signals.push('Apollo state');
      if (html.includes('apollo-client')) signals.push('apollo-client');
      if (html.includes('relay-')) signals.push('Relay');
      if (html.includes('urql')) signals.push('urql');

      if (signals.length === 0) return null;
      return {
        name: 'GraphQL',
        confidence: signals.length >= 2 ? 'high' : 'medium',
        apiPatterns: ['/graphql', '/gql', '/api/graphql'],
      };
    },
  },
  {
    name: 'drupal',
    detect({ html, headers }) {
      const signals: string[] = [];
      if (headers['x-drupal-cache']) signals.push('X-Drupal-Cache');
      if (headers['x-drupal-dynamic-cache']) signals.push('X-Drupal-Dynamic-Cache');
      if (headers['x-generator']?.toLowerCase().includes('drupal')) signals.push('X-Generator');
      if (html.includes('/jsonapi/')) signals.push('jsonapi');
      if (html.includes('drupal-settings-json')) signals.push('drupal-settings');

      if (signals.length === 0) return null;
      return {
        name: 'Drupal',
        confidence: signals.length >= 2 ? 'high' : 'medium',
        apiPatterns: [
          '/jsonapi/node/article',
          '/jsonapi/node/page',
          '/jsonapi/taxonomy_term',
        ],
      };
    },
  },
  {
    name: 'rails',
    detect({ headers }) {
      const signals: string[] = [];
      if (headers['x-request-id'] && headers['x-runtime']) signals.push('Rails headers');
      if (headers['x-powered-by']?.toLowerCase().includes('phusion')) signals.push('Phusion');

      if (signals.length === 0) return null;
      return {
        name: 'Rails',
        confidence: 'low',
        apiPatterns: ['/api/v1/'],
      };
    },
  },
  {
    name: 'django-rest',
    detect({ headers, html }) {
      const signals: string[] = [];
      if (headers['x-frame-options'] && headers['vary']?.includes('Cookie')) signals.push('Django-like headers');
      if (html.includes('csrfmiddlewaretoken')) signals.push('CSRF middleware');
      if (html.includes('django')) signals.push('django reference');

      if (signals.length === 0) return null;
      return {
        name: 'Django',
        confidence: 'low',
        apiPatterns: ['/api/', '/api/v1/', '/rest/'],
      };
    },
  },
  {
    name: 'laravel',
    detect({ html, headers }) {
      const signals: string[] = [];
      if (html.includes('csrf-token') && html.includes('laravel')) signals.push('Laravel meta');
      if (headers['set-cookie']?.includes('laravel_session')) signals.push('laravel_session');

      if (signals.length === 0) return null;
      return {
        name: 'Laravel',
        confidence: 'medium',
        apiPatterns: ['/api/', '/api/v1/'],
      };
    },
  },
  {
    name: 'strapi',
    detect({ headers }) {
      const signals: string[] = [];
      if (headers['x-powered-by']?.toLowerCase().includes('strapi')) signals.push('X-Powered-By');

      if (signals.length === 0) return null;
      return {
        name: 'Strapi',
        confidence: 'high',
        apiPatterns: ['/api/', '/api/content-types', '/api/articles', '/api/pages'],
      };
    },
  },
];

/**
 * Detect web frameworks from a page's HTML and response headers.
 * Returns all detected frameworks, sorted by confidence (high first).
 */
export function detectFrameworks(page: PageInfo): DetectedFramework[] {
  const results: DetectedFramework[] = [];
  // Lowercase headers for consistent matching
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(page.headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }
  const normalizedPage = { ...page, headers: normalizedHeaders };

  for (const detector of detectors) {
    const result = detector.detect(normalizedPage);
    if (result) results.push(result);
  }

  const order = { high: 0, medium: 1, low: 2 };
  results.sort((a, b) => order[a.confidence] - order[b.confidence]);
  return results;
}

// src/read/peek.ts
import type { PeekResult } from './types.js';
import { safeFetch } from '../discovery/fetch.js';

export interface PeekOptions {
  skipSsrf?: boolean;
}

/**
 * HTTP HEAD-only triage: checks accessibility, detects bot protection and frameworks.
 * Falls back to GET if HEAD fails.
 */
export async function peek(url: string, options: PeekOptions = {}): Promise<PeekResult> {
  const signals: string[] = [];

  // Try HEAD first
  let result = await safeFetch(url, {
    method: 'HEAD',
    skipSsrf: options.skipSsrf,
  });

  // Fall back to GET if HEAD fails (null = network/SSRF error)
  if (!result) {
    result = await safeFetch(url, {
      method: 'GET',
      skipSsrf: options.skipSsrf,
    });
  }

  // Both HEAD and GET failed
  if (!result) {
    return {
      url,
      status: 0,
      accessible: false,
      contentType: null,
      server: null,
      framework: null,
      botProtection: null,
      signals: ['fetch failed'],
      recommendation: 'blocked',
    };
  }

  const { status, headers } = result;

  // Extract basic metadata
  const contentType = headers['content-type'] || null;
  const server = headers['server'] || null;

  // Detect bot protection
  const botProtection = detectBotProtection(headers, signals);

  // Detect framework
  const framework = detectFramework(headers, signals);

  // Determine accessibility and recommendation
  const accessible = status >= 200 && status < 400 && !botProtection;
  const recommendation = computeRecommendation(status, botProtection);

  return {
    url,
    status,
    accessible,
    contentType,
    server,
    framework,
    botProtection,
    signals,
    recommendation,
  };
}

function detectBotProtection(
  headers: Record<string, string>,
  signals: string[],
): string | null {
  // Cloudflare: cf-ray or cf-cache-status
  if (headers['cf-ray']) {
    signals.push('cf-ray header');
    return 'cloudflare';
  }
  if (headers['cf-cache-status']) {
    signals.push('cf-cache-status header');
    return 'cloudflare';
  }

  // PerimeterX: x-px-* headers
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-px-')) {
      signals.push(`${key} header`);
      return 'perimeterx';
    }
  }

  // DataDome: x-datadome* headers
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-datadome')) {
      signals.push(`${key} header`);
      return 'datadome';
    }
  }

  return null;
}

function detectFramework(
  headers: Record<string, string>,
  signals: string[],
): string | null {
  // Next.js: x-powered-by: Next.js
  const poweredBy = headers['x-powered-by'];
  if (poweredBy && /next\.js/i.test(poweredBy)) {
    signals.push('x-powered-by: Next.js');
    return 'next.js';
  }

  // Express: x-powered-by: Express
  if (poweredBy && /express/i.test(poweredBy)) {
    signals.push('x-powered-by: Express');
    return 'express';
  }

  // PHP: x-powered-by: PHP/*
  if (poweredBy && /php/i.test(poweredBy)) {
    signals.push('x-powered-by: PHP');
    return 'php';
  }

  // WordPress: link header containing api.w.org
  const link = headers['link'];
  if (link && link.includes('api.w.org')) {
    signals.push('link: api.w.org');
    return 'wordpress';
  }

  // Shopify: x-shopify-stage header
  if (headers['x-shopify-stage']) {
    signals.push('x-shopify-stage header');
    return 'shopify';
  }

  // Drupal: x-drupal-* headers
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-drupal-')) {
      signals.push(`${key} header`);
      return 'drupal';
    }
  }

  return null;
}

function computeRecommendation(
  status: number,
  botProtection: string | null,
): PeekResult['recommendation'] {
  // Auth required
  if (status === 401 || status === 407) {
    return 'auth_required';
  }

  // Blocked: bot protection, 403, 429, or 5xx
  if (botProtection) {
    return 'blocked';
  }
  if (status === 403 || status === 429) {
    return 'blocked';
  }
  if (status >= 500) {
    return 'blocked';
  }

  return 'read';
}

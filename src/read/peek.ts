// src/read/peek.ts
import type { PeekResult } from './types.js';
import { safeFetchDetailed, type SafeFetchFailure } from '../discovery/fetch.js';
import { assertSsrfBypassAllowed } from '../skill/ssrf.js';

export interface PeekOptions {
  skipSsrf?: boolean;
}

/**
 * HTTP HEAD-only triage: checks accessibility, detects bot protection and frameworks.
 * Falls back to GET if HEAD fails.
 */
export async function peek(url: string, options: PeekOptions = {}): Promise<PeekResult> {
  assertSsrfBypassAllowed(options.skipSsrf);
  const signals: string[] = [];

  // Try HEAD first
  const headAttempt = await safeFetchDetailed(url, {
    method: 'HEAD',
    skipSsrf: options.skipSsrf,
  });
  let result = headAttempt.result;
  let fetchError: SafeFetchFailure | null = headAttempt.error;

  // Fall back to GET if HEAD fails (null = network/SSRF error)
  if (!result) {
    const getAttempt = await safeFetchDetailed(url, {
      method: 'GET',
      skipSsrf: options.skipSsrf,
    });
    result = getAttempt.result;
    if (!result) fetchError = getAttempt.error ?? fetchError;
  }

  // Both HEAD and GET failed — say why, honestly. A client-side transport
  // failure is NOT the site blocking us (Polymarket's huge CSP headers
  // overflow undici while curl gets a 200).
  if (!result) {
    if (fetchError?.kind === 'ssrf') {
      signals.push(`blocked by SSRF protection: ${fetchError.message}`);
    } else {
      signals.push(`transport error: ${fetchError?.code ?? 'UNKNOWN'} (${fetchError?.message ?? 'fetch failed'})`);
      if (fetchError?.code === 'UND_ERR_HEADERS_OVERFLOW') {
        signals.push('response headers exceeded the HTTP client limit — not bot protection; the site may still be reachable');
      }
    }
    return {
      url,
      status: 0,
      accessible: false,
      contentType: null,
      server: null,
      framework: null,
      botProtection: null,
      signals,
      recommendation: fetchError?.kind === 'ssrf' ? 'blocked' : 'error',
    };
  }

  const { status, headers } = result;

  // Extract basic metadata
  const contentType = headers['content-type'] || null;
  const server = headers['server'] || null;

  // JSON API responses with HTTP 200 are always accessible, regardless of CDN headers
  if (status === 200 && contentType && contentType.includes('application/json')) {
    const framework = detectFramework(headers, signals);
    return {
      url,
      status,
      accessible: true,
      contentType,
      server,
      framework,
      botProtection: null,
      signals,
      recommendation: 'read',
    };
  }

  // Detect bot protection
  const botProtection = detectBotProtection(headers, signals);

  // Detect framework
  const framework = detectFramework(headers, signals);

  // Determine accessibility and recommendation. A detected vendor on a
  // passing status means THIS request got through — report the vendor and
  // warn, but don't call a 200 "blocked". Conversely, a passing HEAD on a
  // landing page proves little about deeper data paths.
  const recommendation = computeRecommendation(status);
  const accessible = status >= 200 && status < 400 && recommendation !== 'blocked';
  if (botProtection && accessible) {
    signals.push(`${botProtection} present but this request passed — deeper paths may challenge`);
  }

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
  const cookies = headers['set-cookie'] ?? '';

  // Cloudflare CDN presence alone is not bot protection — half the web has
  // cf-ray. Only bot-management evidence (challenge cookie, mitigation header)
  // counts as the vendor actively screening.
  if (headers['cf-mitigated'] || /(?:^|[\s;,])(?:__cf_bm|cf_clearance)=/.test(cookies)) {
    signals.push('cloudflare bot management (cookie/header)');
    return 'cloudflare';
  }
  if (headers['cf-ray'] || headers['cf-cache-status']) {
    signals.push('cloudflare CDN');
  }

  // PerimeterX / HUMAN: x-px-* headers or _px* cookies
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-px-')) {
      signals.push(`${key} header`);
      return 'perimeterx';
    }
  }
  if (/(?:^|[\s;,])_px[\w]*=/.test(cookies)) {
    signals.push('_px cookie');
    return 'perimeterx';
  }

  // DataDome: x-datadome* headers or datadome cookie
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-datadome')) {
      signals.push(`${key} header`);
      return 'datadome';
    }
  }
  if (/(?:^|[\s;,])datadome=/.test(cookies)) {
    signals.push('datadome cookie');
    return 'datadome';
  }

  // Akamai Bot Manager: _abck / ak_bmsc / bm_sv cookies
  if (/(?:^|[\s;,])(?:_abck|ak_bmsc|bm_sv|bm_sz)=/.test(cookies)) {
    signals.push('akamai bot manager cookie');
    return 'akamai';
  }

  // Kasada: x-kpsdk-* headers
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-kpsdk-')) {
      signals.push(`${key} header`);
      return 'kasada';
    }
  }

  // Imperva / Incapsula: x-iinfo header or visid_incap cookie
  if (headers['x-iinfo'] || /(?:^|[\s;,])(?:visid_incap|incap_ses)_?/.test(cookies)) {
    signals.push('imperva/incapsula signal');
    return 'imperva';
  }

  // AWS WAF: challenge token headers
  if (headers['x-amzn-waf-action']) {
    signals.push('x-amzn-waf-action header');
    return 'aws-waf';
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

function computeRecommendation(status: number): PeekResult['recommendation'] {
  // Auth required
  if (status === 401 || status === 407) {
    return 'auth_required';
  }

  // Blocked: 403, 429, or 5xx — what the server DID, not who fronts it
  if (status === 403 || status === 429) {
    return 'blocked';
  }
  if (status >= 500) {
    return 'blocked';
  }

  return 'read';
}

// src/capture/anti-bot.ts

export type AntiBotSignal = 'cloudflare' | 'akamai' | 'rate-limited' | 'captcha' | 'challenge';

export interface AntiBotResult {
  detected: boolean;
  signals: AntiBotSignal[];
}

/**
 * Detect anti-bot protection signals from response headers and body.
 */
export function detectAntiBot(options: {
  headers: Record<string, string>;
  cookies?: string;
  body?: string;
  status?: number;
  contentType?: string;
}): AntiBotResult {
  const signals: AntiBotSignal[] = [];
  const { headers, cookies, body, status, contentType } = options;
  const headerLower = lowerKeys(headers);

  // Cloudflare: cf-ray header or __cf_bm cookie
  if (headerLower['cf-ray'] || headerLower['cf-cache-status'] || cookies?.includes('__cf_bm')) {
    signals.push('cloudflare');
  }

  // Akamai: _abck cookie
  if (cookies?.includes('_abck')) {
    signals.push('akamai');
  }

  // Rate limiting: X-RateLimit-* or Retry-After
  if (headerLower['retry-after'] ||
      Object.keys(headerLower).some(k => k.startsWith('x-ratelimit'))) {
    signals.push('rate-limited');
  }

  // CAPTCHA in response body
  if (body && /\b(captcha|hcaptcha|recaptcha|cf-turnstile)\b/i.test(body)) {
    signals.push('captcha');
  }

  // Challenge page: HTML response when JSON expected + 403
  if (status === 403 && contentType?.includes('text/html') &&
      !contentType.includes('json')) {
    signals.push('challenge');
  }

  return {
    detected: signals.length > 0,
    signals: [...new Set(signals)],
  };
}

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k.toLowerCase()] = v;
  }
  return result;
}

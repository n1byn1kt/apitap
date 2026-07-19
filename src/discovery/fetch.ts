// src/discovery/fetch.ts
import { validateUrl, resolveAndValidateUrl } from '../skill/ssrf.js';

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

export interface SafeFetchOptions {
  timeout?: number;
  method?: 'GET' | 'HEAD';
  maxBodySize?: number;
  skipSsrf?: boolean; // bypass SSRF check (for testing with local servers)
  /** Extra request headers, merged over the defaults (issue #63: lets
   *  decoders route trick-header requests through safeFetch). */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MAX_BODY = 512 * 1024; // 512KB
const USER_AGENT = 'ApiTap-Discovery/1.0';

/** Why a safeFetch attempt produced no result. */
export interface SafeFetchFailure {
  /** 'ssrf' = blocked by our own SSRF policy; 'transport' = client/network failure. */
  kind: 'ssrf' | 'transport';
  /** Error code when available (ECONNREFUSED, UND_ERR_HEADERS_OVERFLOW, TIMEOUT, …). */
  code: string;
  message: string;
}

export interface SafeFetchDetailedResult {
  result: FetchResult | null;
  /** Set exactly when result is null. */
  error: SafeFetchFailure | null;
}

/**
 * Fetch a URL with SSRF protection, timeout, and size limits.
 * Returns null on any failure (network error, SSRF blocked, timeout).
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<FetchResult | null> {
  return (await safeFetchDetailed(url, options)).result;
}

/**
 * Like safeFetch, but preserves WHY a fetch failed so callers (peek) can
 * distinguish "the site blocked us" from "our client choked" (e.g. undici
 * headers overflow on huge CSP headers, where curl gets a 200).
 */
export async function safeFetchDetailed(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchDetailedResult> {
  // M18: Use DNS-resolving SSRF check to prevent rebinding attacks
  if (!options.skipSsrf) {
    const ssrfResult = await resolveAndValidateUrl(url);
    if (!ssrfResult.safe) {
      return { result: null, error: { kind: 'ssrf', code: 'SSRF_BLOCKED', message: ssrfResult.reason ?? 'blocked by SSRF policy' } };
    }
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const method = options.method ?? 'GET';
  const maxBody = options.maxBodySize ?? DEFAULT_MAX_BODY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/json,*/*',
        ...options.headers,
      },
      redirect: 'manual',
    });

    // SSRF-safe manual redirect (one hop max, with DNS resolution check)
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      const location = response.headers.get('location');
      if (!location) {
        return { result: null, error: { kind: 'transport', code: 'BAD_REDIRECT', message: 'redirect without location header' } };
      }
      const redirectUrl = new URL(location, url).toString();
      const ssrfResult = await resolveAndValidateUrl(redirectUrl);
      if (!ssrfResult.safe) {
        return { result: null, error: { kind: 'ssrf', code: 'SSRF_BLOCKED', message: ssrfResult.reason ?? 'redirect blocked by SSRF policy' } };
      }
      // Follow one redirect hop only
      return await safeFetchDetailed(redirectUrl, { ...options, skipSsrf: true });
    }

    // Extract headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const contentType = headers['content-type'] || '';

    // For HEAD requests, don't read body
    if (method === 'HEAD') {
      return { result: { status: response.status, headers, body: '', contentType }, error: null };
    }

    // Read body with size limit
    const body = await readBodyLimited(response, maxBody);

    return { result: { status: response.status, headers, body, contentType }, error: null };
  } catch (err) {
    return { result: null, error: describeFetchError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err: unknown): SafeFetchFailure {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { kind: 'transport', code: 'TIMEOUT', message: 'request timed out' };
    }
    // fetch wraps the real failure in TypeError('fetch failed') with .cause
    const cause = (err as { cause?: unknown }).cause;
    const code = extractErrorCode(cause) ?? extractErrorCode(err);
    const message = cause instanceof Error && cause.message ? cause.message : err.message;
    return { kind: 'transport', code: code ?? err.name, message };
  }
  return { kind: 'transport', code: 'UNKNOWN', message: String(err) };
}

function extractErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code) return code;
  // AggregateError (e.g. dual-stack connect failures): first coded sub-error
  const errors = (err as { errors?: unknown[] }).errors;
  if (Array.isArray(errors)) {
    for (const sub of errors) {
      const subCode = extractErrorCode(sub);
      if (subCode) return subCode;
    }
  }
  return null;
}

async function readBodyLimited(response: Response, maxSize: number): Promise<string> {
  // Use text() with a size check — for discovery we don't need huge bodies
  const text = await response.text();
  if (text.length > maxSize) {
    return text.slice(0, maxSize);
  }
  return text;
}

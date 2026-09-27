// src/discovery/fetch.ts
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  SsrfBlockedError,
  MAX_HEADER_SIZE,
  assertFetchTarget,
  decodeStream,
  validatingLookup,
} from '../net/transport.js';

export { validatingLookup };

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
  /** Error code when available (ECONNREFUSED, HPE_HEADER_OVERFLOW, TIMEOUT, TOO_MANY_REDIRECTS, …). */
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

/** Redirect hops followed before giving up (the initial request is not a hop). */
export const MAX_REDIRECTS = 5;

/**
 * Like safeFetch, but preserves WHY a fetch failed so callers (peek) can
 * distinguish "the site blocked us" from "our client choked" (e.g. headers
 * overflow on huge CSP headers, where curl gets a 200).
 *
 * Transport is node:http(s), not fetch: fetch re-resolves the hostname after
 * our check, which reopens DNS rebinding. Here validation happens inside the
 * connection's own lookup. IP-literal hosts never hit lookup, so they are
 * range-checked up front by validateUrl on every hop.
 */
export async function safeFetchDetailed(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchDetailedResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const signal = AbortSignal.timeout(timeout);
  let current = url;

  for (let hop = 0; ; hop++) {
    const blocked = checkTarget(current, options.skipSsrf);
    if (blocked) return { result: null, error: blocked };

    let response: RawResponse;
    try {
      response = await request(current, options, signal);
    } catch (err) {
      return { result: null, error: describeFetchError(err) };
    }

    const location = response.headers['location'];
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      if (!location) {
        return { result: null, error: { kind: 'transport', code: 'BAD_REDIRECT', message: 'redirect without location header' } };
      }
      if (hop >= MAX_REDIRECTS) {
        return { result: null, error: { kind: 'transport', code: 'TOO_MANY_REDIRECTS', message: `more than ${MAX_REDIRECTS} redirects` } };
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return { result: null, error: { kind: 'transport', code: 'BAD_REDIRECT', message: `invalid redirect location: ${location}` } };
      }
      continue;
    }

    return {
      result: { ...response, contentType: response.headers['content-type'] || '' },
      error: null,
    };
  }
}

/** Per-hop target check. The scheme check holds even under skipSsrf. */
function checkTarget(url: string, skipSsrf?: boolean): SafeFetchFailure | null {
  try {
    assertFetchTarget(url, skipSsrf);
    return null;
  } catch (err) {
    return { kind: 'ssrf', code: 'SSRF_BLOCKED', message: (err as Error).message };
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function request(url: string, options: SafeFetchOptions, signal: AbortSignal): Promise<RawResponse> {
  const target = new URL(url);
  const method = options.method ?? 'GET';
  const maxBody = options.maxBodySize ?? DEFAULT_MAX_BODY;
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(target, {
      method,
      signal,
      // No pooling: a reused socket would skip the validating lookup.
      agent: false,
      lookup: options.skipSsrf ? undefined : validatingLookup,
      maxHeaderSize: MAX_HEADER_SIZE,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/json,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        ...options.headers,
      },
    }, (res) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      const status = res.statusCode ?? 0;

      // Redirects and HEAD carry no body we use. Settle on headers and drop
      // the socket, so a slow or huge discard-body can't eat the deadline.
      if (method === 'HEAD' || (status >= 300 && status < 400 && headers['location'] !== undefined)) {
        resolve({ status, headers, body: '' });
        req.destroy();
        return;
      }

      readBody(res, headers['content-encoding'], maxBody).then(
        (buf) => {
          req.destroy();
          // stream: true holds back a multibyte character cut by the cap
          // instead of emitting U+FFFD for it.
          resolve({ status, headers, body: new TextDecoder().decode(buf, { stream: true }) });
        },
        reject,
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Collect up to maxBytes of the (decompressed) body, then stop reading. The
 * cap applies after decompression, so a small gzip bomb can't inflate past it.
 */
function readBody(res: IncomingMessage, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const stream = decodeStream(res, encoding);

    const settle = (err?: Error) => {
      if (done) return;
      done = true;
      stream.destroy();
      res.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks, size));
    };

    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      const room = maxBytes - size;
      const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(take);
      size += take.length;
      if (size >= maxBytes) settle();
    });
    stream.on('end', () => settle());
    stream.on('error', settle);
  });
}

function describeFetchError(err: unknown): SafeFetchFailure {
  if (err instanceof SsrfBlockedError) {
    return { kind: 'ssrf', code: 'SSRF_BLOCKED', message: err.message };
  }
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

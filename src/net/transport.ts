// src/net/transport.ts
//
// HTTP transport that enforces SSRF policy on the address the socket actually
// connects to. Global fetch() re-resolves the hostname after any pre-check we
// run, which leaves a DNS-rebinding window (public on check, internal on
// connect). Here the range check lives inside the connection's own lookup.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { PassThrough, Readable, type Transform } from 'node:stream';
import { createGunzip, createInflate, createInflateRaw, createBrotliDecompress } from 'node:zlib';
import { validateUrl, isPrivateIp } from '../skill/ssrf.js';

/** Node's default is 16KB; CSP-heavy sites (Polymarket) exceed it while curl gets a 200. */
export const MAX_HEADER_SIZE = 64 * 1024;

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * dns.lookup drop-in for http.request's `lookup` option. It runs at connect
 * time — the same resolution the socket uses — so a TTL-0 rebind between a
 * pre-check and the connection can't slip a private address through. Every
 * address in the answer must be public; one private entry fails the lookup
 * rather than being filtered, since the client may pick any of them.
 */
export function validatingLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, options.all ? [] : '');
    for (const { address } of addresses) {
      const reason = isPrivateIp(address);
      if (reason) {
        return callback(
          new SsrfBlockedError(`${hostname} resolves to ${address} (${reason})`),
          options.all ? [] : '',
        );
      }
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }), '');
    callback(null, first.address, first.family);
  });
}

/**
 * Throw SsrfBlockedError unless the URL is http(s) and, when not skipped,
 * passes validateUrl. IP-literal hosts never reach the lookup, so this is
 * their only range check — run it before every request, redirects included.
 */
export function assertFetchTarget(url: string, skipSsrf?: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`Non-HTTP scheme: ${parsed.protocol}`);
  }
  if (!skipSsrf) {
    const result = validateUrl(url);
    if (!result.safe) throw new SsrfBlockedError(result.reason ?? 'blocked by SSRF policy');
  }
  return parsed;
}

export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Test/operator override: skip range checks (scheme check still runs). */
  skipSsrf?: boolean;
}

/** Request headers undici's fetch adds when absent; kept so replays look the same on the wire. */
const FETCH_DEFAULT_HEADERS: Record<string, string> = {
  'accept': '*/*',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
  'accept-encoding': 'gzip, deflate, br',
};

/** Headers the connection computes itself; caller values are dropped. */
const CONNECTION_OWNED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'host']);

/** Statuses whose Response must have a null body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A fetch() subset over node:http(s) with the SSRF check at connect time.
 * Returns a standard Response with the body decoded. Never follows
 * redirects (callers re-check each hop) and never pools sockets, since a
 * reused connection would skip the validating lookup. Cancel the body of a
 * response you won't read (`response.body?.cancel()`) to free the socket.
 */
export async function pinnedFetch(url: string, init: PinnedFetchInit = {}): Promise<Response> {
  const target = assertFetchTarget(url, init.skipSsrf);
  const method = (init.method ?? 'GET').toUpperCase();

  const headers: Record<string, string> = {};
  const present = new Set<string>();
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    // Framing and routing are derived from the URL and body, never taken from
    // the caller: a captured content-length goes stale once a body template
    // expands (or on a bodyless redirect hop) and would stall the request.
    // fetch() did the same.
    if (CONNECTION_OWNED_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
    present.add(key.toLowerCase());
  }
  for (const [key, value] of Object.entries(FETCH_DEFAULT_HEADERS)) {
    if (!present.has(key)) headers[key] = value;
  }
  if (init.body !== undefined && !present.has('content-type')) {
    headers['content-type'] = 'text/plain;charset=UTF-8';
  }

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, {
      method,
      headers,
      signal: init.signal,
      agent: false,
      lookup: init.skipSsrf ? undefined : validatingLookup,
      maxHeaderSize: MAX_HEADER_SIZE,
    }, (res) => {
      try {
        resolve(toResponse(res, method));
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  }
  let body: ReadableStream | null = null;
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    res.destroy();
  } else {
    body = Readable.toWeb(decodeStream(res, headers.get('content-encoding') ?? undefined)) as ReadableStream;
  }
  return new Response(body, { status, statusText: res.statusMessage ?? '', headers });
}

/**
 * Undo Content-Encoding on a response stream. Codings are listed in the
 * order applied, so they're undone last-first. Unsupported codings error the
 * stream. Destroying the returned stream releases the source socket.
 */
export function decodeStream(src: Readable, encoding: string | undefined): Readable {
  const codings = (encoding ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c && c !== 'identity')
    .reverse();
  if (codings.length === 0) return src;

  const out = new PassThrough();
  let chain: Transform[] = [];
  let head: Transform | null = null;

  const fail = (err: Error) => {
    src.destroy();
    for (const d of chain) d.destroy();
    out.destroy(err);
  };
  out.on('close', () => {
    src.destroy();
    for (const d of chain) d.destroy();
  });

  src.on('error', fail);
  src.on('data', (chunk: Buffer) => {
    if (!head) {
      for (const [i, coding] of codings.entries()) {
        // Raw-vs-zlib deflate sniffing only works on bytes we can see.
        const d = createDecoder(coding, i === 0 ? chunk : null);
        if (!d) {
          return fail(Object.assign(new Error(`unsupported content-encoding: ${encoding}`), { code: 'UNSUPPORTED_ENCODING' }));
        }
        chain.push(d);
      }
      for (let i = 0; i < chain.length - 1; i++) chain[i].pipe(chain[i + 1]);
      for (const d of chain) d.on('error', fail);
      chain[chain.length - 1].pipe(out);
      head = chain[0];
    }
    if (!head.write(chunk)) {
      src.pause();
      head.once('drain', () => src.resume());
    }
  });
  src.on('end', () => {
    if (head) head.end();
    else out.end();
  });
  return out;
}

function createDecoder(coding: string, firstChunk: Buffer | null): Transform | null {
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'br':
      return createBrotliDecompress();
    case 'deflate':
      // "deflate" is meant to be zlib-wrapped, but some servers send raw
      // deflate. A zlib header has CM=8 in the low nibble of byte 0.
      return !firstChunk || (firstChunk[0] & 0x0f) === 8 ? createInflate() : createInflateRaw();
    default:
      return null;
  }
}

/** Redirect hops fetchFollowing follows before giving up (the initial request is not a hop). */
export const MAX_FOLLOW_REDIRECTS = 5;

/** Request headers that must not cross to another origin on a redirect. */
const CROSS_ORIGIN_STRIP = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Statuses fetch() follows; any other 3xx (300, 304, 305, …) is returned as-is. */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Body-describing headers fetch() drops when a redirect turns the request into a bodyless GET. */
const REQUEST_BODY_HEADERS = new Set(['content-type', 'content-encoding', 'content-language', 'content-location']);

/**
 * pinnedFetch with fetch()-style redirect following, where every hop goes
 * back through transport.fetch — so each target gets the scheme/literal check
 * and the connect-time lookup. Follows only 301/302/303/307/308; refuses a
 * Location carrying userinfo (as fetch() does); drops Authorization, Cookie
 * and Proxy-Authorization once a redirect leaves the original origin. 303
 * (non-HEAD) and 301/302 after POST switch to a bodyless GET.
 */
export async function fetchFollowing(
  url: string,
  init: PinnedFetchInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? MAX_FOLLOW_REDIRECTS;
  const origin = new URL(url).origin;
  let current = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = { ...(init.headers ?? {}) };
  const without = (drop: Set<string>) =>
    Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));

  for (let hop = 0; ; hop++) {
    const res = await transport.fetch(current, { ...init, method, body, headers });
    const location = res.headers.get('location');
    if (!FOLLOWED_REDIRECTS.has(res.status) || location === null) return res;
    await res.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) {
      throw Object.assign(new Error(`more than ${maxRedirects} redirects from ${url}`), { code: 'TOO_MANY_REDIRECTS' });
    }
    const next = new URL(location, current);
    if (next.username || next.password) {
      throw Object.assign(new Error(`redirect to a URL with credentials refused: ${next.host}`), { code: 'BAD_REDIRECT' });
    }
    if (next.origin !== origin) headers = without(CROSS_ORIGIN_STRIP);
    if ((res.status === 303 && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = without(REQUEST_BODY_HEADERS);
    }
    current = next.toString();
  }
}

/**
 * The fetch used by every outbound caller except safeFetch (replay, OAuth
 * refresh, verifier, spec importers).
 * A mutable slot so tests can substitute a stub — replacing globalThis.fetch
 * no longer reaches these paths.
 */
export const transport = {
  fetch: pinnedFetch as (url: string, init?: PinnedFetchInit) => Promise<Response>,
};

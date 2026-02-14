// src/discovery/fetch.ts
import { validateUrl } from '../skill/ssrf.js';

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
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MAX_BODY = 512 * 1024; // 512KB
const USER_AGENT = 'ApiTap-Discovery/1.0';

/**
 * Fetch a URL with SSRF protection, timeout, and size limits.
 * Returns null on any failure (network error, SSRF blocked, timeout).
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<FetchResult | null> {
  // SSRF check
  if (!options.skipSsrf) {
    const ssrfResult = validateUrl(url);
    if (!ssrfResult.safe) return null;
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const method = options.method ?? 'GET';
  const maxBody = options.maxBodySize ?? DEFAULT_MAX_BODY;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/json,*/*',
      },
      redirect: 'follow',
    });

    clearTimeout(timer);

    // Extract headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const contentType = headers['content-type'] || '';

    // For HEAD requests, don't read body
    if (method === 'HEAD') {
      return { status: response.status, headers, body: '', contentType };
    }

    // Read body with size limit
    const body = await readBodyLimited(response, maxBody);

    return { status: response.status, headers, body, contentType };
  } catch {
    return null;
  }
}

async function readBodyLimited(response: Response, maxSize: number): Promise<string> {
  // Use text() with a size check — for discovery we don't need huge bodies
  const text = await response.text();
  if (text.length > maxSize) {
    return text.slice(0, maxSize);
  }
  return text;
}

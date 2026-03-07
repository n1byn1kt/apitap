import { parameterizePath } from '../../src/capture/parameterize.js';
import { isSensitivePath } from './sensitive-paths.js';
import { isAllowedUrl } from './security.js';
import type { IndexEndpoint } from './types.js';

/** Observation result from a completed request */
export interface Observation {
  domain: string;
  endpoint: IndexEndpoint;
}

/** Input for processCompletedRequest — abstraction over webRequest details */
export interface CompletedRequestDetails {
  url: string;
  method: string;
  statusCode: number;
  responseContentType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

/** Content types that indicate API responses */
function isApiContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes('application/json') ||
    ct.includes('application/graphql') ||
    ct.includes('application/vnd.api+json');
}

/** Detect auth type from request headers (type only, never the value) */
function detectAuthType(headers: Record<string, string>): string | undefined {
  const auth = headers['authorization'] || headers['Authorization'];
  if (auth) {
    if (auth.startsWith('Bearer ')) return 'Bearer';
    if (auth.startsWith('Basic ')) return 'Basic';
    return 'Other';
  }
  if (headers['x-api-key'] || headers['X-Api-Key']) return 'API Key';
  if (headers['cookie'] || headers['Cookie']) return 'Cookie';
  return undefined;
}

/** Detect pagination type from response headers and query params */
function detectPagination(
  responseHeaders: Record<string, string>,
  queryParamNames: string[],
): string | undefined {
  // Check response headers first
  const link = responseHeaders['link'] || responseHeaders['Link'];
  if (link && /rel="next"/.test(link)) {
    if (/cursor/i.test(link)) return 'cursor';
    if (/page/i.test(link)) return 'page';
    return 'cursor'; // Link with rel=next defaults to cursor
  }

  if (responseHeaders['x-next-cursor'] || responseHeaders['X-Next-Cursor']) return 'cursor';
  if (responseHeaders['x-has-more'] || responseHeaders['X-Has-More']) return 'cursor';
  if (responseHeaders['x-total-count'] || responseHeaders['X-Total-Count']) return 'offset';

  // Check query params
  if (queryParamNames.includes('cursor') || queryParamNames.includes('after') || queryParamNames.includes('before')) return 'cursor';
  if (queryParamNames.includes('offset')) return 'offset';
  if (queryParamNames.includes('page')) return 'page';

  return undefined;
}

/**
 * Process a completed HTTP request into an index observation.
 * Pure function — no chrome.* dependencies, fully testable.
 * Returns null if the request should not be indexed.
 */
export function processCompletedRequest(details: CompletedRequestDetails): Observation | null {
  const { url, method, statusCode, responseContentType, requestHeaders, responseHeaders } = details;

  // Block non-http(s), private IPs, dev tooling
  if (!isAllowedUrl(url)) return null;

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Block sensitive auth/login paths
  if (isSensitivePath(parsed.pathname)) return null;

  // Only index JSON/GraphQL API responses
  if (!isApiContentType(responseContentType)) return null;

  // Skip informational responses
  if (statusCode < 200 && statusCode !== 0) return null;

  const domain = parsed.hostname;
  const parameterizedPath = parameterizePath(parsed.pathname);
  const queryParamNames = [...parsed.searchParams.keys()].sort();

  // Detect content presence
  const contentLength = responseHeaders['content-length'] || responseHeaders['Content-Length'];
  const hasBody = contentLength ? parseInt(contentLength, 10) > 0 : true; // assume body if no header

  // Detect GraphQL
  const isGraphQL = parsed.pathname.endsWith('/graphql') || parsed.pathname.endsWith('/gql');
  const type = isGraphQL ? 'graphql' as const : undefined;

  const authType = detectAuthType(requestHeaders);
  const pagination = detectPagination(responseHeaders, queryParamNames);

  const now = new Date().toISOString();

  const endpoint: IndexEndpoint = {
    path: parameterizedPath,
    methods: [method],
    hasBody,
    hits: 1,
    lastSeen: now,
    ...(authType && { authType }),
    ...(pagination && { pagination }),
    ...(type && { type }),
    ...(queryParamNames.length > 0 && { queryParamNames }),
  };

  return { domain, endpoint };
}

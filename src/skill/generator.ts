// src/skill/generator.ts
import type { CapturedExchange, SkillEndpoint, SkillFile, StoredAuth, RequestBody, OAuthConfig } from '../types.js';
import { scrubPII } from '../capture/scrubber.js';
import { parameterizePath, cleanFrameworkPath } from '../capture/parameterize.js';
import { detectPagination } from '../capture/pagination.js';
import { detectBodyVariables } from '../capture/body-variables.js';
import { isGraphQLEndpoint, parseGraphQLBody, extractOperationName, detectGraphQLVariables } from '../capture/graphql.js';
import { detectRefreshableTokens } from '../capture/token-detector.js';
import { isLikelyToken } from '../capture/entropy.js';
import { isOAuthTokenRequest, type OAuthInfo } from '../capture/oauth-detector.js';
import { diffBodies } from '../capture/body-diff.js';
import { snapshotSchema } from '../contract/schema.js';

/** Headers to strip (connection control, forwarding, browser-internal, encoding) */
const STRIP_HEADERS = new Set([
  // Connection control
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  // Proxy/forwarding
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'via',
  'proxy-authorization',
  'proxy-connection',
  // Browser-internal (Sec-* headers)
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-full-version-list',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  // Encoding (handled automatically by fetch)
  'accept-encoding',
  // Cookie (stored separately via AuthManager)
  'cookie',
]);

/** Headers that should never be treated as auth by entropy detection. */
const NOT_AUTH_HEADERS = new Set([
  'referer', 'user-agent', 'content-type', 'accept', 'accept-language',
  'origin', 'host', 'content-length', 'cache-control', 'pragma', 'if-none-match',
  'if-modified-since', 'dnt', 'upgrade-insecure-requests',
  // Observability/tracing (high entropy but not auth)
  'traceparent', 'tracestate', 'tracecontext', 'newrelic', 'sentry-trace',
  'baggage', 'x-request-id', 'x-correlation-id', 'x-trace-id', 'x-span-id',
  'x-datadog-trace-id', 'x-datadog-parent-id', 'x-datadog-sampling-priority',
  'x-amzn-trace-id', 'x-cloud-trace-context',
]);

const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-guest-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
]);

export interface GeneratorOptions {
  enablePreview?: boolean;
  scrub?: boolean;
}

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!STRIP_HEADERS.has(lower) && !lower.startsWith('sec-')) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function stripAuth(headers: Record<string, string>, entropyDetected?: Set<string>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (AUTH_HEADERS.has(lower) || entropyDetected?.has(lower)) {
      stripped[key] = '[stored]';
    } else {
      stripped[key] = value;
    }
  }
  return stripped;
}

/**
 * Extract auth credentials from headers.
 * Uses name-based matching for known auth headers, plus entropy-based
 * detection for non-standard headers carrying high-entropy tokens.
 *
 * @returns [auth list, set of entropy-detected header names (lowercased)]
 */
function extractAuth(headers: Record<string, string>): [StoredAuth[], Set<string>] {
  const auth: StoredAuth[] = [];
  const entropyDetected = new Set<string>();

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' && value) {
      auth.push({
        type: value.toLowerCase().startsWith('bearer') ? 'bearer' : 'custom',
        header: lower,
        value,
      });
    } else if (lower === 'x-api-key' && value) {
      auth.push({ type: 'api-key', header: lower, value });
    } else if (!AUTH_HEADERS.has(lower) && !STRIP_HEADERS.has(lower) && !NOT_AUTH_HEADERS.has(lower)
      && !lower.startsWith('sec-') && value) {
      // Entropy-based detection for non-standard headers
      const classification = isLikelyToken(lower, value);
      if (classification.isToken) {
        auth.push({ type: 'custom', header: lower, value });
        entropyDetected.add(lower);
      }
    }
  }
  return [auth, entropyDetected];
}

/**
 * Deduplicate extracted auth entries by header name and build a StoredAuth
 * object with all unique headers. Entries are expected to be pre-sorted
 * by priority (bearer > api-key > custom) via getExtractedAuth().
 */
export function deduplicateAuth(extractedAuth: StoredAuth[]): StoredAuth | null {
  if (extractedAuth.length === 0) return null;
  const seen = new Set<string>();
  const headers: Array<{ header: string; value: string }> = [];
  for (const a of extractedAuth) {
    if (!seen.has(a.header)) {
      seen.add(a.header);
      headers.push({ header: a.header, value: a.value });
    }
  }
  const primary = extractedAuth[0];
  return { type: primary.type, header: primary.header, value: primary.value, headers };
}

function generateEndpointId(method: string, parameterizedPath: string): string {
  // Clean framework noise for the ID (but not for the stored path)
  let cleaned = cleanFrameworkPath(parameterizedPath);

  // Split into segments, remove :param placeholders (they add no info to the ID)
  const segments = cleaned.split('/').filter(s => s !== '' && !s.startsWith(':'));

  const slug = segments.join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'root';
  return `${method.toLowerCase()}-${slug}`;
}

function detectResponseShape(body: string): { type: string; fields?: string[] } {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      return {
        type: 'array',
        fields: first && typeof first === 'object' && first !== null
          ? Object.keys(first)
          : undefined,
      };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return { type: 'object', fields: Object.keys(parsed) };
    }
    return { type: typeof parsed };
  } catch {
    return { type: 'unknown' };
  }
}

function truncatePreview(body: string, maxItems = 2): unknown {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed.slice(0, maxItems);
    }
    return parsed;
  } catch {
    return body.slice(0, 500);
  }
}

function extractQueryParams(url: URL): Record<string, { type: string; example: string }> {
  const params: Record<string, { type: string; example: string }> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = { type: 'string', example: value };
  }
  return params;
}

/** Query param names that carry API keys or tokens */
const SENSITIVE_QUERY_KEYS = /api.?key|token|secret|credential|key|access.?key/i;

function scrubQueryParams(
  params: Record<string, { type: string; example: string }>,
): Record<string, { type: string; example: string }> {
  const scrubbed: Record<string, { type: string; example: string }> = {};
  for (const [key, val] of Object.entries(params)) {
    // Scrub known sensitive query param names
    if (SENSITIVE_QUERY_KEYS.test(key)) {
      scrubbed[key] = { type: val.type, example: '[scrubbed]' };
    } else {
      // Also apply entropy-based detection for unknown high-entropy values
      const classification = isLikelyToken(key, val.example);
      if (classification.isToken) {
        scrubbed[key] = { type: val.type, example: '[scrubbed]' };
      } else {
        scrubbed[key] = { type: val.type, example: scrubPII(val.example) };
      }
    }
  }
  return scrubbed;
}

/** Scrub sensitive query params from a full URL string */
function scrubUrlQueryParams(urlString: string): string {
  try {
    const url = new URL(urlString);
    let changed = false;
    for (const [key, value] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_KEYS.test(key)) {
        url.searchParams.set(key, '[scrubbed]');
        changed = true;
      } else {
        const classification = isLikelyToken(key, value);
        if (classification.isToken) {
          url.searchParams.set(key, '[scrubbed]');
          changed = true;
        }
      }
    }
    return changed ? url.toString() : urlString;
  } catch {
    return urlString;
  }
}

/** Body field names that must always be scrubbed (credentials in POST bodies) */
const SENSITIVE_BODY_KEYS = /^(password|passwd|pass|secret|client_secret|refresh_token|access_token|api_key|apikey|token|csrf_token|_csrf|xsrf_token|private_key|credential)$/i;

function scrubBody(body: unknown, doScrub: boolean): unknown {
  if (!doScrub) return body;
  if (typeof body === 'string') {
    return scrubPII(body);
  }
  if (Array.isArray(body)) {
    return body.map(item => scrubBody(item, doScrub));
  }
  if (body && typeof body === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (SENSITIVE_BODY_KEYS.test(key) && typeof value === 'string') {
        scrubbed[key] = '[scrubbed]';
      } else if (typeof value === 'string') {
        scrubbed[key] = scrubPII(value);
      } else if (value && typeof value === 'object') {
        scrubbed[key] = scrubBody(value, doScrub);
      } else {
        scrubbed[key] = value;
      }
    }
    return scrubbed;
  }
  return body;
}

export class SkillGenerator {
  private endpoints = new Map<string, SkillEndpoint>();
  private exchangeBodies = new Map<string, string[]>(); // v1.0: store bodies for cross-request diffing
  private captureCount = 0;
  private filteredCount = 0;
  private baseUrl: string | null = null;
  private extractedAuthList: StoredAuth[] = [];
  private options: Required<GeneratorOptions>;
  private captchaRisk = false;
  private oauthConfig: OAuthConfig | null = null;
  private oauthClientSecret: string | undefined;
  private oauthRefreshToken: string | undefined;
  private totalNetworkBytes = 0; // v1.0: accumulate all response sizes
  private _lastDedupKey: string | null = null; // side-channel for dedup key when _prepareEndpoint returns null

  /** Number of unique endpoints captured so far */
  get endpointCount(): number {
    return this.endpoints.size;
  }

  constructor(options: GeneratorOptions = {}) {
    this.options = {
      enablePreview: options.enablePreview ?? false,
      scrub: options.scrub ?? true,
    };
  }

  /**
   * Extract shared request-side logic: URL parsing, GraphQL detection, path
   * parameterization, dedup, OAuth, auth extraction, header/query scrubbing,
   * and endpoint ID generation.
   *
   * Returns null when the endpoint is a duplicate (existing non-skeleton).
   * When returning null, stores the dedup key in `_lastDedupKey` so callers
   * can still perform body storage for cross-request diffing.
   */
  private _prepareEndpoint(request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  }): {
    key: string;
    method: string;
    paramPath: string;
    queryParams: Record<string, { type: string; example: string }>;
    safeHeaders: Record<string, string>;
    exampleUrl: string;
    endpointId: string;
    graphqlInfo: { operationName: string; query: string; variables: Record<string, unknown> | null } | null;
    entropyDetected: Set<string>;
    isSkeletonReplacement: boolean;
  } | null {
    this.captureCount++;

    const url = new URL(request.url);
    const method = request.method;
    const contentType = request.headers['content-type'] ?? '';

    // Track baseUrl from the first captured exchange
    if (!this.baseUrl) {
      this.baseUrl = url.origin;
    }

    // Check for GraphQL
    const isGraphQL = isGraphQLEndpoint(url.pathname, contentType, request.postData ?? null);
    let graphqlInfo: { operationName: string; query: string; variables: Record<string, unknown> | null } | null = null;

    if (isGraphQL && request.postData) {
      const parsed = parseGraphQLBody(request.postData);
      if (parsed) {
        const opName = extractOperationName(parsed.query, parsed.operationName);
        graphqlInfo = {
          operationName: opName,
          query: parsed.query,
          variables: parsed.variables,
        };
      }
    }

    // Parameterize path for dedup and storage
    const paramPath = parameterizePath(url.pathname);
    // Use framework-cleaned path for dedup key so _next/data routes with different build hashes collapse
    const dedupPath = cleanFrameworkPath(paramPath);

    // For GraphQL, dedup by operation name instead of path
    const key = graphqlInfo
      ? `${method} graphql:${graphqlInfo.operationName}`
      : `${method} ${dedupPath}`;

    if (this.endpoints.has(key)) {
      const existing = this.endpoints.get(key)!;
      if (existing.endpointProvenance === 'skeleton') {
        // Skeleton endpoint — fall through to replace it with captured data
      } else {
        // Non-skeleton duplicate — store key for body diffing, return null
        this._lastDedupKey = key;
        return null;
      }
    }

    const isSkeletonReplacement = this.endpoints.has(key)
      && this.endpoints.get(key)!.endpointProvenance === 'skeleton';

    // Detect OAuth token requests from captured traffic
    const oauthInfo = isOAuthTokenRequest(request);
    if (oauthInfo && !this.oauthConfig) {
      this.oauthConfig = {
        tokenEndpoint: oauthInfo.tokenEndpoint,
        clientId: oauthInfo.clientId,
        grantType: oauthInfo.grantType,
        ...(oauthInfo.scope ? { scope: oauthInfo.scope } : {}),
      };
      this.oauthClientSecret = oauthInfo.clientSecret;
      this.oauthRefreshToken = oauthInfo.refreshToken;
    }

    // Extract auth before filtering headers (includes entropy-based detection)
    const [auth, entropyDetected] = extractAuth(request.headers);
    this.extractedAuthList.push(...auth);

    // Filter headers, then strip auth values (including entropy-detected tokens)
    const filtered = filterHeaders(request.headers);
    const safeHeaders = stripAuth(filtered, entropyDetected);

    // Build query params, optionally scrub PII
    let queryParams = extractQueryParams(url);
    if (this.options.scrub) {
      queryParams = scrubQueryParams(queryParams);
    }

    // Build example URL, optionally scrub PII and sensitive query params
    let exampleUrl = request.url;
    if (this.options.scrub) {
      exampleUrl = scrubUrlQueryParams(scrubPII(exampleUrl));
    }

    // Generate endpoint ID - use GraphQL operation name if applicable
    const endpointId = graphqlInfo
      ? `${method.toLowerCase()}-graphql-${graphqlInfo.operationName}`
      : generateEndpointId(method, paramPath);

    return {
      key,
      method,
      paramPath,
      queryParams,
      safeHeaders,
      exampleUrl,
      endpointId,
      graphqlInfo,
      entropyDetected,
      isSkeletonReplacement,
    };
  }

  /** Add a captured exchange. Returns the new endpoint if first seen, null if duplicate. */
  addExchange(exchange: CapturedExchange): SkillEndpoint | null {
    // Track response bytes for all exchanges (for browser cost measurement)
    this.totalNetworkBytes += exchange.response.body.length;

    const prep = this._prepareEndpoint(exchange.request);

    if (!prep) {
      // Dedup: store body for cross-request diffing (Strategy 1) — scrubbed (H3 fix)
      const dedupKey = this._lastDedupKey;
      if (dedupKey && exchange.request.postData) {
        const bodies = this.exchangeBodies.get(dedupKey);
        if (bodies) bodies.push(this.scrubBodyString(exchange.request.postData));
      }
      return null;
    }

    const { key, method, paramPath, queryParams, safeHeaders, exampleUrl,
            endpointId, graphqlInfo, entropyDetected } = prep;

    // Response preview: null by default, populated with --preview
    let responsePreview: unknown = null;
    if (this.options.enablePreview) {
      const preview = truncatePreview(exchange.response.body);
      responsePreview = this.options.scrub
        ? scrubBody(preview, true)
        : preview;
    }

    // Detect pagination patterns
    const pagination = detectPagination(queryParams) ?? undefined;

    // Process request body for POST/PUT/PATCH
    let requestBody: RequestBody | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method) && exchange.request.postData) {
      const bodyContentType = exchange.request.headers['content-type'] ?? 'application/octet-stream';
      const rawBody = exchange.request.postData;

      if (bodyContentType.includes('json')) {
        try {
          const parsed = JSON.parse(rawBody);
          const scrubbedTemplate = scrubBody(parsed, this.options.scrub) as Record<string, unknown>;

          // For GraphQL, detect variables in the variables object specifically
          let variables: string[];
          if (graphqlInfo && graphqlInfo.variables) {
            variables = detectGraphQLVariables(graphqlInfo.variables, 'variables');
          } else {
            variables = detectBodyVariables(parsed);
          }

          // Detect refreshable tokens (CSRF, nonces) for v0.8 auth refresh
          const refreshable = detectRefreshableTokens(parsed);

          requestBody = {
            contentType: 'application/json',
            template: scrubbedTemplate,
            ...(variables.length > 0 ? { variables } : {}),
            ...(refreshable.length > 0 ? { refreshableTokens: refreshable } : {}),
          };
        } catch {
          // Invalid JSON - store as string
          requestBody = {
            contentType: bodyContentType,
            template: this.options.scrub ? scrubPII(rawBody) : rawBody,
          };
        }
      } else {
        // Non-JSON body - store as string
        requestBody = {
          contentType: bodyContentType,
          template: this.options.scrub ? scrubPII(rawBody) : rawBody,
        };
      }
    }

    const endpoint: SkillEndpoint = {
      id: endpointId,
      method: exchange.request.method,
      path: paramPath,
      queryParams,
      headers: safeHeaders,
      responseShape: detectResponseShape(exchange.response.body),
      examples: {
        request: {
          url: exampleUrl,
          headers: stripAuth(filterHeaders(exchange.request.headers)),
        },
        responsePreview,
      },
      ...(pagination ? { pagination } : {}),
      ...(requestBody ? { requestBody } : {}),
    };

    // Also strip entropy-detected tokens from example headers
    if (entropyDetected.size > 0) {
      endpoint.examples.request.headers = stripAuth(
        filterHeaders(exchange.request.headers),
        entropyDetected
      );
    }

    // Store response bytes on endpoint
    endpoint.responseBytes = exchange.response.body.length;

    // Snapshot response schema for contract validation
    try {
      const parsed = JSON.parse(exchange.response.body);
      endpoint.responseSchema = snapshotSchema(parsed);
    } catch { /* non-JSON response, skip schema */ }

    this.endpoints.set(key, endpoint);

    // Store first body for cross-request diffing (scrub sensitive fields — H3 fix)
    if (exchange.request.postData) {
      this.exchangeBodies.set(key, [this.scrubBodyString(exchange.request.postData)]);
    }

    // Clear auth values from exchange to reduce credential exposure window (H3 fix)
    for (const key of Object.keys(exchange.request.headers)) {
      const lower = key.toLowerCase();
      if (AUTH_HEADERS.has(lower) || lower === 'cookie') {
        exchange.request.headers[key] = '[scrubbed]';
      }
    }

    return endpoint;
  }

  /** Add a skeleton endpoint (request data only, no response body). Confidence 0.8. */
  addSkeleton(request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  }): SkillEndpoint | null {
    const prep = this._prepareEndpoint(request);
    if (!prep) return null;

    const { key, paramPath, queryParams, safeHeaders, exampleUrl,
            endpointId, entropyDetected, isSkeletonReplacement } = prep;

    // If a skeleton already occupies this key, don't overwrite with another skeleton
    if (isSkeletonReplacement) return null;

    const endpoint: SkillEndpoint = {
      id: endpointId,
      method: request.method,
      path: paramPath,
      queryParams,
      headers: safeHeaders,
      responseShape: { type: 'unknown' },
      examples: {
        request: {
          url: exampleUrl,
          headers: stripAuth(filterHeaders(request.headers)),
        },
        responsePreview: null,
      },
      confidence: 0.8,
      endpointProvenance: 'skeleton',
      responseBytes: 0,
    };

    // Also strip entropy-detected tokens from example headers
    if (entropyDetected.size > 0) {
      endpoint.examples.request.headers = stripAuth(
        filterHeaders(request.headers), entropyDetected
      );
    }

    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  /** Record a filtered-out request (for metadata tracking). */
  recordFiltered(): void {
    this.filteredCount++;
  }

  /** Get auth credentials extracted during capture, prioritized by type. */
  getExtractedAuth(): StoredAuth[] {
    const priority: Record<string, number> = { bearer: 0, 'api-key': 1, custom: 2 };
    return [...this.extractedAuthList].sort(
      (a, b) => (priority[a.type] ?? 3) - (priority[b.type] ?? 3),
    );
  }

  /** Mark this domain as having captcha risk (detected during capture). */
  setCaptchaRisk(detected: boolean): void {
    this.captchaRisk = detected;
  }

  /** Get detected OAuth configuration (non-secret, for skill file). */
  getOAuthConfig(): OAuthConfig | null {
    return this.oauthConfig;
  }

  /** Get the client secret captured from OAuth traffic (for encrypted storage). */
  getOAuthClientSecret(): string | undefined {
    return this.oauthClientSecret;
  }

  /** Get the refresh token captured from OAuth traffic (for encrypted storage). */
  getOAuthRefreshToken(): string | undefined {
    return this.oauthRefreshToken;
  }

  /** Check if any endpoint has refreshable tokens. */
  private hasRefreshableTokens(): boolean {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.requestBody?.refreshableTokens?.length) {
        return true;
      }
    }
    return false;
  }

  /** Get total network bytes seen during capture (all responses, before filtering). */
  getTotalNetworkBytes(): number {
    return this.totalNetworkBytes;
  }

  /** Add network bytes from a response that was filtered out (not added as exchange). */
  addNetworkBytes(bytes: number): void {
    this.totalNetworkBytes += bytes;
  }

  /**
   * Scrub sensitive fields from a POST body string for intermediate storage (H3 fix).
   * Preserves structure for cross-request diffing while removing credentials.
   */
  private scrubBodyString(bodyStr: string): string {
    try {
      const parsed = JSON.parse(bodyStr);
      if (typeof parsed === 'object' && parsed !== null) {
        const scrubbed = scrubBody(parsed, true) as Record<string, unknown>;
        return JSON.stringify(scrubbed);
      }
    } catch {
      // Non-JSON body — apply PII scrubber
    }
    return scrubPII(bodyStr);
  }

  /** Generate the complete skill file for a domain. */
  toSkillFile(domain: string, options?: { domBytes?: number; totalRequests?: number }): SkillFile {
    // Apply cross-request diffing (Strategy 1) to endpoints with multiple bodies
    for (const [key, bodies] of this.exchangeBodies) {
      if (bodies.length < 2) continue;
      const endpoint = this.endpoints.get(key);
      if (!endpoint?.requestBody) continue;

      const diffedVars = diffBodies(bodies);
      if (diffedVars.length > 0) {
        const existing = new Set(endpoint.requestBody.variables ?? []);
        for (const v of diffedVars) existing.add(v);
        endpoint.requestBody.variables = [...existing];
      }
    }

    const skill: SkillFile = {
      version: '1.2',
      domain,
      capturedAt: new Date().toISOString(),
      baseUrl: this.baseUrl ?? `https://${domain}`,
      endpoints: Array.from(this.endpoints.values()),
      metadata: {
        captureCount: this.captureCount,
        filteredCount: this.filteredCount,
        toolVersion: '1.0.0',
        ...(options?.domBytes != null ? {
          browserCost: {
            domBytes: options.domBytes,
            totalNetworkBytes: this.totalNetworkBytes,
            totalRequests: options.totalRequests ?? this.captureCount + this.filteredCount,
          },
        } : {}),
      },
      provenance: 'unsigned' as const,
    };

    // Add auth config if captcha risk detected, refreshable tokens present, or OAuth detected
    if (this.captchaRisk || this.hasRefreshableTokens() || this.oauthConfig) {
      skill.auth = {
        browserMode: this.captchaRisk ? 'visible' : 'headless',
        captchaRisk: this.captchaRisk,
        ...(this.oauthConfig ? { oauthConfig: this.oauthConfig } : {}),
      };
    }

    // Clear intermediate body storage to reduce credential exposure window (H3 fix)
    this.exchangeBodies.clear();

    return skill;
  }
}

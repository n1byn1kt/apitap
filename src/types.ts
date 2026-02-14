// src/types.ts

/** A captured HTTP request/response pair from the browser */
export interface CapturedExchange {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;  // POST/PUT/PATCH body
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    contentType: string;
  };
  timestamp: string;
}

/** Stored auth credentials for a domain */
export interface StoredAuth {
  type: 'bearer' | 'api-key' | 'cookie' | 'custom';
  header: string;
  value: string;
  // v0.8: refreshable tokens (body-based, like CSRF)
  tokens?: Record<string, StoredToken>;
  // v0.8: cached browser session for faster refresh
  session?: StoredSession;
  // v0.9: OAuth credentials (stored encrypted, never in skill file)
  refreshToken?: string;
  clientSecret?: string;
}

/**
 * Extended auth storage for v0.8 token refresh.
 */

/** Stored token with refresh metadata */
export interface StoredToken {
  value: string;
  refreshedAt: string; // ISO timestamp
  expiresAt?: string; // computed from ttlHint
}

/** Cached browser session for warm restarts */
export interface StoredSession {
  cookies: PlaywrightCookie[];
  localStorage?: Record<string, string>;
  savedAt: string;
  maxAgeMs?: number; // when to consider session stale, default 24h
}

/** Playwright cookie shape (subset of full type) */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** OAuth configuration (non-secret, lives in shareable skill file) */
export interface OAuthConfig {
  tokenEndpoint: string;
  clientId: string;
  grantType: 'refresh_token' | 'client_credentials';
  scope?: string;
}

/** Top-level auth config on SkillFile */
export interface SkillAuth {
  refreshUrl?: string; // URL to navigate for refresh, defaults to baseUrl
  browserMode: 'headless' | 'visible';
  captchaRisk: boolean;
  ttlHint?: number; // estimated seconds until expiry
  oauthConfig?: OAuthConfig; // v0.9: OAuth token endpoint config
}

/** Replay difficulty classification for an endpoint */
export interface Replayability {
  tier: 'green' | 'yellow' | 'orange' | 'red' | 'unknown';
  verified: boolean;
  signals: string[];
}

/** Detected pagination pattern */
export interface PaginationInfo {
  type: 'offset' | 'cursor' | 'page';
  paramName: string;
  limitParam?: string;
}

/** Request body template for POST/PUT/PATCH endpoints */
export interface RequestBody {
  contentType: string;
  template: string | Record<string, unknown>;
  variables?: string[];  // JSON paths of substitutable fields (user-provided params)
  refreshableTokens?: string[];  // v0.8: system-refreshed tokens
}

/** A single API endpoint in a skill file */
export interface SkillEndpoint {
  id: string;
  method: string;
  path: string;
  queryParams: Record<string, { type: string; example: string }>;
  headers: Record<string, string>;
  responseShape: { type: string; fields?: string[] };
  examples: {
    request: { url: string; headers: Record<string, string> };
    responsePreview: unknown;
  };
  replayability?: Replayability;
  pagination?: PaginationInfo;
  requestBody?: RequestBody;
  responseBytes?: number; // v1.0: response body size in bytes
}

/** The full skill file written to disk */
export interface SkillFile {
  version: string;
  domain: string;
  capturedAt: string;
  baseUrl: string;
  endpoints: SkillEndpoint[];
  metadata: {
    captureCount: number;
    filteredCount: number;
    toolVersion: string;
    browserCost?: { // v1.0: measured browser cost during capture
      domBytes: number;           // page.content().length
      totalNetworkBytes: number;  // sum of ALL response body sizes
      totalRequests: number;
    };
  };
  provenance: 'self' | 'imported' | 'unsigned';
  signature?: string;
  auth?: SkillAuth; // v0.8: top-level auth config
}

/** Interactive element on a page, for agent targeting */
export interface PageElement {
  ref: string;          // "e0", "e1", etc. — agent uses this to target clicks/types
  tag: string;          // "button", "a", "input", "select"
  role?: string;        // ARIA role
  text: string;         // visible text (truncated 200 chars)
  name?: string;        // input name
  placeholder?: string; // input placeholder
  href?: string;        // link href
  type?: string;        // input type
  disabled?: boolean;
}

/** Structured page snapshot returned after every interaction */
export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  endpointsCaptured: number;
  totalRequests: number;
  filteredRequests: number;
  recentEndpoints: string[];  // last 5 discovered (e.g. "GET /api/search")
}

/** Result from a capture session interaction */
export interface InteractionResult {
  success: boolean;
  error?: string;
  snapshot: PageSnapshot;
}

/** Result from finishing a capture session */
export interface FinishResult {
  aborted: boolean;
  domains: {
    domain: string;
    endpointCount: number;
    tiers: Record<string, number>;
    skillFile: string;
  }[];
}

/** Summary returned by `apitap list` */
export interface SkillSummary {
  domain: string;
  skillFile: string;
  endpointCount: number;
  capturedAt: string;
  provenance: 'self' | 'imported' | 'unsigned';
}

// --- Discovery types (Milestone 2: Smart Discovery) ---

/** Detected web framework with predicted API patterns */
export interface DetectedFramework {
  name: string;
  confidence: 'high' | 'medium' | 'low';
  apiPatterns: string[];  // predicted API paths (e.g. "/wp-json/wp/v2/posts")
}

/** Discovered API spec */
export interface DiscoveredSpec {
  type: 'openapi' | 'swagger' | 'graphql-introspection';
  url: string;
  version?: string;
  endpointCount?: number;
}

/** Result from probing a common API path */
export interface ProbeResult {
  method: string;
  path: string;
  status: number;
  contentType: string;
  isApi: boolean;
}

/** Result from the discovery pipeline */
export interface DiscoveryResult {
  confidence: 'high' | 'medium' | 'low' | 'none';
  skillFile?: SkillFile;
  hints?: string[];
  frameworks?: DetectedFramework[];
  specs?: DiscoveredSpec[];
  probes?: ProbeResult[];
  duration: number; // ms
  authRequired?: boolean;     // true if site appears to need login
  authSignals?: string[];     // reasons auth was detected
  loginUrl?: string;          // detected login page URL
}

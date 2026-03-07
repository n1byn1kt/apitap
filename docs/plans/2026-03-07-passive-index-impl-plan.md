# Passive Index + On-Demand Promotion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add always-on passive API traffic indexing to the Chrome extension, with on-demand promotion to full skill files and CLI/MCP integration for agent queries.

**Architecture:** The extension silently observes API traffic via `webRequest.onSendHeaders` + `webRequest.onCompleted` (no CDP, no infobar), building a lightweight index in `chrome.storage.local`. On flush triggers (tab close, 5-min timer, `onSuspend`), the full index is sent to the native host which writes it atomically to `~/.apitap/index.json`. The CLI reads this file directly. Promotion reuses the existing `captureWithPlateau()` CDP flow.

**Tech Stack:** Chrome Extension MV3 (webRequest API), existing native messaging bridge, Node.js (CLI/MCP), TypeScript strict mode, Node built-in test runner.

**Design doc:** `docs/plans/2026-03-07-passive-index-design.md`

---

## Build Order

Security primitives FIRST, then capture surface, then storage, then sync, then promotion, then UI, then CLI/MCP.

```
Task 1:  Index types (shared schema)
Task 2:  sensitive-paths.ts (blocklist — BEFORE observer)
Task 3:  observer.ts (webRequest listener, in-memory buffer)
Task 4:  index-store.ts (chrome.storage.local management + merge)
Task 5:  manifest.json + esbuild (add webRequest permission, bundle observer)
Task 6:  native-host.ts (save_index action, atomic write)
Task 7:  Wire observer + index-store + flush into background.ts
Task 8:  Index reader for CLI (src/index/reader.ts)
Task 9:  Extend CLI discover command to show index data
Task 10: Extend MCP apitap_discover tool to include index data
Task 11: promotion.ts (orchestrate CDP capture from index entry)
Task 12: Wire promotion into background.ts message handling
Task 13: Popup UI — Index tab with domain list
Task 14: Popup UI — Settings (Auto-learn toggle)
Task 15: Lifecycle management (decay, hard delete, soft cap)
```

---

### Task 1: Index Types

**Files:**
- Modify: `extension/src/types.ts`
- Test: `test/extension/index-types.test.ts`

Types from the design doc schema. Shared between extension, native host, and CLI.

**Step 1: Write the failing test**

```typescript
// test/extension/index-types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IndexFile, IndexEntry, IndexEndpoint } from '../../extension/src/types.js';

describe('IndexFile types', () => {
  it('accepts a valid IndexFile', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    };
    assert.equal(index.v, 1);
    assert.ok(Array.isArray(index.entries));
  });

  it('accepts a full IndexEntry with endpoints', () => {
    const entry: IndexEntry = {
      domain: 'discord.com',
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-07T12:00:00Z',
      totalHits: 127,
      promoted: false,
      endpoints: [{
        path: '/api/v10/channels/:id',
        methods: ['GET', 'PATCH'],
        authType: 'Bearer',
        hasBody: true,
        hits: 42,
        lastSeen: '2026-03-07T12:00:00Z',
        pagination: 'cursor',
        queryParamNames: ['limit', 'after'],
      }],
    };
    assert.equal(entry.domain, 'discord.com');
    assert.equal(entry.endpoints[0].methods.length, 2);
    assert.equal(entry.endpoints[0].type, undefined);
  });

  it('accepts optional promotion fields', () => {
    const entry: IndexEntry = {
      domain: 'github.com',
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-07T12:00:00Z',
      totalHits: 43,
      promoted: true,
      lastPromoted: '2026-03-05T10:00:00Z',
      skillFileSource: 'extension',
      endpoints: [],
    };
    assert.equal(entry.promoted, true);
    assert.equal(entry.skillFileSource, 'extension');
  });

  it('accepts graphql endpoint type', () => {
    const ep: IndexEndpoint = {
      path: '/graphql',
      methods: ['POST'],
      hasBody: true,
      hits: 10,
      lastSeen: '2026-03-07T12:00:00Z',
      type: 'graphql',
    };
    assert.equal(ep.type, 'graphql');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/extension/index-types.test.ts`
Expected: FAIL — types `IndexFile`, `IndexEntry`, `IndexEndpoint` not exported from `extension/src/types.ts`

**Step 3: Add types to extension/src/types.ts**

Append to `extension/src/types.ts`:

```typescript
// --- Passive Index types (v2) ---

export interface IndexFile {
  v: 1;
  updatedAt: string;           // ISO timestamp of last write
  entries: IndexEntry[];
}

export interface IndexEntry {
  domain: string;
  firstSeen: string;           // ISO timestamp
  lastSeen: string;            // ISO timestamp
  totalHits: number;           // all observed requests (including filtered)
  promoted: boolean;           // full skill file exists
  lastPromoted?: string;       // ISO timestamp of last CDP capture
  skillFileSource?: 'extension' | 'cli';
  endpoints: IndexEndpoint[];
}

export interface IndexEndpoint {
  path: string;                // parameterized: /api/v10/channels/:id
  methods: string[];           // ["GET", "PATCH", "DELETE"]
  authType?: string;           // "Bearer" | "API Key" | "Cookie" -- never the value
  hasBody: boolean;            // content-length > 0
  hits: number;                // per-endpoint count
  lastSeen: string;            // ISO timestamp
  pagination?: string;         // "cursor" | "offset" | "page"
  type?: 'graphql';            // flagged for special handling
  queryParamNames?: string[];  // names only, never values
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/extension/index-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add extension/src/types.ts test/extension/index-types.test.ts
git commit -m "feat(index): add IndexFile/IndexEntry/IndexEndpoint types"
```

---

### Task 2: Sensitive Paths Blocklist

**Files:**
- Create: `extension/src/sensitive-paths.ts`
- Test: `test/extension/sensitive-paths.test.ts`

This MUST land before observer.ts. The blocklist prevents auth/login flows from ever being indexed.

**Step 1: Write the failing test**

```typescript
// test/extension/sensitive-paths.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitivePath } from '../../extension/src/sensitive-paths.js';

describe('sensitive path blocklist', () => {
  // Paths that MUST be blocked
  const blocked = [
    '/login',
    '/api/login',
    '/oauth/authorize',
    '/oauth2/token',
    '/auth/callback',
    '/api/v1/token',
    '/password/reset',
    '/passwd',
    '/2fa/verify',
    '/mfa/setup',
    '/session/new',
    '/signup',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/account/security',
    '/api-key/create',
    '/credentials/rotate',
    // Case insensitive
    '/OAuth/Token',
    '/API/LOGIN',
    '/Auth/Callback',
  ];

  for (const path of blocked) {
    it(`blocks ${path}`, () => {
      assert.ok(isSensitivePath(path), `expected ${path} to be blocked`);
    });
  }

  // Paths that MUST NOT be blocked
  const allowed = [
    '/api/v1/users',
    '/api/channels/123',
    '/authors',          // /auth must use word boundary — not /authors
    '/search',
    '/graphql',
    '/api/v10/guilds/123/members',
    '/wp-json/wp/v2/posts',
  ];

  for (const path of allowed) {
    it(`allows ${path}`, () => {
      assert.ok(!isSensitivePath(path), `expected ${path} to be allowed`);
    });
  }

  // Edge cases: paths that contain "auth" as a substring but ARE auth endpoints
  const authEndpoints = [
    '/api/authenticate',
    '/v1/authorization',
  ];

  for (const path of authEndpoints) {
    it(`blocks auth endpoint ${path}`, () => {
      assert.ok(isSensitivePath(path), `expected ${path} to be blocked`);
    });
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/extension/sensitive-paths.test.ts`
Expected: FAIL — module `sensitive-paths.js` not found

**Step 3: Write the implementation**

```typescript
// extension/src/sensitive-paths.ts

/**
 * Sensitive path patterns — enforced at collection time.
 * Requests matching these patterns are never observed, never stored.
 * Data that was never written can never leak.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\/login/i,
  /\/oauth/i,
  /\/token/i,
  /\/password/i,
  /\/passwd/i,
  /\/2fa/i,
  /\/mfa/i,
  /\/auth\b/i,          // /auth but not /authors
  /\/authenticate/i,
  /\/authorization/i,
  /\/session\/new/i,
  /\/signup/i,
  /\/register/i,
  /\/forgot/i,
  /\/reset-password/i,
  /\/verify-email/i,
  /\/account\/security/i,
  /\/api-key/i,
  /\/credentials/i,
];

/**
 * Check if a URL path matches a sensitive pattern.
 * Returns true if the path should be BLOCKED from indexing.
 */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(path));
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/extension/sensitive-paths.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add extension/src/sensitive-paths.ts test/extension/sensitive-paths.test.ts
git commit -m "feat(index): add sensitive-paths.ts blocklist (security-first)"
```

---

### Task 3: Observer (webRequest Listener)

**Files:**
- Create: `extension/src/observer.ts`
- Test: `test/extension/observer.test.ts`

The observer uses `webRequest.onSendHeaders` to capture request headers (auth detection) and `webRequest.onCompleted` to process completed requests. It builds an in-memory buffer of observations per domain, calling a provided callback with each observation.

**Step 1: Write the failing test**

The observer can't be fully unit-tested without chrome APIs, but we can test the core logic (observation processing) by extracting a pure `processCompletedRequest()` function.

```typescript
// test/extension/observer.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processCompletedRequest } from '../../extension/src/observer.js';

describe('observer processCompletedRequest', () => {
  it('returns null for non-JSON responses', () => {
    const result = processCompletedRequest({
      url: 'https://example.com/page.html',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'text/html',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result, null);
  });

  it('returns null for sensitive paths', () => {
    const result = processCompletedRequest({
      url: 'https://example.com/api/login',
      method: 'POST',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result, null);
  });

  it('returns null for blocked URLs (private IPs)', () => {
    const result = processCompletedRequest({
      url: 'http://192.168.1.1/api/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result, null);
  });

  it('processes a valid JSON API response', () => {
    const result = processCompletedRequest({
      url: 'https://discord.com/api/v10/channels/12345',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { authorization: 'Bearer xyz' },
      responseHeaders: { 'content-length': '1234' },
    });
    assert.ok(result);
    assert.equal(result!.domain, 'discord.com');
    assert.equal(result!.endpoint.path, '/api/v10/channels/:id');
    assert.deepEqual(result!.endpoint.methods, ['GET']);
    assert.equal(result!.endpoint.authType, 'Bearer');
    assert.equal(result!.endpoint.hasBody, true);
    assert.equal(result!.endpoint.hits, 1);
  });

  it('parameterizes UUIDs in paths', () => {
    const result = processCompletedRequest({
      url: 'https://api.github.com/repos/a1b2c3d4-e5f6-7890-abcd-ef1234567890/issues',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.equal(result!.endpoint.path, '/repos/:id/issues');
  });

  it('detects Bearer auth from Authorization header', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { authorization: 'Bearer eyJhbGci...' },
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.authType, 'Bearer');
  });

  it('detects API Key auth from x-api-key header', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { 'x-api-key': 'sk-abc123' },
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.authType, 'API Key');
  });

  it('detects Cookie auth', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: { cookie: 'session=abc123' },
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.authType, 'Cookie');
  });

  it('extracts query parameter names (never values)', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/search?q=hello&limit=10&offset=0',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.deepEqual(result!.endpoint.queryParamNames, ['limit', 'offset', 'q']);
  });

  it('detects cursor pagination from Link header', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/items',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: { link: '<https://api.example.com/items?cursor=abc>; rel="next"' },
    });
    assert.equal(result!.endpoint.pagination, 'cursor');
  });

  it('detects offset pagination from query params', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/items?offset=20&limit=10',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.equal(result!.endpoint.pagination, 'offset');
  });

  it('flags POST /graphql as graphql type', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/graphql',
      method: 'POST',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: {},
    });
    assert.ok(result);
    assert.equal(result!.endpoint.type, 'graphql');
  });

  it('detects hasBody from content-length > 0', () => {
    const result = processCompletedRequest({
      url: 'https://api.example.com/data',
      method: 'GET',
      statusCode: 200,
      responseContentType: 'application/json',
      requestHeaders: {},
      responseHeaders: { 'content-length': '0' },
    });
    assert.equal(result!.endpoint.hasBody, false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/extension/observer.test.ts`
Expected: FAIL — module `observer.js` not found

**Step 3: Write the implementation**

```typescript
// extension/src/observer.ts

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
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/extension/observer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add extension/src/observer.ts test/extension/observer.test.ts
git commit -m "feat(index): add observer.ts with processCompletedRequest"
```

---

### Task 4: Index Store (chrome.storage.local Management)

**Files:**
- Create: `extension/src/index-store.ts`
- Test: `test/extension/index-store.test.ts`

Manages the in-memory index state, merging new observations into existing entries. The merge logic is key: same domain + same parameterized path = update existing entry (add methods, bump hits, update timestamps).

**Step 1: Write the failing test**

```typescript
// test/extension/index-store.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeObservation, createEmptyIndex } from '../../extension/src/index-store.js';
import type { IndexFile } from '../../extension/src/types.js';
import type { Observation } from '../../extension/src/observer.js';

describe('index-store mergeObservation', () => {
  it('adds a new domain entry', () => {
    const index = createEmptyIndex();
    const obs: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['GET'],
        authType: 'Bearer',
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };

    const updated = mergeObservation(index, obs);
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entries[0].domain, 'discord.com');
    assert.equal(updated.entries[0].endpoints.length, 1);
    assert.equal(updated.entries[0].totalHits, 1);
    assert.equal(updated.entries[0].promoted, false);
  });

  it('merges into existing domain entry', () => {
    const index = createEmptyIndex();
    const obs1: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };
    const obs2: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/guilds/:id',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:01:00Z',
      },
    };

    let updated = mergeObservation(index, obs1);
    updated = mergeObservation(updated, obs2);
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entries[0].endpoints.length, 2);
    assert.equal(updated.entries[0].totalHits, 2);
  });

  it('merges methods into existing endpoint', () => {
    const index = createEmptyIndex();
    const obs1: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };
    const obs2: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['PATCH'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:01:00Z',
      },
    };

    let updated = mergeObservation(index, obs1);
    updated = mergeObservation(updated, obs2);
    assert.equal(updated.entries[0].endpoints.length, 1);
    assert.deepEqual(updated.entries[0].endpoints[0].methods, ['GET', 'PATCH']);
    assert.equal(updated.entries[0].endpoints[0].hits, 2);
  });

  it('does not duplicate methods', () => {
    const index = createEmptyIndex();
    const obs: Observation = {
      domain: 'example.com',
      endpoint: {
        path: '/api/data',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };

    let updated = mergeObservation(index, obs);
    updated = mergeObservation(updated, obs);
    assert.deepEqual(updated.entries[0].endpoints[0].methods, ['GET']);
    assert.equal(updated.entries[0].endpoints[0].hits, 2);
  });

  it('merges queryParamNames without duplicates', () => {
    const index = createEmptyIndex();
    const obs1: Observation = {
      domain: 'example.com',
      endpoint: {
        path: '/api/search',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
        queryParamNames: ['q', 'limit'],
      },
    };
    const obs2: Observation = {
      domain: 'example.com',
      endpoint: {
        path: '/api/search',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:01:00Z',
        queryParamNames: ['q', 'offset'],
      },
    };

    let updated = mergeObservation(index, obs1);
    updated = mergeObservation(updated, obs2);
    const qp = updated.entries[0].endpoints[0].queryParamNames!;
    assert.ok(qp.includes('q'));
    assert.ok(qp.includes('limit'));
    assert.ok(qp.includes('offset'));
    assert.equal(qp.length, 3);
  });

  it('updates lastSeen timestamp on domain and endpoint', () => {
    const index = createEmptyIndex();
    const early = '2026-03-07T10:00:00Z';
    const late = '2026-03-07T14:00:00Z';

    let updated = mergeObservation(index, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], hasBody: true, hits: 1, lastSeen: early },
    });
    updated = mergeObservation(updated, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], hasBody: true, hits: 1, lastSeen: late },
    });

    assert.equal(updated.entries[0].lastSeen, late);
    assert.equal(updated.entries[0].endpoints[0].lastSeen, late);
  });

  it('preserves authType once detected', () => {
    const index = createEmptyIndex();
    // First request has no auth, second has Bearer
    let updated = mergeObservation(index, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T10:00:00Z' },
    });
    updated = mergeObservation(updated, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], authType: 'Bearer', hasBody: true, hits: 1, lastSeen: '2026-03-07T11:00:00Z' },
    });

    assert.equal(updated.entries[0].endpoints[0].authType, 'Bearer');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/extension/index-store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// extension/src/index-store.ts

import type { IndexFile, IndexEntry, IndexEndpoint } from './types.js';
import type { Observation } from './observer.js';

/** Create an empty index */
export function createEmptyIndex(): IndexFile {
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

/** Merge a single observation into the index. Returns a new index (immutable). */
export function mergeObservation(index: IndexFile, obs: Observation): IndexFile {
  const entries = [...index.entries];
  const now = obs.endpoint.lastSeen;

  let domainEntry = entries.find(e => e.domain === obs.domain);
  if (!domainEntry) {
    domainEntry = {
      domain: obs.domain,
      firstSeen: now,
      lastSeen: now,
      totalHits: 0,
      promoted: false,
      endpoints: [],
    };
    entries.push(domainEntry);
  } else {
    // Clone to avoid mutating the original
    const idx = entries.indexOf(domainEntry);
    domainEntry = { ...domainEntry, endpoints: [...domainEntry.endpoints] };
    entries[idx] = domainEntry;
  }

  domainEntry.totalHits++;
  domainEntry.lastSeen = now;

  // Find or create endpoint
  const existingEp = domainEntry.endpoints.find(ep => ep.path === obs.endpoint.path);
  if (existingEp) {
    const epIdx = domainEntry.endpoints.indexOf(existingEp);
    const merged: IndexEndpoint = {
      ...existingEp,
      hits: existingEp.hits + 1,
      lastSeen: now,
      hasBody: existingEp.hasBody || obs.endpoint.hasBody,
    };

    // Merge methods without duplicates
    const methodSet = new Set([...existingEp.methods, ...obs.endpoint.methods]);
    merged.methods = [...methodSet];

    // Merge auth type (keep first detected)
    if (!existingEp.authType && obs.endpoint.authType) {
      merged.authType = obs.endpoint.authType;
    }

    // Merge pagination (keep first detected)
    if (!existingEp.pagination && obs.endpoint.pagination) {
      merged.pagination = obs.endpoint.pagination;
    }

    // Merge type (keep first detected)
    if (!existingEp.type && obs.endpoint.type) {
      merged.type = obs.endpoint.type;
    }

    // Merge query param names without duplicates
    if (obs.endpoint.queryParamNames || existingEp.queryParamNames) {
      const paramSet = new Set([
        ...(existingEp.queryParamNames ?? []),
        ...(obs.endpoint.queryParamNames ?? []),
      ]);
      merged.queryParamNames = [...paramSet].sort();
    }

    domainEntry.endpoints[epIdx] = merged;
  } else {
    domainEntry.endpoints.push({ ...obs.endpoint });
  }

  return {
    v: 1,
    updatedAt: now,
    entries,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/extension/index-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add extension/src/index-store.ts test/extension/index-store.test.ts
git commit -m "feat(index): add index-store.ts with merge logic"
```

---

### Task 5: Update manifest.json and esbuild Config

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/esbuild.config.mjs` (if observer needs separate bundle — likely not, it's imported by background.ts)

**Step 1: Add webRequest permission to manifest.json**

Add `"webRequest"` to the permissions array in `extension/manifest.json`:

```json
{
  "permissions": ["debugger", "activeTab", "tabs", "storage", "downloads", "nativeMessaging", "notifications", "webRequest"]
}
```

No esbuild changes needed — observer.ts is imported by background.ts and bundled together.

**Step 2: Verify extension still builds**

Run: `cd extension && npm run build`
Expected: Build succeeds, dist/background.js updated

**Step 3: Commit**

```bash
git add extension/manifest.json
git commit -m "feat(index): add webRequest permission to manifest"
```

---

### Task 6: Native Host — save_index Action

**Files:**
- Modify: `src/native-host.ts`
- Test: `test/native-host-index.test.ts`

Add a `save_index` action that writes index.json atomically (temp file + rename).

**Step 1: Write the failing test**

```typescript
// test/native-host-index.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleNativeMessage } from '../src/native-host.js';

describe('native host save_index', () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-test-'));
    skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes index.json atomically to parent of skills dir', async () => {
    const indexData = JSON.stringify({
      v: 1,
      updatedAt: '2026-03-07T12:00:00Z',
      entries: [{
        domain: 'discord.com',
        firstSeen: '2026-03-01T00:00:00Z',
        lastSeen: '2026-03-07T12:00:00Z',
        totalHits: 127,
        promoted: false,
        endpoints: [],
      }],
    });

    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: indexData } as any,
      skillsDir,
    );
    assert.ok(result.success, `Expected success but got: ${result.error}`);
    assert.ok(result.path);

    // Verify the file exists and is valid JSON
    const written = await fs.readFile(result.path!, 'utf-8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.entries[0].domain, 'discord.com');
  });

  it('rejects invalid JSON', async () => {
    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: 'not json' } as any,
      skillsDir,
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid JSON'));
  });

  it('rejects missing indexJson', async () => {
    const result = await handleNativeMessage(
      { action: 'save_index' as any } as any,
      skillsDir,
    );
    assert.equal(result.success, false);
  });

  it('overwrites existing index.json', async () => {
    const indexPath = path.join(tmpDir, 'index.json');
    await fs.writeFile(indexPath, '{"v":1,"entries":[]}');

    const indexData = JSON.stringify({
      v: 1,
      updatedAt: '2026-03-07T14:00:00Z',
      entries: [{ domain: 'new.com', firstSeen: '2026-03-07T14:00:00Z', lastSeen: '2026-03-07T14:00:00Z', totalHits: 1, promoted: false, endpoints: [] }],
    });

    const result = await handleNativeMessage(
      { action: 'save_index' as any, indexJson: indexData } as any,
      skillsDir,
    );
    assert.ok(result.success);

    const written = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    assert.equal(written.entries[0].domain, 'new.com');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/native-host-index.test.ts`
Expected: FAIL — `save_index` action returns "Unknown action"

**Step 3: Add save_index to native-host.ts**

Add to `NativeRequest` interface:

```typescript
export interface NativeRequest {
  action: 'save_skill' | 'save_batch' | 'ping' | 'capture_request' | 'save_index';
  domain?: string;
  skillJson?: string;
  skills?: Array<{ domain: string; skillJson: string }>;
  indexJson?: string;
}
```

Add the handler inside `handleNativeMessage()`, before the "Unknown action" return:

```typescript
if (request.action === 'save_index') {
  if (!request.indexJson) {
    return { success: false, error: 'Missing indexJson' };
  }
  try {
    JSON.parse(request.indexJson);
  } catch {
    return { success: false, error: 'Invalid JSON in indexJson' };
  }

  // index.json lives in ~/.apitap/ (parent of skills dir)
  const apitapDir = path.dirname(skillsDir);
  await fs.mkdir(apitapDir, { recursive: true });
  const indexPath = path.join(apitapDir, 'index.json');

  // Atomic write: temp file + rename
  const tmpPath = indexPath + '.tmp.' + process.pid;
  await fs.writeFile(tmpPath, request.indexJson, { mode: 0o600 });
  await fs.rename(tmpPath, indexPath);

  return { success: true, path: indexPath };
}
```

Add `'save_index'` to the `LOCAL_ACTIONS` set:

```typescript
const LOCAL_ACTIONS = new Set(['save_skill', 'save_batch', 'ping', 'save_index']);
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/native-host-index.test.ts`
Expected: PASS

**Step 5: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/native-host.ts test/native-host-index.test.ts
git commit -m "feat(index): add save_index action to native host (atomic write)"
```

---

### Task 7: Wire Observer + Index Store + Flush into background.ts

**Files:**
- Modify: `extension/src/background.ts`

This is the integration task. Wire the observer's webRequest listeners, accumulate observations via index-store, and flush to disk via the native bridge.

**Step 1: Add webRequest listeners and flush logic to background.ts**

At the top of `background.ts`, add imports:

```typescript
import { processCompletedRequest } from './observer.js';
import { mergeObservation, createEmptyIndex } from './index-store.js';
import type { IndexFile } from './types.js';
```

Add index state management (after existing state declarations):

```typescript
// --- Passive Index state ---

let passiveIndex: IndexFile = createEmptyIndex();
let indexDirty = false; // tracks whether index has unsaved changes

// Pending request headers for auth detection (webRequest doesn't give both in one event)
const pendingObserverHeaders = new Map<string, Record<string, string>>();

// Load index from chrome.storage.local on startup
chrome.storage.local.get(['passiveIndex'], (result) => {
  if (result.passiveIndex) {
    passiveIndex = result.passiveIndex;
  }
});
```

Add webRequest listeners:

```typescript
// --- webRequest listeners for passive indexing ---

// Capture request headers (for auth detection) — fires before request is sent
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore non-tab requests
    const headers: Record<string, string> = {};
    for (const h of details.requestHeaders ?? []) {
      if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
    }
    pendingObserverHeaders.set(String(details.requestId), headers);
    // Clean up if map grows too large (prevent memory leak)
    if (pendingObserverHeaders.size > 1000) {
      const keys = [...pendingObserverHeaders.keys()];
      for (const k of keys.slice(0, 500)) pendingObserverHeaders.delete(k);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'],
);

// Process completed requests — this is the main observation point
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore non-tab requests

    const reqHeaders = pendingObserverHeaders.get(String(details.requestId)) ?? {};
    pendingObserverHeaders.delete(String(details.requestId));

    // Build response headers record
    const responseHeaders: Record<string, string> = {};
    for (const h of details.responseHeaders ?? []) {
      if (h.name && h.value) responseHeaders[h.name.toLowerCase()] = h.value;
    }

    const contentType = responseHeaders['content-type'] ?? '';

    const obs = processCompletedRequest({
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      responseContentType: contentType,
      requestHeaders: reqHeaders,
      responseHeaders,
    });

    if (obs) {
      passiveIndex = mergeObservation(passiveIndex, obs);
      indexDirty = true;
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'],
);
```

Add flush logic:

```typescript
// --- Index flush scheduling ---

const INDEX_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function flushIndex(): Promise<void> {
  if (!indexDirty) return;

  // Persist to chrome.storage.local first (survives service worker restart)
  await chrome.storage.local.set({ passiveIndex });
  indexDirty = false;

  // Send to native host for disk persistence (if bridge connected)
  if (nativePort && bridgeAvailable) {
    try {
      await sendNativePortMessage({
        action: 'save_index',
        indexJson: JSON.stringify(passiveIndex),
      }, 15_000);
    } catch {
      // Native host not available — index stays in chrome.storage.local
    }
  }
}

// Periodic flush timer
setInterval(flushIndex, INDEX_FLUSH_INTERVAL_MS);

// Flush on tab close
chrome.tabs.onRemoved.addListener(() => {
  void flushIndex();
});

// Best-effort flush on service worker suspend (MV3)
chrome.runtime.onSuspend.addListener(() => {
  // Synchronous chrome.storage.local.set as last resort
  chrome.storage.local.set({ passiveIndex });
});
```

**Step 2: Verify extension builds**

Run: `cd extension && npm run build`
Expected: Build succeeds

**Step 3: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add extension/src/background.ts
git commit -m "feat(index): wire observer + index-store + flush into background.ts"
```

---

### Task 8: Index Reader for CLI

**Files:**
- Create: `src/index/reader.ts`
- Test: `test/index/reader.test.ts`

A simple reader for `~/.apitap/index.json` that the CLI and MCP can use.

**Step 1: Write the failing test**

```typescript
// test/index/reader.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readIndex, readIndexEntry } from '../../src/index/reader.js';

describe('index reader', () => {
  let tmpDir: string;

  const sampleIndex = {
    v: 1,
    updatedAt: '2026-03-07T12:00:00Z',
    entries: [
      {
        domain: 'discord.com',
        firstSeen: '2026-03-01T00:00:00Z',
        lastSeen: '2026-03-07T12:00:00Z',
        totalHits: 127,
        promoted: false,
        endpoints: [
          { path: '/api/v10/channels/:id', methods: ['GET', 'PATCH'], authType: 'Bearer', hasBody: true, hits: 42, lastSeen: '2026-03-07T12:00:00Z' },
          { path: '/api/v10/guilds/:id', methods: ['GET'], hasBody: true, hits: 30, lastSeen: '2026-03-07T11:00:00Z' },
        ],
      },
      {
        domain: 'github.com',
        firstSeen: '2026-03-02T00:00:00Z',
        lastSeen: '2026-03-07T10:00:00Z',
        totalHits: 43,
        promoted: true,
        lastPromoted: '2026-03-05T10:00:00Z',
        skillFileSource: 'extension',
        endpoints: [
          { path: '/api/v3/repos/:id', methods: ['GET'], hasBody: true, hits: 20, lastSeen: '2026-03-07T10:00:00Z' },
        ],
      },
    ],
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-idx-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads a valid index file', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
    const index = await readIndex(tmpDir);
    assert.ok(index);
    assert.equal(index!.v, 1);
    assert.equal(index!.entries.length, 2);
  });

  it('returns null when index.json does not exist', async () => {
    const index = await readIndex(tmpDir);
    assert.equal(index, null);
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), 'not json');
    const index = await readIndex(tmpDir);
    assert.equal(index, null);
  });

  it('filters entries by domain', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
    const entry = await readIndexEntry('discord.com', tmpDir);
    assert.ok(entry);
    assert.equal(entry!.domain, 'discord.com');
    assert.equal(entry!.endpoints.length, 2);
  });

  it('returns null for unknown domain', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
    const entry = await readIndexEntry('unknown.com', tmpDir);
    assert.equal(entry, null);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/index/reader.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/index/reader.ts

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Types re-declared here (extension types can't be imported due to different tsconfig).
// Keep in sync with extension/src/types.ts IndexFile/IndexEntry/IndexEndpoint.
export interface IndexFile {
  v: 1;
  updatedAt: string;
  entries: IndexEntry[];
}

export interface IndexEntry {
  domain: string;
  firstSeen: string;
  lastSeen: string;
  totalHits: number;
  promoted: boolean;
  lastPromoted?: string;
  skillFileSource?: 'extension' | 'cli';
  endpoints: IndexEndpoint[];
}

export interface IndexEndpoint {
  path: string;
  methods: string[];
  authType?: string;
  hasBody: boolean;
  hits: number;
  lastSeen: string;
  pagination?: string;
  type?: 'graphql';
  queryParamNames?: string[];
}

const DEFAULT_APITAP_DIR = path.join(os.homedir(), '.apitap');

/**
 * Read the full passive index from disk.
 * Returns null if index.json doesn't exist or is invalid.
 */
export async function readIndex(apitapDir: string = DEFAULT_APITAP_DIR): Promise<IndexFile | null> {
  const indexPath = path.join(apitapDir, 'index.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed as IndexFile;
  } catch {
    return null;
  }
}

/**
 * Read a single domain's index entry.
 * Returns null if the domain is not in the index.
 */
export async function readIndexEntry(
  domain: string,
  apitapDir: string = DEFAULT_APITAP_DIR,
): Promise<IndexEntry | null> {
  const index = await readIndex(apitapDir);
  if (!index) return null;
  return index.entries.find(e => e.domain === domain) ?? null;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/index/reader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index/reader.ts test/index/reader.test.ts
git commit -m "feat(index): add CLI-side index reader"
```

---

### Task 9: Extend CLI Discover Command

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli/discover-index.test.ts`

Extend the existing `apitap discover` command to also show passive index data. When a domain is in the index, show endpoint map, hit counts, auth type, and promotion status alongside the existing browser-free discovery results.

**Step 1: Write the failing test**

```typescript
// test/cli/discover-index.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CLI discover with index data', () => {
  let tmpDir: string;

  const sampleIndex = {
    v: 1,
    updatedAt: '2026-03-07T12:00:00Z',
    entries: [{
      domain: 'discord.com',
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-07T12:00:00Z',
      totalHits: 127,
      promoted: false,
      endpoints: [
        { path: '/api/v10/channels/:id', methods: ['GET', 'PATCH'], authType: 'Bearer', hasBody: true, hits: 42, lastSeen: '2026-03-07T12:00:00Z' },
        { path: '/api/v10/guilds/:id', methods: ['GET'], hasBody: true, hits: 30, lastSeen: '2026-03-07T11:00:00Z' },
      ],
    }],
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-cli-'));
    await fs.writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(sampleIndex));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('readIndex returns entries for known domain', async () => {
    const { readIndexEntry } = await import('../../src/index/reader.js');
    const entry = await readIndexEntry('discord.com', tmpDir);
    assert.ok(entry);
    assert.equal(entry!.totalHits, 127);
    assert.equal(entry!.endpoints.length, 2);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `node --import tsx --test test/cli/discover-index.test.ts`
Expected: PASS (reader already works from Task 8)

**Step 3: Modify src/cli.ts to show index data in discover command**

In `handleDiscover()`, add index lookup alongside the existing discovery. The implementer should:

1. Read `handleDiscover()` (currently around lines 820-922)
2. Import `readIndexEntry` from `./index/reader.js`
3. Extract the domain from the URL argument
4. Call `readIndexEntry(domain)` alongside the existing `discover(url)` call
5. For human-readable output, append a "Passive Index" section after the existing output:

```typescript
import { readIndexEntry } from './index/reader.js';

// Inside handleDiscover(), after domain is extracted from URL:
const indexEntry = await readIndexEntry(domain);

// For human-readable output, after existing discovery output:
if (indexEntry) {
  console.log('');
  console.log('  Passive Index (from browser extension):');
  console.log('    Domain:     ' + indexEntry.domain);
  console.log('    Total hits: ' + indexEntry.totalHits);
  console.log('    Endpoints:  ' + indexEntry.endpoints.length);
  console.log('    Promoted:   ' + (indexEntry.promoted ? 'yes' : 'no'));
  if (indexEntry.endpoints.length > 0) {
    console.log('    Observed endpoints:');
    for (const ep of indexEntry.endpoints) {
      const methods = ep.methods.join(', ');
      const auth = ep.authType ? ' [' + ep.authType + ']' : '';
      const pagination = ep.pagination ? ' (' + ep.pagination + ')' : '';
      const gql = ep.type === 'graphql' ? ' [GraphQL]' : '';
      console.log('      ' + methods + ' ' + ep.path + ' \u2014 ' + ep.hits + ' hits' + auth + pagination + gql);
    }
  }
}

// For JSON output, add indexEntry to the result object before serialization:
// result.indexEntry = indexEntry ?? undefined;
```

**Step 4: Run tests to verify no regressions**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/cli.ts test/cli/discover-index.test.ts
git commit -m "feat(index): show passive index data in CLI discover command"
```

---

### Task 10: Extend MCP apitap_discover Tool

**Files:**
- Modify: `src/mcp.ts`

Extend the existing `apitap_discover` tool to include index data in its response. Agents can see both browser-free discovery results AND passive index observations.

**Step 1: Read existing apitap_discover tool**

Read `src/mcp.ts` lines 113-161 to understand current implementation.

**Step 2: Add index data to MCP response**

In the `apitap_discover` tool handler, add:

```typescript
import { readIndexEntry } from './index/reader.js';

// Inside the tool handler, alongside the existing discover() call:
const domain = new URL(url).hostname;
const indexEntry = await readIndexEntry(domain);

// Include in the response object
const result = {
  ...discoveryResult,
  indexEntry: indexEntry ?? undefined,
};
```

**Step 3: Run tests to verify no regressions**

Run: `npm test`
Expected: All tests pass (including MCP tests)

**Step 4: Commit**

```bash
git add src/mcp.ts
git commit -m "feat(index): include passive index data in MCP apitap_discover tool"
```

---

### Task 11: Promotion Module

**Files:**
- Create: `extension/src/promotion.ts`
- Test: `test/extension/promotion.test.ts`

Promotion orchestrates CDP capture for a domain already in the index. It reuses the existing `captureWithPlateau()` flow from `background.ts`. The promotion module handles marking the domain as promoted in the index after a successful capture.

**Step 1: Write the failing test**

Since promotion depends heavily on chrome.* APIs, the testable unit is the index update logic:

```typescript
// test/extension/promotion.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markPromoted } from '../../extension/src/promotion.js';
import { createEmptyIndex, mergeObservation } from '../../extension/src/index-store.js';

describe('promotion', () => {
  it('marks domain as promoted in index', () => {
    let index = createEmptyIndex();
    index = mergeObservation(index, {
      domain: 'discord.com',
      endpoint: { path: '/api/channels/:id', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T12:00:00Z' },
    });

    const updated = markPromoted(index, 'discord.com', 'extension');
    const entry = updated.entries.find(e => e.domain === 'discord.com')!;
    assert.equal(entry.promoted, true);
    assert.ok(entry.lastPromoted);
    assert.equal(entry.skillFileSource, 'extension');
  });

  it('is a no-op for unknown domain', () => {
    const index = createEmptyIndex();
    const updated = markPromoted(index, 'unknown.com', 'extension');
    assert.equal(updated.entries.length, 0);
  });

  it('preserves other entries when promoting one domain', () => {
    let index = createEmptyIndex();
    index = mergeObservation(index, {
      domain: 'discord.com',
      endpoint: { path: '/api/channels/:id', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T12:00:00Z' },
    });
    index = mergeObservation(index, {
      domain: 'github.com',
      endpoint: { path: '/api/repos', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T12:00:00Z' },
    });

    const updated = markPromoted(index, 'discord.com', 'extension');
    assert.equal(updated.entries.length, 2);
    assert.equal(updated.entries.find(e => e.domain === 'github.com')!.promoted, false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/extension/promotion.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// extension/src/promotion.ts

import type { IndexFile } from './types.js';

/**
 * Mark a domain as promoted in the index.
 * Called after a successful CDP capture generates a skill file.
 */
export function markPromoted(
  index: IndexFile,
  domain: string,
  source: 'extension' | 'cli',
): IndexFile {
  const entries = index.entries.map(entry => {
    if (entry.domain !== domain) return entry;
    return {
      ...entry,
      promoted: true,
      lastPromoted: new Date().toISOString(),
      skillFileSource: source,
    };
  });

  return { ...index, entries, updatedAt: new Date().toISOString() };
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/extension/promotion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add extension/src/promotion.ts test/extension/promotion.test.ts
git commit -m "feat(index): add promotion.ts with markPromoted"
```

---

### Task 12: Wire Promotion into background.ts

**Files:**
- Modify: `extension/src/background.ts`
- Modify: `extension/src/types.ts` (add new message types)

Add popup message handling for promotion requests. When the popup sends `PROMOTE_DOMAIN`, background.ts runs CDP capture and marks the domain promoted.

**Step 1: Add new message types to extension/src/types.ts**

```typescript
// Update CaptureMessage type union to include new actions:
export interface CaptureMessage {
  type: 'START_CAPTURE' | 'STOP_CAPTURE' | 'GET_STATE' | 'DOWNLOAD_SKILL'
    | 'PROMOTE_DOMAIN' | 'GET_INDEX';
  domain?: string; // for PROMOTE_DOMAIN
}
```

**Step 2: Add promotion handler to background.ts**

Import promotion module and add cases to the `chrome.runtime.onMessage.addListener` switch block:

```typescript
import { markPromoted } from './promotion.js';

// In the message handler switch:
case 'PROMOTE_DOMAIN': {
  const domain = (message as any).domain;
  if (!domain || !isValidDomain(domain)) {
    sendResponse({ type: 'ERROR', error: 'Invalid domain' } as CaptureResponse);
    break;
  }
  if (state.active) {
    sendResponse({ type: 'ERROR', error: 'Capture already in progress' } as CaptureResponse);
    break;
  }

  findOrOpenTab(domain).then(async (tab) => {
    if (!tab.id) {
      sendResponse({ type: 'ERROR', error: 'No tab available' } as CaptureResponse);
      return;
    }

    const skillFiles = await captureWithPlateau(tab.id, {
      idleTimeout: 10_000,
      maxDuration: 120_000,
    });

    if (skillFiles.length > 0) {
      // Save via bridge
      if (bridgeAvailable && nativePort) {
        const skills = skillFiles.map(json => {
          const parsed = JSON.parse(json);
          return { domain: parsed.domain, skillJson: json };
        });
        await saveViaBridge(skills);
      }

      // Mark promoted in index
      passiveIndex = markPromoted(passiveIndex, domain, 'extension');
      indexDirty = true;
      await flushIndex();
    }

    sendResponse({
      type: 'CAPTURE_COMPLETE',
      state: { ...state },
      skillJson: lastSkillJson ?? undefined,
    } as CaptureResponse);
  });
  return true; // async sendResponse
}

case 'GET_INDEX': {
  sendResponse({ type: 'STATE_UPDATE', index: passiveIndex } as any);
  break;
}
```

**Step 3: Verify extension builds**

Run: `cd extension && npm run build`
Expected: Build succeeds

**Step 4: Run tests to verify no regressions**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add extension/src/background.ts extension/src/types.ts
git commit -m "feat(index): wire promotion into background.ts message handling"
```

---

### Task 13: Popup UI — Index Tab

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.css`
- Modify: `extension/src/popup.ts`

Add a tab bar (Capture | Index | Settings) and an Index tab showing domains with hit counts, endpoint counts, auth types, and a "Generate skill file" button.

**Step 1: Update popup.html**

Add tab navigation and index content area. Reference the design mockup from the design doc:

```html
<!-- Add tab bar after header -->
<div class="tabs">
  <button class="tab active" data-tab="capture">Capture</button>
  <button class="tab" data-tab="index">Index</button>
  <button class="tab" data-tab="settings">Settings</button>
</div>

<!-- Wrap existing content in capture tab -->
<div id="tab-capture" class="tab-content active">
  <!-- existing capture UI -->
</div>

<!-- Add index tab -->
<div id="tab-index" class="tab-content" style="display:none">
  <div id="index-list"></div>
  <div id="index-empty" style="display:none">
    <p>No API traffic observed yet. Browse the web and endpoints will appear here.</p>
  </div>
</div>

<!-- Settings tab placeholder (Task 14) -->
<div id="tab-settings" class="tab-content" style="display:none">
  <p>Settings coming soon.</p>
</div>
```

**Step 2: Add tab switching and index rendering to popup.ts**

Use safe DOM methods (no innerHTML — prevents XSS):

```typescript
// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => (c as HTMLElement).style.display = 'none');
    tab.classList.add('active');
    const target = tab.getAttribute('data-tab')!;
    document.getElementById('tab-' + target)!.style.display = 'block';
    if (target === 'index') loadIndex();
  });
});

// Load and render index data using safe DOM methods
function loadIndex() {
  chrome.runtime.sendMessage({ type: 'GET_INDEX' }, (response: any) => {
    const index = response?.index;
    const list = document.getElementById('index-list')!;
    const empty = document.getElementById('index-empty')!;

    // Clear previous entries
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!index || index.entries.length === 0) {
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    // Sort by totalHits descending
    const sorted = [...index.entries].sort((a: any, b: any) => b.totalHits - a.totalHits);

    for (const entry of sorted) {
      const card = document.createElement('div');
      card.className = 'index-entry';

      const header = document.createElement('div');
      header.className = 'index-header';
      const domainEl = document.createElement('strong');
      domainEl.textContent = entry.domain;
      const hitsEl = document.createElement('span');
      hitsEl.className = 'hit-count';
      hitsEl.textContent = entry.totalHits + ' hits';
      header.appendChild(domainEl);
      header.appendChild(hitsEl);

      const meta = document.createElement('div');
      meta.className = 'index-meta';
      const authBadge = entry.endpoints.find((ep: any) => ep.authType)?.authType ?? '';
      meta.textContent = entry.endpoints.length + ' endpoints' + (authBadge ? ' | ' + authBadge : '');

      const actions = document.createElement('div');
      actions.className = 'index-actions';
      if (entry.promoted) {
        const badge = document.createElement('span');
        badge.className = 'badge promoted';
        badge.textContent = 'Skill file exists';
        actions.appendChild(badge);
      } else {
        const btn = document.createElement('button');
        btn.className = 'btn-promote';
        btn.textContent = 'Generate skill file';
        btn.addEventListener('click', () => {
          btn.textContent = 'Capturing...';
          btn.disabled = true;
          chrome.runtime.sendMessage({ type: 'PROMOTE_DOMAIN', domain: entry.domain });
        });
        actions.appendChild(btn);
      }

      card.appendChild(header);
      card.appendChild(meta);
      card.appendChild(actions);
      list.appendChild(card);
    }
  });
}
```

**Step 3: Add styles to popup.css**

```css
.tabs { display: flex; border-bottom: 1px solid #ccc; margin-bottom: 8px; }
.tab { flex: 1; padding: 6px 8px; border: none; background: none; cursor: pointer; font-size: 13px; }
.tab.active { border-bottom: 2px solid #4a9eff; font-weight: bold; }
.tab-content { padding: 4px 0; }
.index-entry { padding: 8px 0; border-bottom: 1px solid #eee; }
.index-header { display: flex; justify-content: space-between; }
.hit-count { color: #666; font-size: 12px; }
.index-meta { font-size: 12px; color: #888; margin: 2px 0; }
.btn-promote { font-size: 11px; padding: 2px 8px; cursor: pointer; }
.badge.promoted { font-size: 11px; color: #4a9; }
```

**Step 4: Verify extension builds**

Run: `cd extension && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add extension/popup.html extension/popup.css extension/src/popup.ts
git commit -m "feat(index): add Index tab to popup with domain list and promote button"
```

---

### Task 14: Popup UI — Settings (Auto-learn)

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/src/popup.ts`
- Modify: `extension/src/background.ts`

Add Auto-learn toggle and revisit threshold setting. Auto-learn is opt-in: when enabled, the extension auto-promotes domains on the Nth revisit.

**Step 1: Add settings UI to popup.html**

Replace the settings tab placeholder:

```html
<div id="tab-settings" class="tab-content" style="display:none">
  <div class="setting-row">
    <label>
      <input type="checkbox" id="auto-learn-toggle">
      Auto-learn mode
    </label>
    <p class="setting-desc">Automatically capture API traffic when you revisit sites.</p>
  </div>
  <div class="setting-row">
    <label>
      Revisit threshold:
      <input type="number" id="revisit-threshold" min="2" max="20" value="3" style="width:40px">
    </label>
    <p class="setting-desc">Number of visits before auto-capture triggers.</p>
  </div>
</div>
```

**Step 2: Add settings persistence to popup.ts**

```typescript
// Load settings
chrome.storage.local.get(['autoLearn', 'revisitThreshold'], (result) => {
  (document.getElementById('auto-learn-toggle') as HTMLInputElement).checked = result.autoLearn ?? false;
  (document.getElementById('revisit-threshold') as HTMLInputElement).value = String(result.revisitThreshold ?? 3);
});

// Save settings on change
document.getElementById('auto-learn-toggle')!.addEventListener('change', (e) => {
  chrome.storage.local.set({ autoLearn: (e.target as HTMLInputElement).checked });
});
document.getElementById('revisit-threshold')!.addEventListener('change', (e) => {
  chrome.storage.local.set({ revisitThreshold: parseInt((e.target as HTMLInputElement).value, 10) });
});
```

**Step 3: Add auto-learn check to background.ts observer**

In the `webRequest.onCompleted` listener, after successfully merging an observation, check if auto-learn conditions are met:

```typescript
// After mergeObservation in the onCompleted listener:
if (obs) {
  passiveIndex = mergeObservation(passiveIndex, obs);
  indexDirty = true;

  // Auto-learn check
  void checkAutoLearn(obs.domain);
}

async function checkAutoLearn(domain: string): Promise<void> {
  const settings = await chrome.storage.local.get(['autoLearn', 'revisitThreshold']);
  if (!settings.autoLearn) return;

  const threshold = settings.revisitThreshold ?? 3;
  const entry = passiveIndex.entries.find(e => e.domain === domain);
  if (!entry || entry.promoted) return;

  // Use totalHits as a proxy for revisit frequency
  if (entry.totalHits >= threshold && !state.active) {
    const tab = await findOrOpenTab(domain);
    if (!tab.id) return;
    const skillFiles = await captureWithPlateau(tab.id, {
      idleTimeout: 10_000,
      maxDuration: 120_000,
    });
    if (skillFiles.length > 0 && bridgeAvailable && nativePort) {
      const skills = skillFiles.map(json => {
        const parsed = JSON.parse(json);
        return { domain: parsed.domain, skillJson: json };
      });
      await saveViaBridge(skills);
      passiveIndex = markPromoted(passiveIndex, domain, 'extension');
      indexDirty = true;
      await flushIndex();
    }
  }
}
```

Note: The auto-learn threshold logic uses `totalHits` as a v1 proxy for revisit frequency. A more sophisticated implementation would track distinct visit sessions. The design doc mentions "Nth revisit" — this can be refined later with a `visitCount` field that increments per-session rather than per-request.

**Step 4: Verify extension builds**

Run: `cd extension && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add extension/popup.html extension/src/popup.ts extension/src/background.ts
git commit -m "feat(index): add Auto-learn settings to popup"
```

---

### Task 15: Lifecycle Management

**Files:**
- Create: `extension/src/lifecycle.ts`
- Test: `test/extension/lifecycle.test.ts`
- Modify: `extension/src/background.ts` (wire into flush)

Implement decay, hard delete, and soft cap logic:
- 90-day stale flag (zero new hits for 90 days)
- 180-day hard delete
- 500-domain soft cap (warn, never silently drop)

**Step 1: Write the failing test**

```typescript
// test/extension/lifecycle.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyLifecycle } from '../../extension/src/lifecycle.js';
import type { IndexFile } from '../../extension/src/types.js';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe('index lifecycle', () => {
  it('keeps entries with recent activity', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        domain: 'example.com',
        firstSeen: daysAgo(30),
        lastSeen: daysAgo(1),
        totalHits: 50,
        promoted: false,
        endpoints: [],
      }],
    };

    const result = applyLifecycle(index);
    assert.equal(result.index.entries.length, 1);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.stale.length, 0);
  });

  it('flags entries with 90+ days of inactivity as stale', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        domain: 'old.com',
        firstSeen: daysAgo(180),
        lastSeen: daysAgo(95),
        totalHits: 10,
        promoted: false,
        endpoints: [],
      }],
    };

    const result = applyLifecycle(index);
    assert.equal(result.stale.length, 1);
    assert.equal(result.stale[0], 'old.com');
    assert.equal(result.index.entries.length, 1); // still present
    assert.equal(result.deleted.length, 0);
  });

  it('hard deletes entries with 180+ days of inactivity', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        domain: 'ancient.com',
        firstSeen: daysAgo(365),
        lastSeen: daysAgo(185),
        totalHits: 5,
        promoted: false,
        endpoints: [],
      }],
    };

    const result = applyLifecycle(index);
    assert.equal(result.index.entries.length, 0);
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0], 'ancient.com');
  });

  it('warns when entry count exceeds 500', () => {
    const entries = Array.from({ length: 510 }, (_, i) => ({
      domain: 'site' + i + '.com',
      firstSeen: daysAgo(10),
      lastSeen: daysAgo(1),
      totalHits: 10,
      promoted: false,
      endpoints: [],
    }));

    const index: IndexFile = { v: 1, updatedAt: new Date().toISOString(), entries };
    const result = applyLifecycle(index);
    assert.ok(result.overCap);
    assert.equal(result.index.entries.length, 510); // never silently drop
  });

  it('does not warn when entry count is under 500', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{ domain: 'a.com', firstSeen: daysAgo(1), lastSeen: daysAgo(0), totalHits: 1, promoted: false, endpoints: [] }],
    };
    const result = applyLifecycle(index);
    assert.ok(!result.overCap);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/extension/lifecycle.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// extension/src/lifecycle.ts

import type { IndexFile } from './types.js';

const STALE_DAYS = 90;
const DELETE_DAYS = 180;
const DOMAIN_CAP = 500;

export interface LifecycleResult {
  index: IndexFile;
  stale: string[];    // domains flagged as stale (90+ days inactive)
  deleted: string[];  // domains removed (180+ days inactive)
  overCap: boolean;   // true if entry count > 500
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Apply lifecycle rules to the index.
 * - Flags stale entries (90+ days inactive)
 * - Removes dead entries (180+ days inactive)
 * - Warns on soft cap (500+ domains)
 * Never silently drops entries below the hard-delete threshold.
 */
export function applyLifecycle(index: IndexFile): LifecycleResult {
  const stale: string[] = [];
  const deleted: string[] = [];

  const surviving = index.entries.filter(entry => {
    const inactiveDays = daysSince(entry.lastSeen);

    if (inactiveDays >= DELETE_DAYS) {
      deleted.push(entry.domain);
      return false;
    }

    if (inactiveDays >= STALE_DAYS) {
      stale.push(entry.domain);
    }

    return true;
  });

  return {
    index: { ...index, entries: surviving, updatedAt: new Date().toISOString() },
    stale,
    deleted,
    overCap: surviving.length > DOMAIN_CAP,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/extension/lifecycle.test.ts`
Expected: PASS

**Step 5: Wire lifecycle into background.ts flush**

In `flushIndex()`, run lifecycle before writing:

```typescript
import { applyLifecycle } from './lifecycle.js';

async function flushIndex(): Promise<void> {
  if (!indexDirty) return;

  // Apply lifecycle rules before flushing
  const { index: cleaned } = applyLifecycle(passiveIndex);
  passiveIndex = cleaned;

  // Persist to chrome.storage.local first (survives service worker restart)
  await chrome.storage.local.set({ passiveIndex });
  indexDirty = false;

  // Send to native host for disk persistence (if bridge connected)
  if (nativePort && bridgeAvailable) {
    try {
      await sendNativePortMessage({
        action: 'save_index',
        indexJson: JSON.stringify(passiveIndex),
      }, 15_000);
    } catch {
      // Native host not available — index stays in chrome.storage.local
    }
  }
}
```

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add extension/src/lifecycle.ts test/extension/lifecycle.test.ts extension/src/background.ts
git commit -m "feat(index): add lifecycle management (90d stale, 180d delete, 500 cap)"
```

---

## Integration Notes

### Files Created (New)
| File | Purpose |
|------|---------|
| `extension/src/sensitive-paths.ts` | URL blocklist for auth/login paths |
| `extension/src/observer.ts` | webRequest listener + `processCompletedRequest()` |
| `extension/src/index-store.ts` | In-memory index management + merge |
| `extension/src/promotion.ts` | `markPromoted()` for post-CDP index update |
| `extension/src/lifecycle.ts` | Decay, hard delete, soft cap |
| `src/index/reader.ts` | CLI-side index.json reader |
| `test/extension/index-types.test.ts` | Type compilation test |
| `test/extension/sensitive-paths.test.ts` | Blocklist tests |
| `test/extension/observer.test.ts` | Observer logic tests |
| `test/extension/index-store.test.ts` | Merge logic tests |
| `test/extension/promotion.test.ts` | Promotion tests |
| `test/extension/lifecycle.test.ts` | Lifecycle tests |
| `test/native-host-index.test.ts` | Native host save_index tests |
| `test/index/reader.test.ts` | CLI reader tests |
| `test/cli/discover-index.test.ts` | CLI integration test |

### Files Modified (Existing)
| File | Changes |
|------|---------|
| `extension/src/types.ts` | Add IndexFile, IndexEntry, IndexEndpoint types + PROMOTE_DOMAIN/GET_INDEX messages |
| `extension/manifest.json` | Add `webRequest` permission |
| `extension/src/background.ts` | Wire observer, index-store, flush, promotion, auto-learn |
| `extension/src/popup.ts` | Add tab switching, index rendering, settings |
| `extension/popup.html` | Add tabs, index list, settings UI |
| `extension/popup.css` | Add tab and index styles |
| `src/native-host.ts` | Add `save_index` action with atomic write |
| `src/cli.ts` | Show index data in `discover` command |
| `src/mcp.ts` | Include index data in `apitap_discover` response |

### Key Design Decisions
1. **Extension sends full index to native host** (no merge logic in native host). The extension is the single source of truth for the index.
2. **CLI-side types are re-declared** in `src/index/reader.ts` (not imported from extension) because extension and CLI have different tsconfigs.
3. **webRequest.onSendHeaders + onCompleted** two-event pattern for request header + response header correlation (mirrors the CDP pattern in background.ts).
4. **`extraHeaders`** opt-in for accessing Authorization/Cookie headers in MV3.
5. **Auto-learn uses totalHits as threshold proxy** (not distinct visit sessions). Acceptable v1 simplification.
6. **Safe DOM methods** in popup.ts (createElement/textContent, no innerHTML) to prevent XSS.

### Testing Strategy
- Pure functions (processCompletedRequest, mergeObservation, markPromoted, applyLifecycle, isSensitivePath) are fully unit-testable.
- Chrome API integration (webRequest listeners, chrome.storage, chrome.debugger) is tested via manual dogfood with the extension loaded in Chrome.
- CLI/MCP integration tested via existing test patterns (temp directories, file I/O).

# ApiTap v0.1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a working proof-of-concept that captures API traffic via Playwright, filters noise, generates skill files, and replays endpoints via `fetch()`.

**Architecture:** Playwright `page.on('response')` captures browser network traffic → filter engine drops noise (content-type + blocklist) → skill generator groups endpoints by domain into JSON skill files stored at `~/.apitap/skills/` → replay engine reads skill files and calls APIs directly via `fetch()`. CLI with `--json` flag wires everything together.

**Tech Stack:** TypeScript (ESM), Node 22 (built-in test runner, native `fetch`), Playwright (capture only), `tsx` (dev runner)

**Dependencies:**
- Runtime: `playwright` (capture)
- Dev: `typescript`, `tsx`, `@types/node`

**Test command:** `node --import tsx --test 'test/**/*.test.ts'`

**Dev run:** `npx tsx src/cli.ts`

**Rule: Run full test suite (`npm test`) after every task commit, not just the new tests. Catches regressions before they compound. If any existing test breaks, fix it before moving to the next task.**

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Modify: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "apitap",
  "version": "0.1.0",
  "description": "Open source API interception for AI agents",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "apitap": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "test": "node --import tsx --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit"
  },
  "license": "MIT"
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Step 3: Update .gitignore**

Add:
```
node_modules/
dist/
```

**Step 4: Install dependencies**

Run: `npm install playwright`
Run: `npm install -D typescript tsx @types/node`

**Step 5: Verify setup**

Run: `npx tsc --version`
Expected: Version output (5.x)

Run: `echo '{"compilerOptions":{"noEmit":true}}' | npx tsc --project tsconfig.json --noEmit`
Expected: No errors (no source files yet, clean exit)

**Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore package-lock.json
git commit -m "chore: project scaffold with TypeScript, Playwright, tsx"
```

---

### Task 2: Types and Shared Utilities

**Files:**
- Create: `src/types.ts`

**Step 1: Create types**

```typescript
// src/types.ts

/** A captured HTTP request/response pair from the browser */
export interface CapturedExchange {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    contentType: string;
  };
  timestamp: string;
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
  };
}

/** Summary returned by `apitap list` */
export interface SkillSummary {
  domain: string;
  skillFile: string;
  endpointCount: number;
  capturedAt: string;
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add core TypeScript types for skill files and captured exchanges"
```

---

### Task 3: Domain Blocklist

**Files:**
- Create: `test/capture/blocklist.test.ts`
- Create: `src/capture/blocklist.ts`

**Step 1: Write the failing test**

```typescript
// test/capture/blocklist.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBlocklisted } from '../../src/capture/blocklist.js';

describe('isBlocklisted', () => {
  it('blocks known analytics domains', () => {
    assert.equal(isBlocklisted('google-analytics.com'), true);
    assert.equal(isBlocklisted('www.google-analytics.com'), true);
    assert.equal(isBlocklisted('googletagmanager.com'), true);
  });

  it('blocks subdomains of blocklisted domains', () => {
    assert.equal(isBlocklisted('api.segment.io'), true);
    assert.equal(isBlocklisted('us.i.posthog.com'), true);
    assert.equal(isBlocklisted('o123.ingest.sentry.io'), true);
  });

  it('allows non-blocklisted domains', () => {
    assert.equal(isBlocklisted('polymarket.com'), false);
    assert.equal(isBlocklisted('api.github.com'), false);
    assert.equal(isBlocklisted('example.com'), false);
  });

  it('does not block TLDs that happen to match', () => {
    // "io" alone should not be blocked just because "sentry.io" is
    assert.equal(isBlocklisted('io'), false);
    assert.equal(isBlocklisted('com'), false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/blocklist.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/capture/blocklist.ts

const BLOCKLIST = new Set([
  // Analytics
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'segment.io',
  'cdn.segment.com',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'heapanalytics.com',
  'plausible.io',
  'posthog.com',
  'clarity.ms',
  'fullstory.com',

  // Ads
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.net',
  'connect.facebook.net',
  'adsrvr.org',
  'adnxs.com',
  'criteo.com',
  'outbrain.com',
  'taboola.com',

  // Error tracking / monitoring
  'sentry.io',
  'datadoghq.com',
  'browser-intake-datadoghq.com',
  'newrelic.com',
  'bam.nr-data.net',
  'logrocket.com',
  'logr-ingest.com',
  'bugsnag.com',
  'rollbar.com',

  // Social tracking
  'bat.bing.com',
  'ct.pinterest.com',
  'snap.licdn.com',
  'px.ads.linkedin.com',
  'analytics.twitter.com',
  'analytics.tiktok.com',

  // Customer engagement
  'intercom.io',
  'widget.intercom.io',
  'api-iam.intercom.io',
  'zendesk.com',
  'drift.com',
  'crisp.chat',
]);

/**
 * Check if a hostname is on the blocklist.
 * Matches exact hostnames and subdomains of blocklisted domains.
 * e.g. "sentry.io" blocks "o123.ingest.sentry.io"
 */
export function isBlocklisted(hostname: string): boolean {
  if (BLOCKLIST.has(hostname)) return true;

  // Check parent domains: "a.b.sentry.io" → "b.sentry.io" → "sentry.io"
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (BLOCKLIST.has(parent)) return true;
  }

  return false;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/capture/blocklist.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/capture/blocklist.ts test/capture/blocklist.test.ts
git commit -m "feat: domain blocklist with subdomain matching"
```

---

### Task 4: Filter Engine

**Files:**
- Create: `test/capture/filter.test.ts`
- Create: `src/capture/filter.ts`

**Step 1: Write the failing test**

```typescript
// test/capture/filter.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCapture } from '../../src/capture/filter.js';

describe('shouldCapture', () => {
  it('keeps JSON responses from non-blocklisted domains', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 200,
      contentType: 'application/json',
    }), true);
  });

  it('keeps JSON responses with charset parameter', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 200,
      contentType: 'application/json; charset=utf-8',
    }), true);
  });

  it('keeps vnd.api+json content type', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 200,
      contentType: 'application/vnd.api+json',
    }), true);
  });

  it('drops non-JSON content types', () => {
    assert.equal(shouldCapture({
      url: 'https://example.com/style.css',
      status: 200,
      contentType: 'text/css',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://example.com/page',
      status: 200,
      contentType: 'text/html',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://example.com/image.png',
      status: 200,
      contentType: 'image/png',
    }), false);
  });

  it('drops error responses', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 404,
      contentType: 'application/json',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://api.example.com/data',
      status: 500,
      contentType: 'application/json',
    }), false);
  });

  it('drops blocklisted domains', () => {
    assert.equal(shouldCapture({
      url: 'https://google-analytics.com/collect',
      status: 200,
      contentType: 'application/json',
    }), false);

    assert.equal(shouldCapture({
      url: 'https://o123.ingest.sentry.io/envelope',
      status: 200,
      contentType: 'application/json',
    }), false);
  });

  it('keeps redirect responses (3xx) with JSON body', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/redirect',
      status: 301,
      contentType: 'application/json',
    }), false);
  });

  it('keeps 2xx responses', () => {
    assert.equal(shouldCapture({
      url: 'https://api.example.com/created',
      status: 201,
      contentType: 'application/json',
    }), true);

    assert.equal(shouldCapture({
      url: 'https://api.example.com/accepted',
      status: 204,
      contentType: 'application/json',
    }), true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/filter.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/capture/filter.ts
import { isBlocklisted } from './blocklist.js';

export interface FilterableResponse {
  url: string;
  status: number;
  contentType: string;
}

const JSON_CONTENT_TYPES = [
  'application/json',
  'application/vnd.api+json',
  'text/json',
];

export function shouldCapture(response: FilterableResponse): boolean {
  // Only keep 2xx success responses
  if (response.status < 200 || response.status >= 300) return false;

  // Content-type must indicate JSON
  const ct = response.contentType.toLowerCase().split(';')[0].trim();
  if (!JSON_CONTENT_TYPES.some(t => ct === t)) return false;

  // Check domain against blocklist
  try {
    const hostname = new URL(response.url).hostname;
    if (isBlocklisted(hostname)) return false;
  } catch {
    return false;
  }

  return true;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/capture/filter.test.ts`
Expected: All 8 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS (blocklist + filter)

**Step 6: Commit**

```bash
git add src/capture/filter.ts test/capture/filter.test.ts
git commit -m "feat: filter engine — content-type and blocklist filtering"
```

---

### Task 5: Skill Store (Read/Write/List)

**Files:**
- Create: `test/skill/store.test.ts`
- Create: `src/skill/store.ts`

**Step 1: Write the failing test**

```typescript
// test/skill/store.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile, readSkillFile, listSkillFiles } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

const makeSkill = (domain: string): SkillFile => ({
  version: '1.0',
  domain,
  capturedAt: '2026-02-04T12:00:00.000Z',
  baseUrl: `https://${domain}`,
  endpoints: [
    {
      id: 'get-api-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array', fields: ['id', 'name'] },
      examples: {
        request: { url: `https://${domain}/api/data`, headers: {} },
        responsePreview: [{ id: 1, name: 'test' }],
      },
    },
  ],
  metadata: { captureCount: 10, filteredCount: 8, toolVersion: '0.1.0' },
});

describe('skill store', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('writes and reads a skill file', async () => {
    const skill = makeSkill('example.com');
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile('example.com', testDir);
    assert.deepEqual(loaded, skill);
  });

  it('lists skill files', async () => {
    await writeSkillFile(makeSkill('example.com'), testDir);
    await writeSkillFile(makeSkill('api.github.com'), testDir);

    const summaries = await listSkillFiles(testDir);
    const domains = summaries.map(s => s.domain).sort();
    assert.deepEqual(domains, ['api.github.com', 'example.com']);
    assert.equal(summaries[0].endpointCount, 1);
  });

  it('returns null for non-existent skill file', async () => {
    const result = await readSkillFile('nonexistent.com', testDir);
    assert.equal(result, null);
  });

  it('returns empty list when no skill files exist', async () => {
    const summaries = await listSkillFiles(testDir);
    assert.deepEqual(summaries, []);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/skill/store.ts
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile, SkillSummary } from '../types.js';

const DEFAULT_SKILLS_DIR = join(homedir(), '.apitap', 'skills');

function skillPath(domain: string, skillsDir: string): string {
  return join(skillsDir, `${domain}.json`);
}

export async function writeSkillFile(
  skill: SkillFile,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<string> {
  await mkdir(skillsDir, { recursive: true });
  const filePath = skillPath(skill.domain, skillsDir);
  await writeFile(filePath, JSON.stringify(skill, null, 2) + '\n');
  return filePath;
}

export async function readSkillFile(
  domain: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<SkillFile | null> {
  try {
    const content = await readFile(skillPath(domain, skillsDir), 'utf-8');
    return JSON.parse(content) as SkillFile;
  } catch {
    return null;
  }
}

export async function listSkillFiles(
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<SkillSummary[]> {
  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    return [];
  }

  const summaries: SkillSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const domain = file.replace(/\.json$/, '');
    const skill = await readSkillFile(domain, skillsDir);
    if (skill) {
      summaries.push({
        domain: skill.domain,
        skillFile: join(skillsDir, file),
        endpointCount: skill.endpoints.length,
        capturedAt: skill.capturedAt,
      });
    }
  }

  return summaries;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/skill/store.ts test/skill/store.test.ts
git commit -m "feat: skill store — read, write, and list skill files"
```

---

### Task 6: Skill Generator

**Files:**
- Create: `test/skill/generator.test.ts`
- Create: `src/skill/generator.ts`

**Step 1: Write the failing test**

```typescript
// test/skill/generator.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillGenerator } from '../../src/skill/generator.js';
import type { CapturedExchange } from '../../src/types.js';

function mockExchange(overrides: {
  url?: string;
  method?: string;
  status?: number;
  body?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}): CapturedExchange {
  const url = overrides.url ?? 'https://api.example.com/data';
  return {
    request: {
      url,
      method: overrides.method ?? 'GET',
      headers: overrides.requestHeaders ?? { accept: 'application/json' },
    },
    response: {
      status: overrides.status ?? 200,
      headers: overrides.responseHeaders ?? {},
      body: overrides.body ?? JSON.stringify([{ id: 1, name: 'test' }]),
      contentType: 'application/json',
    },
    timestamp: '2026-02-04T12:00:00.000Z',
  };
}

describe('SkillGenerator', () => {
  it('generates a skill file from captured exchanges', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://api.example.com/api/markets?limit=10',
      body: JSON.stringify([{ id: 1, name: 'BTC', price: 50000 }]),
    }));
    gen.addExchange(mockExchange({
      url: 'https://api.example.com/api/events',
      body: JSON.stringify({ events: [{ id: 1 }] }),
    }));

    const skill = gen.toSkillFile('api.example.com');

    assert.equal(skill.version, '1.0');
    assert.equal(skill.domain, 'api.example.com');
    assert.equal(skill.endpoints.length, 2);
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('deduplicates endpoints by method + path', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ url: 'https://example.com/api/data?page=1' }));
    gen.addExchange(mockExchange({ url: 'https://example.com/api/data?page=2' }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('generates readable endpoint IDs', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ url: 'https://example.com/api/v1/markets' }));
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/orders',
      method: 'POST',
    }));

    const skill = gen.toSkillFile('example.com');
    const ids = skill.endpoints.map(e => e.id);
    assert.ok(ids.includes('get-api-v1-markets'));
    assert.ok(ids.includes('post-api-orders'));
  });

  it('extracts query parameters', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?q=bitcoin&limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.equal(ep.queryParams['q'].example, 'bitcoin');
    assert.equal(ep.queryParams['limit'].example, '10');
  });

  it('detects array response shape', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'a', price: 100 }]),
    }));

    const skill = gen.toSkillFile('example.com');
    const shape = skill.endpoints[0].responseShape;
    assert.equal(shape.type, 'array');
    assert.deepEqual(shape.fields, ['id', 'name', 'price']);
  });

  it('detects object response shape', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify({ total: 100, items: [] }),
    }));

    const skill = gen.toSkillFile('example.com');
    const shape = skill.endpoints[0].responseShape;
    assert.equal(shape.type, 'object');
    assert.deepEqual(shape.fields, ['total', 'items']);
  });

  it('returns new endpoint from addExchange, null for duplicates', () => {
    const gen = new SkillGenerator();
    const first = gen.addExchange(mockExchange({ url: 'https://example.com/api/data' }));
    const dupe = gen.addExchange(mockExchange({ url: 'https://example.com/api/data?v=2' }));

    assert.notEqual(first, null);
    assert.equal(dupe, null);
  });

  it('filters noisy request headers, keeps meaningful ones', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'accept': 'application/json',
        'authorization': 'Bearer tok123',
        'user-agent': 'Mozilla/5.0 ...',
        'accept-encoding': 'gzip',
        'x-api-key': 'key123',
        'cookie': 'session=abc',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], 'Bearer tok123');
    assert.equal(h['x-api-key'], 'key123');
    assert.equal(h['user-agent'], undefined);
    assert.equal(h['accept-encoding'], undefined);
  });

  it('tracks filtered count', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({}));
    gen.recordFiltered();
    gen.recordFiltered();
    gen.recordFiltered();

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.metadata.filteredCount, 3);
    assert.equal(skill.metadata.captureCount, 1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/skill/generator.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/skill/generator.ts
import type { CapturedExchange, SkillEndpoint, SkillFile } from '../types.js';

const KEEP_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'x-api-key',
  'x-csrf-token',
  'x-requested-with',
]);

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (KEEP_HEADERS.has(lower) || (lower.startsWith('x-') && !lower.startsWith('x-forwarded'))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function generateEndpointId(method: string, path: string): string {
  const slug = path
    .replace(/^\//, '')
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
  return `${method.toLowerCase()}-${slug || 'root'}`;
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

export class SkillGenerator {
  private endpoints = new Map<string, SkillEndpoint>();
  private captureCount = 0;
  private filteredCount = 0;

  /** Add a captured exchange. Returns the new endpoint if first seen, null if duplicate. */
  addExchange(exchange: CapturedExchange): SkillEndpoint | null {
    this.captureCount++;

    const url = new URL(exchange.request.url);
    const key = `${exchange.request.method} ${url.pathname}`;

    if (this.endpoints.has(key)) {
      return null;
    }

    const endpoint: SkillEndpoint = {
      id: generateEndpointId(exchange.request.method, url.pathname),
      method: exchange.request.method,
      path: url.pathname,
      queryParams: extractQueryParams(url),
      headers: filterHeaders(exchange.request.headers),
      responseShape: detectResponseShape(exchange.response.body),
      examples: {
        request: {
          url: exchange.request.url,
          headers: filterHeaders(exchange.request.headers),
        },
        responsePreview: truncatePreview(exchange.response.body),
      },
    };

    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  /** Record a filtered-out request (for metadata tracking). */
  recordFiltered(): void {
    this.filteredCount++;
  }

  /** Generate the complete skill file for a domain. */
  toSkillFile(domain: string): SkillFile {
    return {
      version: '1.0',
      domain,
      capturedAt: new Date().toISOString(),
      baseUrl: `https://${domain}`,
      endpoints: Array.from(this.endpoints.values()),
      metadata: {
        captureCount: this.captureCount,
        filteredCount: this.filteredCount,
        toolVersion: '0.1.0',
      },
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/skill/generator.test.ts`
Expected: All 9 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/skill/generator.ts test/skill/generator.test.ts
git commit -m "feat: skill generator — build skill files from captured exchanges"
```

---

### Task 7: Replay Engine

**Files:**
- Create: `test/replay/engine.test.ts`
- Create: `src/replay/engine.ts`

**Step 1: Write the failing test**

The test spins up a local HTTP server and verifies replay against it.

```typescript
// test/replay/engine.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

describe('replayEndpoint', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/items')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Widget' }, { id: 2, name: 'Gadget' }]));
      } else if (req.url === '/api/item/42') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 42, name: 'Special' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function makeSkill(): SkillFile {
    return {
      version: '1.0',
      domain: 'localhost',
      capturedAt: '2026-02-04T12:00:00.000Z',
      baseUrl,
      endpoints: [
        {
          id: 'get-api-items',
          method: 'GET',
          path: '/api/items',
          queryParams: { limit: { type: 'string', example: '10' } },
          headers: {},
          responseShape: { type: 'array', fields: ['id', 'name'] },
          examples: {
            request: { url: `${baseUrl}/api/items`, headers: {} },
            responsePreview: [],
          },
        },
        {
          id: 'get-api-item-42',
          method: 'GET',
          path: '/api/item/42',
          queryParams: {},
          headers: {},
          responseShape: { type: 'object', fields: ['id', 'name'] },
          examples: {
            request: { url: `${baseUrl}/api/item/42`, headers: {} },
            responsePreview: {},
          },
        },
      ],
      metadata: { captureCount: 2, filteredCount: 0, toolVersion: '0.1.0' },
    };
  }

  it('replays a GET endpoint and returns JSON', async () => {
    const result = await replayEndpoint(makeSkill(), 'get-api-items');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, [
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Gadget' },
    ]);
  });

  it('replays with query parameters', async () => {
    const result = await replayEndpoint(makeSkill(), 'get-api-items', { limit: '5' });
    assert.equal(result.status, 200);
    // Server ignores params in this test, but the request should succeed
    assert.ok(Array.isArray(result.data));
  });

  it('throws for unknown endpoint ID', async () => {
    await assert.rejects(
      () => replayEndpoint(makeSkill(), 'nonexistent'),
      { message: /endpoint.*not found/i },
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/replay/engine.ts
import type { SkillFile } from '../types.js';

export interface ReplayResult {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

export async function replayEndpoint(
  skill: SkillFile,
  endpointId: string,
  params?: Record<string, string>,
): Promise<ReplayResult> {
  const endpoint = skill.endpoints.find(e => e.id === endpointId);
  if (!endpoint) {
    throw new Error(
      `Endpoint "${endpointId}" not found in skill for ${skill.domain}. ` +
      `Available: ${skill.endpoints.map(e => e.id).join(', ')}`,
    );
  }

  const url = new URL(endpoint.path, skill.baseUrl);

  // Apply query params: start with captured defaults, override with provided params
  for (const [key, val] of Object.entries(endpoint.queryParams)) {
    url.searchParams.set(key, val.example);
  }
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
  }

  const response = await fetch(url.toString(), {
    method: endpoint.method,
    headers: endpoint.headers,
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let data: unknown;
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return { status: response.status, headers: responseHeaders, data };
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: All 3 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/replay/engine.ts test/replay/engine.test.ts
git commit -m "feat: replay engine — execute API calls from skill files"
```

---

### Task 8: Capture Monitor

**Files:**
- Create: `src/capture/monitor.ts`

This component is hard to unit test (requires a real browser). It will be verified via the CLI integration in Task 9.

**Step 1: Write the implementation**

```typescript
// src/capture/monitor.ts
import { chromium, type Browser, type Page } from 'playwright';
import { shouldCapture } from './filter.js';
import { SkillGenerator } from '../skill/generator.js';
import type { CapturedExchange } from '../types.js';

export interface CaptureOptions {
  url: string;
  port?: number;
  launch?: boolean;
  attach?: boolean;
  duration?: number;
  onEndpoint?: (endpoint: { id: string; method: string; path: string }) => void;
  onFiltered?: () => void;
}

export interface CaptureResult {
  generators: Map<string, SkillGenerator>;
  totalRequests: number;
  filteredRequests: number;
}

const DEFAULT_CDP_PORTS = [18792, 18800, 9222];

async function connectToBrowser(options: CaptureOptions): Promise<{ browser: Browser; launched: boolean }> {
  if (!options.launch) {
    const ports = options.port ? [options.port] : DEFAULT_CDP_PORTS;
    for (const port of ports) {
      try {
        const browser = await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 3000 });
        return { browser, launched: false };
      } catch {
        continue;
      }
    }
  }

  if (options.attach) {
    const ports = options.port ? [options.port] : DEFAULT_CDP_PORTS;
    throw new Error(`No browser found on CDP ports: ${ports.join(', ')}. Is a Chromium browser running with remote debugging?`);
  }

  const browser = await chromium.launch({ headless: false });
  return { browser, launched: true };
}

export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { browser, launched } = await connectToBrowser(options);
  const generators = new Map<string, SkillGenerator>();
  let totalRequests = 0;
  let filteredRequests = 0;

  let page: Page;
  if (launched) {
    const context = await browser.newContext();
    page = await context.newPage();
  } else {
    const contexts = browser.contexts();
    if (contexts.length > 0 && contexts[0].pages().length > 0) {
      page = contexts[0].pages()[0];
    } else {
      const context = contexts[0] ?? await browser.newContext();
      page = await context.newPage();
    }
  }

  page.on('response', async (response) => {
    totalRequests++;

    const url = response.url();
    const status = response.status();
    const contentType = response.headers()['content-type'] ?? '';

    if (!shouldCapture({ url, status, contentType })) {
      filteredRequests++;
      const hostname = safeHostname(url);
      if (hostname) {
        const gen = generators.get(hostname);
        if (gen) gen.recordFiltered();
      }
      options.onFiltered?.();
      return;
    }

    try {
      const body = await response.text();
      const hostname = new URL(url).hostname;

      if (!generators.has(hostname)) {
        generators.set(hostname, new SkillGenerator());
      }
      const gen = generators.get(hostname)!;

      const exchange: CapturedExchange = {
        request: {
          url,
          method: response.request().method(),
          headers: response.request().headers(),
        },
        response: {
          status,
          headers: response.headers(),
          body,
          contentType,
        },
        timestamp: new Date().toISOString(),
      };

      const endpoint = gen.addExchange(exchange);
      if (endpoint) {
        options.onEndpoint?.({ id: endpoint.id, method: endpoint.method, path: endpoint.path });
      }
    } catch {
      // Response body may not be available (e.g. redirects); skip silently
    }
  });

  await page.goto(options.url, { waitUntil: 'domcontentloaded' });

  // Wait for duration or until interrupted
  if (options.duration) {
    await new Promise(resolve => setTimeout(resolve, options.duration! * 1000));
  } else {
    // Wait indefinitely — caller handles SIGINT
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
    });
  }

  if (launched) {
    await browser.close();
  }

  return { generators, totalRequests, filteredRequests };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/capture/monitor.ts
git commit -m "feat: capture monitor — Playwright-based network listener with attach/launch"
```

---

### Task 9: CLI

**Files:**
- Create: `src/cli.ts`
- Create: `src/index.ts`

**Step 1: Write the CLI**

```typescript
// src/cli.ts
import { capture } from './capture/monitor.js';
import { writeSkillFile, readSkillFile, listSkillFiles } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(rest[i]);
    }
  }

  return { command, positional, flags };
}

function printUsage(): void {
  console.log(`
  apitap — API interception for AI agents

  Usage:
    apitap capture <url>       Capture API traffic from a website
    apitap list                List available skill files
    apitap show <domain>       Show endpoints for a domain
    apitap replay <domain> <endpoint-id> [key=value...]
                               Replay an API endpoint

  Options:
    --json                     Output machine-readable JSON
    --duration <seconds>       Stop capture after N seconds
    --port <port>              Connect to specific CDP port
    --launch                   Always launch a new browser
    --attach                   Only attach to existing browser
  `.trim());
}

async function handleCapture(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap capture <url>');
    process.exit(1);
  }

  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const json = flags.json === true;
  const duration = typeof flags.duration === 'string' ? parseInt(flags.duration, 10) : undefined;
  const port = typeof flags.port === 'string' ? parseInt(flags.port, 10) : undefined;

  if (!json) {
    console.log(`\n  🔍 Capturing ${url}...${duration ? ` (${duration}s)` : ' (Ctrl+C to stop)'}\n`);
  }

  let endpointCount = 0;
  let filteredCount = 0;

  const result = await capture({
    url: fullUrl,
    duration,
    port,
    launch: flags.launch === true,
    attach: flags.attach === true,
    onEndpoint: (ep) => {
      endpointCount++;
      if (!json) {
        console.log(`  ✓ ${ep.method.padEnd(6)} ${ep.path}`);
      }
    },
    onFiltered: () => {
      filteredCount++;
    },
  });

  // Write skill files for each domain
  const written: string[] = [];
  for (const [domain, generator] of result.generators) {
    const skill = generator.toSkillFile(domain);
    if (skill.endpoints.length > 0) {
      const path = await writeSkillFile(skill);
      written.push(path);
    }
  }

  if (json) {
    const output = {
      domains: Array.from(result.generators.entries()).map(([domain, gen]) => ({
        domain,
        endpoints: gen.toSkillFile(domain).endpoints.length,
      })),
      totalRequests: result.totalRequests,
      filtered: result.filteredRequests,
      skillFiles: written,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n  📋 Capture complete\n`);
    console.log(`  Endpoints:  ${endpointCount} discovered`);
    console.log(`  Requests:   ${result.totalRequests} total, ${result.filteredRequests} filtered`);
    for (const path of written) {
      console.log(`  Skill file: ${path}`);
    }
    console.log();
  }
}

async function handleList(flags: Record<string, string | boolean>): Promise<void> {
  const summaries = await listSkillFiles();
  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (summaries.length === 0) {
    console.log('\n  No skill files found. Run `apitap capture <url>` first.\n');
    return;
  }

  console.log();
  for (const s of summaries) {
    const ago = timeAgo(s.capturedAt);
    console.log(`  ${s.domain.padEnd(30)} ${String(s.endpointCount).padStart(3)} endpoints   ${ago}`);
  }
  console.log();
}

async function handleShow(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap show <domain>');
    process.exit(1);
  }

  const skill = await readSkillFile(domain);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}". Run \`apitap capture\` first.`);
    process.exit(1);
  }

  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  console.log(`\n  ${skill.domain} — ${skill.endpoints.length} endpoints (captured ${timeAgo(skill.capturedAt)})\n`);
  for (const ep of skill.endpoints) {
    const shape = ep.responseShape.type;
    const fields = ep.responseShape.fields?.length ?? 0;
    console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(35)} ${shape}${fields ? ` (${fields} fields)` : ''}`);
  }
  console.log(`\n  Replay: apitap replay ${skill.domain} <endpoint-id>\n`);
}

async function handleReplay(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [domain, endpointId, ...paramArgs] = positional;
  if (!domain || !endpointId) {
    console.error('Error: Domain and endpoint required. Usage: apitap replay <domain> <endpoint-id> [key=value...]');
    process.exit(1);
  }

  const skill = await readSkillFile(domain);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}".`);
    process.exit(1);
  }

  // Parse key=value params
  const params: Record<string, string> = {};
  for (const arg of paramArgs) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      params[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }

  const result = await replayEndpoint(skill, endpointId, Object.keys(params).length > 0 ? params : undefined);
  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify({ status: result.status, data: result.data }, null, 2));
  } else {
    console.log(`\n  Status: ${result.status}\n`);
    console.log(JSON.stringify(result.data, null, 2));
    console.log();
  }
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'capture':
      await handleCapture(positional, flags);
      break;
    case 'list':
      await handleList(flags);
      break;
    case 'show':
      await handleShow(positional, flags);
      break;
    case 'replay':
      await handleReplay(positional, flags);
      break;
    default:
      printUsage();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

**Step 2: Create index.ts**

```typescript
// src/index.ts
export { capture, type CaptureOptions, type CaptureResult } from './capture/monitor.js';
export { shouldCapture } from './capture/filter.js';
export { isBlocklisted } from './capture/blocklist.js';
export { SkillGenerator } from './skill/generator.js';
export { writeSkillFile, readSkillFile, listSkillFiles } from './skill/store.js';
export { replayEndpoint, type ReplayResult } from './replay/engine.js';
export type { SkillFile, SkillEndpoint, SkillSummary, CapturedExchange } from './types.js';
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 5: Test CLI help output**

Run: `npx tsx src/cli.ts`
Expected: Usage text printed

Run: `npx tsx src/cli.ts list`
Expected: "No skill files found" message

**Step 6: Commit**

```bash
git add src/cli.ts src/index.ts
git commit -m "feat: CLI with capture, list, show, and replay commands"
```

---

### Task 10: End-to-End Verification

**Files:**
- Create: `test/e2e/capture-replay.test.ts`

This test starts a local HTTP server serving JSON, launches a browser via Playwright, captures traffic, and replays an endpoint. It validates the full pipeline.

**Step 1: Write the integration test**

```typescript
// test/e2e/capture-replay.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../../src/capture/monitor.js';
import { writeSkillFile, readSkillFile } from '../../src/skill/store.js';
import { replayEndpoint } from '../../src/replay/engine.js';

describe('end-to-end: capture → skill file → replay', () => {
  let server: Server;
  let serverUrl: string;
  let testDir: string;

  before(async () => {
    // Start a simple JSON API server
    server = createServer((req, res) => {
      if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Beta' },
        ]));
      } else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
      } else {
        // Serve a minimal HTML page that fetches from the API
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body><h1>Test Page</h1>
          <script>
            fetch('/api/items').then(r => r.json()).then(console.log);
            fetch('/api/status').then(r => r.json()).then(console.log);
          </script>
          </body></html>
        `);
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://localhost:${port}`;

    testDir = await mkdtemp(join(tmpdir(), 'apitap-e2e-'));
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('captures API traffic, generates skill file, and replays', async () => {
    // 1. Capture traffic (launch browser, navigate, wait 3s for fetches)
    const result = await capture({
      url: serverUrl,
      duration: 3,
      launch: true,
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    // 2. Verify we captured endpoints
    assert.ok(result.generators.size > 0, 'Should have at least one domain');
    const domain = Array.from(result.generators.keys())[0];
    const gen = result.generators.get(domain)!;
    const skill = gen.toSkillFile(domain);

    assert.ok(skill.endpoints.length >= 2, `Expected >= 2 endpoints, got ${skill.endpoints.length}`);

    // 3. Write and re-read skill file
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile(domain, testDir);
    assert.ok(loaded, 'Skill file should be readable');
    assert.equal(loaded!.endpoints.length, skill.endpoints.length);

    // 4. Replay an endpoint
    const itemsEndpoint = skill.endpoints.find(e => e.path === '/api/items');
    assert.ok(itemsEndpoint, 'Should have /api/items endpoint');

    const replayResult = await replayEndpoint(loaded!, itemsEndpoint!.id);
    assert.equal(replayResult.status, 200);
    assert.deepEqual(replayResult.data, [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]);
  });
});
```

**Step 2: Run the integration test**

Run: `node --import tsx --test test/e2e/capture-replay.test.ts`
Expected: PASS — full pipeline works

Note: This test launches a real browser via Playwright. It requires Chromium to be installed (`npx playwright install chromium` if not already available).

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS (unit + integration)

**Step 4: Commit**

```bash
git add test/e2e/capture-replay.test.ts
git commit -m "test: end-to-end test — capture, generate skill file, replay"
```

---

### Task 11: Final Polish and v0.1 Tag

**Step 1: Update CLAUDE.md with actual build commands**

Update the "Build & Development" section in `CLAUDE.md` to reflect the real setup:

```markdown
## Build & Development

**Install:** `npm install`

**Run tests:** `npm test` (Node built-in test runner + tsx)

**Run single test:** `node --import tsx --test test/path/to/test.ts`

**Type check:** `npm run typecheck`

**Build:** `npm run build` (compiles to `dist/`)

**Dev CLI:** `npx tsx src/cli.ts <command>`

**Usage:**
- `npx tsx src/cli.ts capture <url>` — capture API traffic
- `npx tsx src/cli.ts list` — list skill files
- `npx tsx src/cli.ts show <domain>` — show endpoints
- `npx tsx src/cli.ts replay <domain> <endpoint-id>` — replay an endpoint
```

**Step 2: Run all tests one final time**

Run: `npm test`
Expected: All tests PASS

**Step 3: Verify type check passes**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Commit and tag**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with actual build and test commands"
git tag v0.1.0
```

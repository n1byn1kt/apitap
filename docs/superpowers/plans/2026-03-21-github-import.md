# GitHub Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `apitap import --from github` with org scan and topic search discovery modes.

**Architecture:** New `src/skill/github.ts` module following the same pattern as `apis-guru.ts` and `swaggerhub.ts` — pure functions for GitHub API interaction, with a `handleGitHubImport()` CLI handler in `src/cli.ts`. Feeds into the existing `convertOpenAPISpec() → mergeSkillFile() → signSkillFile() → writeSkillFile()` pipeline unchanged.

**Tech Stack:** Node stdlib `fetch()` for GitHub API, `node:child_process` `execFileSync` for `gh` CLI token, `js-yaml` for YAML spec parsing. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-21-github-import-design.md`

**Key implementation notes from the user:**
- `importHistory` already stores `specUrl` via `importMeta` in `mergeSkillFile()` — no gap, `--update` works out of the box.
- Sequential code search queries for org scan is critical — the secondary rate limit (30/min) will break production if ignored.
- `normalizeSpecServerUrls()` mutates in place — add a code comment confirming the mutation is intentional.
- `--org` with no token must exit with a clear error, not attempt unauthenticated code search.

---

### File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/skill/github.ts` | Create | Token resolution, GitHub API helper, org scan, topic search, spec fetch, filters, template normalizer |
| `test/skill/github.test.ts` | Create | Unit tests for all pure functions in github.ts |
| `test/skill/github-integration.test.ts` | Create | Integration tests: full flows with mocked GitHub API |
| `src/cli.ts` | Modify | Add `handleGitHubImport()` handler + route from `handleImport()` |

---

### Task 1: Token Resolution + GitHub API Helper

**Files:**
- Create: `src/skill/github.ts`
- Create: `test/skill/github.test.ts`

- [ ] **Step 1: Write failing tests for `resolveGitHubToken()`**

```typescript
// test/skill/github.test.ts
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('resolveGitHubToken', () => {
  // Need to reset the module-level cache between tests.
  // Use dynamic import to get a fresh module each time.

  it('returns token from gh CLI when available', async () => {
    // Mock execFileSync to return a token
    // This test verifies the happy path: gh is installed and authed
  });

  it('falls back to GITHUB_TOKEN env var when gh fails', async () => {
    // Mock execFileSync to throw (gh not installed)
    // Set process.env.GITHUB_TOKEN = 'test-token-123'
    // Verify it returns 'test-token-123'
  });

  it('returns null and warns when neither gh nor env var available', async () => {
    // Mock execFileSync to throw
    // Unset GITHUB_TOKEN
    // Verify returns null
    // Verify stderr warning about rate limiting
  });

  it('caches result across calls', async () => {
    // Call twice, verify execFileSync only called once
  });

  it('--org mode errors when token is null', async () => {
    // This tests the CLI-level guard, not resolveGitHubToken itself
    // But the token resolution returning null is the precondition
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL — module does not exist yet

- [ ] **Step 2: Implement `resolveGitHubToken()` and `resetTokenCache()`**

```typescript
// src/skill/github.ts
import { execFileSync } from 'node:child_process';

let cachedToken: string | null | undefined; // undefined = not yet resolved

/** Reset token cache — for testing only. */
export function resetTokenCache(): void {
  cachedToken = undefined;
}

/**
 * Resolve a GitHub token. Tries gh CLI first, then GITHUB_TOKEN env var.
 * Caches the result (even null) for the session.
 */
export async function resolveGitHubToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;

  try {
    cachedToken = execFileSync('gh', ['auth', 'token'], { timeout: 2000 })
      .toString()
      .trim();
  } catch {
    cachedToken = process.env.GITHUB_TOKEN ?? null;
  }

  if (cachedToken === null) {
    console.error(
      "Warning: No GitHub token found — rate limited to 60 req/hr. Run 'gh auth login' or set GITHUB_TOKEN."
    );
  }

  return cachedToken;
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 3: Write failing tests for `githubFetch()`**

```typescript
describe('githubFetch', () => {
  it('sets correct headers with token', async () => {
    // Mock global fetch, verify Authorization, Accept, User-Agent headers
  });

  it('omits Authorization header when token is null', async () => {
    // Mock fetch, verify no Authorization header
  });

  it('parses rate limit headers from response', async () => {
    // Mock fetch with X-RateLimit-Remaining and X-RateLimit-Reset headers
    // Verify returned rateLimit object
  });

  it('throws on 403 rate limit with reset time', async () => {
    // Mock fetch returning 403 with rate limit headers
    // Verify error message includes reset time
  });

  it('throws on 422 with descriptive message', async () => {
    // Mock fetch returning 422
    // Verify error includes status code
  });

  it('respects 10MB size cap', async () => {
    // Mock fetch with Content-Length > 10MB
    // Verify throws
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL — `githubFetch` not implemented

- [ ] **Step 4: Implement `githubFetch()`**

```typescript
export interface RateLimit {
  remaining: number;
  limit: number;
  resetAt: Date;
}

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function githubFetch(
  path: string,
  token: string | null,
): Promise<{ data: any; rateLimit: RateLimit }> {
  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'apitap-import',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  // Parse rate limit before checking status
  const rateLimit: RateLimit = {
    remaining: parseInt(response.headers.get('x-ratelimit-remaining') ?? '0', 10),
    limit: parseInt(response.headers.get('x-ratelimit-limit') ?? '0', 10),
    resetAt: new Date(parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10) * 1000),
  };

  if (!response.ok) {
    if (response.status === 403 && rateLimit.remaining === 0) {
      const err = new Error(
        `GitHub API rate limit exhausted. Resets at ${rateLimit.resetAt.toLocaleTimeString()}.` +
        ` Run 'gh auth login' for higher limits.`
      );
      (err as any).status = 403;
      throw err;
    }
    const err = new Error(`GitHub API ${response.status} ${response.statusText} for ${path}`);
    (err as any).status = response.status;
    throw err;
  }

  // Size check
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error(`GitHub API response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_SIZE})`);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new Error(`GitHub API response body too large: ${text.length} bytes`);
  }

  return { data: JSON.parse(text), rateLimit };
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skill/github.ts test/skill/github.test.ts
git commit -m "feat(github): add token resolution and GitHub API helper"
```

---

### Task 2: Template Domain Normalizer + Content Filters

**Files:**
- Modify: `src/skill/github.ts`
- Modify: `test/skill/github.test.ts`

- [ ] **Step 1: Write failing tests for `normalizeTemplatedDomain()`**

```typescript
describe('normalizeTemplatedDomain', () => {
  it('strips single leading template segment', () => {
    assert.strictEqual(normalizeTemplatedDomain('{region}.sentry.io'), 'sentry.io');
  });

  it('strips multiple leading template segments', () => {
    assert.strictEqual(normalizeTemplatedDomain('{sub}.{site}.example.com'), 'example.com');
  });

  it('passes through non-templated domains unchanged', () => {
    assert.strictEqual(normalizeTemplatedDomain('api.example.com'), 'api.example.com');
  });

  it('handles malformed template without infinite loop', () => {
    assert.strictEqual(normalizeTemplatedDomain('{unclosed'), '{unclosed');
  });

  it('handles template without trailing dot', () => {
    // {region} with no dot after — should not loop forever
    assert.strictEqual(normalizeTemplatedDomain('{region}sentry.io'), '{region}sentry.io');
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL — function not exported

- [ ] **Step 2: Implement `normalizeTemplatedDomain()`**

```typescript
export function normalizeTemplatedDomain(domain: string): string {
  let d = domain;
  while (d.startsWith('{')) {
    const next = d.replace(/^\{[^}]+\}\./, '');
    if (next === d) break; // malformed template — stop
    d = next;
  }
  return d;
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 3: Write failing tests for `normalizeSpecServerUrls()`**

```typescript
describe('normalizeSpecServerUrls', () => {
  it('normalizes leading template in server URL', () => {
    const spec = { servers: [{ url: 'https://{region}.sentry.io/api/0' }] };
    // Intentional mutation of the raw spec before convertOpenAPISpec() consumes it
    normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://sentry.io/api/0');
  });

  it('does not modify non-templated URLs', () => {
    const spec = { servers: [{ url: 'https://api.example.com/v1' }] };
    normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://api.example.com/v1');
  });

  it('handles spec with no servers array', () => {
    const spec = { info: { title: 'Test' } };
    normalizeSpecServerUrls(spec as any);
    // Should not throw
  });

  it('handles URL that new URL() cannot parse', () => {
    // https://{region}.sentry.io fails new URL()
    const spec = { servers: [{ url: 'https://{region}.sentry.io/api' }] };
    normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://sentry.io/api');
  });

  it('handles multiple template segments', () => {
    const spec = { servers: [{ url: 'https://{sub}.{site}.example.com/v2' }] };
    normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://example.com/v2');
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement `normalizeSpecServerUrls()`**

```typescript
/**
 * Pre-process spec's server URLs to normalize templated domains.
 * Mutates the spec object in place — intentional, called before convertOpenAPISpec() consumes it.
 */
export function normalizeSpecServerUrls(spec: Record<string, any>): void {
  if (!spec.servers) return;
  for (const server of spec.servers) {
    if (!server.url || !server.url.includes('{')) continue;
    try {
      const url = new URL(server.url);
      url.hostname = normalizeTemplatedDomain(url.hostname);
      server.url = url.toString();
    } catch {
      // URL with leading template like https://{region}.sentry.io fails new URL()
      const match = server.url.match(/^(https?:\/\/)([^/]+)(.*)/);
      if (match) {
        const normalized = normalizeTemplatedDomain(match[2]);
        server.url = match[1] + normalized + match[3];
      }
    }
  }
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for `filterResults()` and `hasServerUrl()`**

```typescript
describe('filterResults', () => {
  const baseResult: GitHubSpecResult = {
    owner: 'cloudflare', repo: 'api-schemas', repoFullName: 'cloudflare/api-schemas',
    filePath: 'openapi.json', htmlUrl: 'https://github.com/cloudflare/api-schemas/blob/main/openapi.json',
    specUrl: 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json',
    stars: 100, isFork: false, isArchived: false,
    pushedAt: new Date().toISOString(), description: 'Cloudflare API schemas',
  };

  it('skips forks', () => {
    const results = [{ ...baseResult, isFork: true }];
    const { passed, skips } = filterResults(results, {});
    assert.strictEqual(passed.length, 0);
    assert.strictEqual(skips[0].reason, 'fork');
  });

  it('skips archived repos', () => {
    const results = [{ ...baseResult, isArchived: true }];
    const { passed, skips } = filterResults(results, {});
    assert.strictEqual(passed.length, 0);
    assert.strictEqual(skips[0].reason, 'archived');
  });

  it('skips stale repos (>3 years)', () => {
    const results = [{ ...baseResult, pushedAt: '2020-01-01T00:00:00Z' }];
    const { passed, skips } = filterResults(results, {});
    assert.strictEqual(passed.length, 0);
    assert.ok(skips[0].reason.startsWith('stale'));
  });

  it('includes stale repos when includeStale is true', () => {
    const results = [{ ...baseResult, pushedAt: '2020-01-01T00:00:00Z' }];
    const { passed } = filterResults(results, { includeStale: true });
    assert.strictEqual(passed.length, 1);
  });

  it('skips repos below min-stars threshold', () => {
    const results = [{ ...baseResult, stars: 5 }];
    const { passed, skips } = filterResults(results, { minStars: 10 });
    assert.strictEqual(passed.length, 0);
    assert.ok(skips[0].reason.includes('stars'));
  });

  it('passes repos meeting all criteria', () => {
    const results = [baseResult];
    const { passed } = filterResults(results, {});
    assert.strictEqual(passed.length, 1);
  });
});

describe('hasServerUrl', () => {
  it('returns true for spec with servers array', () => {
    assert.strictEqual(hasServerUrl({ servers: [{ url: 'https://api.example.com' }] }), true);
  });

  it('returns true for swagger 2.0 spec with host', () => {
    assert.strictEqual(hasServerUrl({ host: 'api.example.com', swagger: '2.0' }), true);
  });

  it('returns false for spec with no servers or host', () => {
    assert.strictEqual(hasServerUrl({ info: { title: 'Test' } }), false);
  });

  it('returns false for spec with empty servers array', () => {
    assert.strictEqual(hasServerUrl({ servers: [] }), false);
  });
});

describe('isLocalhostSpec', () => {
  it('detects localhost', () => {
    assert.strictEqual(isLocalhostSpec({ servers: [{ url: 'http://localhost:3000' }] }), true);
  });

  it('detects 127.0.0.1', () => {
    assert.strictEqual(isLocalhostSpec({ servers: [{ url: 'http://127.0.0.1/api' }] }), true);
  });

  it('detects example.com', () => {
    assert.strictEqual(isLocalhostSpec({ servers: [{ url: 'https://example.com' }] }), true);
  });

  it('detects petstore.swagger.io', () => {
    assert.strictEqual(isLocalhostSpec({ servers: [{ url: 'https://petstore.swagger.io/v2' }] }), true);
  });

  it('returns false for real domains', () => {
    assert.strictEqual(isLocalhostSpec({ servers: [{ url: 'https://api.stripe.com' }] }), false);
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL

- [ ] **Step 6: Implement `filterResults()`, `hasServerUrl()`, `isLocalhostSpec()`**

```typescript
export interface FilterOptions {
  includeStale?: boolean;
  minStars?: number;
}

export interface FilterResult {
  passed: GitHubSpecResult[];
  skips: Array<{ repo: string; reason: string }>;
}

const THREE_YEARS_MS = 3 * 365.25 * 24 * 60 * 60 * 1000;

export function filterResults(results: GitHubSpecResult[], options: FilterOptions): FilterResult {
  const passed: GitHubSpecResult[] = [];
  const skips: Array<{ repo: string; reason: string }> = [];

  for (const r of results) {
    if (r.isFork) {
      skips.push({ repo: r.repoFullName, reason: 'fork' });
      continue;
    }
    if (r.isArchived) {
      skips.push({ repo: r.repoFullName, reason: 'archived' });
      continue;
    }
    if (!options.includeStale) {
      const age = Date.now() - new Date(r.pushedAt).getTime();
      if (age > THREE_YEARS_MS) {
        const date = r.pushedAt.slice(0, 10);
        skips.push({ repo: r.repoFullName, reason: `stale, last push ${date}` });
        continue;
      }
    }
    if (options.minStars !== undefined && r.stars < options.minStars) {
      skips.push({ repo: r.repoFullName, reason: `${r.stars} stars, below --min-stars ${options.minStars}` });
      continue;
    }
    passed.push(r);
  }

  return { passed, skips };
}

export function hasServerUrl(spec: Record<string, any>): boolean {
  if (spec.servers?.length > 0 && spec.servers[0].url) return true;
  if (spec.host) return true;
  return false;
}

const LOCALHOST_PATTERNS = ['localhost', '127.0.0.1', 'example.com', 'petstore.swagger.io'];

export function isLocalhostSpec(spec: Record<string, any>): boolean {
  const url = spec.servers?.[0]?.url ?? spec.host ?? '';
  return LOCALHOST_PATTERNS.some(p => url.includes(p));
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/skill/github.ts test/skill/github.test.ts
git commit -m "feat(github): add template normalizer and filter pipeline"
```

---

### Task 3: Org Scan — Code Search

**Files:**
- Modify: `src/skill/github.ts`
- Modify: `test/skill/github.test.ts`

- [ ] **Step 1: Write failing tests for `searchOrgSpecs()`**

Test with mocked `githubFetch`. The tests need to verify:
- All 4 filename patterns are queried sequentially
- Results are deduped by `htmlUrl`
- Results are ranked by stars desc, then path depth asc
- 422 response throws "org not found"

```typescript
describe('searchOrgSpecs', () => {
  it('queries 4 filename patterns and deduplicates by htmlUrl', async () => {
    // Mock githubFetch to return overlapping results for different filenames
    // Verify dedup produces unique htmlUrls
  });

  it('ranks by stars descending then path depth ascending', async () => {
    // Return results with different stars and path depths
    // Verify order: high-stars + shallow first
  });

  it('maps code search response to GitHubSpecResult', async () => {
    // Provide realistic GitHub code search JSON response
    // Verify all fields of GitHubSpecResult are populated correctly:
    //   owner, repo, repoFullName, filePath, htmlUrl, specUrl, stars, isFork, isArchived, pushedAt, description
  });

  it('throws descriptive error for nonexistent org (422)', async () => {
    // Mock githubFetch to throw with 422
    // Verify error message includes org name
  });

  it('returns empty array when no specs found', async () => {
    // Mock all 4 queries returning empty items
    // Verify returns []
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement `searchOrgSpecs()`**

Key implementation details:
- Queries run **sequentially** (not `Promise.all`) — critical for GitHub's secondary rate limit of 30 req/min on code search. Add a comment explaining why.
- Uses `per_page=100` on each query.
- `specUrl` is constructed as `https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/{path}`. The code search response includes `repository.default_branch`.
- `htmlUrl` comes from the code search `items[].html_url` field.
- Ranking: sort by `stars` desc, break ties with path depth (count of `/` in `filePath`) asc.

```typescript
const SPEC_FILENAMES = ['openapi.json', 'openapi.yaml', 'swagger.json', 'swagger.yaml'];

export async function searchOrgSpecs(
  org: string,
  token: string | null,
): Promise<GitHubSpecResult[]> {
  const allItems: GitHubSpecResult[] = [];
  const seen = new Set<string>();

  // Sequential queries — GitHub's code search has a secondary rate limit
  // of 30 req/min (authenticated). Parallel fan-out risks immediate 403.
  for (const filename of SPEC_FILENAMES) {
    const q = encodeURIComponent(`filename:${filename} org:${org}`);
    let response;
    try {
      response = await githubFetch(`/search/code?q=${q}&per_page=100`, token);
    } catch (err: any) {
      if (err.status === 422) {
        throw new Error(`GitHub org '${org}' not found.`);
      }
      throw err;
    }

    for (const item of response.data.items ?? []) {
      const htmlUrl: string = item.html_url;
      if (seen.has(htmlUrl)) continue;
      seen.add(htmlUrl);

      const repo = item.repository;
      allItems.push({
        owner: repo.owner?.login ?? org,
        repo: repo.name,
        repoFullName: repo.full_name,
        filePath: item.path,
        htmlUrl,
        specUrl: `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch ?? 'main'}/${item.path}`,
        stars: repo.stargazers_count ?? 0,
        isFork: repo.fork ?? false,
        isArchived: repo.archived ?? false,
        pushedAt: repo.pushed_at ?? '',
        description: repo.description ?? '',
      });
    }
  }

  // Rank: stars desc, then path depth asc (shallower = more likely canonical)
  allItems.sort((a, b) => {
    if (b.stars !== a.stars) return b.stars - a.stars;
    const depthA = a.filePath.split('/').length;
    const depthB = b.filePath.split('/').length;
    return depthA - depthB;
  });

  return allItems;
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/skill/github.ts test/skill/github.test.ts
git commit -m "feat(github): implement org scan via code search"
```

---

### Task 4: Topic Search — Repo Discovery + Spec Probing

**Files:**
- Modify: `src/skill/github.ts`
- Modify: `test/skill/github.test.ts`

- [ ] **Step 1: Write failing tests for `searchTopicSpecs()`**

```typescript
describe('searchTopicSpecs', () => {
  it('searches all 4 canonical topics when no specific topic given', async () => {
    // Mock githubFetch for 4 topic queries
    // Verify all 4 are called
  });

  it('searches single topic when specific topic given', async () => {
    // topics = ['openapi-specification']
    // Verify only 1 query
  });

  it('deduplicates repos by fullName across topics', async () => {
    // Same repo appears in multiple topic results
    // Verify appears only once
  });

  it('filters by minStars', async () => {
    // Return repos with various star counts
    // Verify only repos >= minStars survive
  });

  it('applies client-side query filter on name and description', async () => {
    // Return repos with different names/descriptions
    // Verify --query filters by substring match, case-insensitive
  });

  it('probes repos for spec files at root and common subdirs', async () => {
    // Mock contents endpoint for root, then api/, spec/, docs/
    // Verify spec file found in subdirectory
  });

  it('skips repos where no spec file is found', async () => {
    // Mock contents endpoints returning no matching filenames
    // Verify repo excluded from results
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement `probeForSpecs()` helper**

This probes a single repo for spec files at root + common subdirs.

```typescript
const PROBE_DIRS = ['', 'api', 'spec', 'docs'];

async function probeForSpecs(
  owner: string,
  repo: string,
  token: string | null,
): Promise<Array<{ path: string; htmlUrl: string }>> {
  const found: Array<{ path: string; htmlUrl: string }> = [];

  for (const dir of PROBE_DIRS) {
    const contentsPath = dir
      ? `/repos/${owner}/${repo}/contents/${dir}`
      : `/repos/${owner}/${repo}/contents`;

    try {
      const { data } = await githubFetch(contentsPath, token);
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        if (SPEC_FILENAMES.includes(entry.name)) {
          found.push({
            path: entry.path,
            htmlUrl: entry.html_url,
          });
        }
      }
    } catch {
      // Directory doesn't exist or 404 — continue to next
      continue;
    }

    // If we found specs in this dir, don't probe deeper
    if (found.length > 0) break;
  }

  return found;
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: Tests still failing — `searchTopicSpecs` not implemented

- [ ] **Step 3: Implement `searchTopicSpecs()`**

```typescript
export const CANONICAL_TOPICS = ['openapi-specification', 'openapi', 'openapi3', 'swagger-api'];

export async function searchTopicSpecs(
  topics: string[],
  token: string | null,
  options: { minStars: number; query?: string },
): Promise<GitHubSpecResult[]> {
  // Fan out topic queries in parallel — repository search has more
  // generous secondary rate limits than code search.
  const responses = await Promise.all(
    topics.map(topic =>
      githubFetch(
        `/search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&sort=stars&order=desc&per_page=100`,
        token,
      )
    ),
  );

  // Dedup by full_name
  const seen = new Set<string>();
  const repos: Array<{ owner: string; repo: string; fullName: string; stars: number; isFork: boolean; isArchived: boolean; pushedAt: string; description: string; defaultBranch: string }> = [];

  for (const { data } of responses) {
    for (const item of data.items ?? []) {
      if (seen.has(item.full_name)) continue;
      seen.add(item.full_name);

      if (item.stargazers_count < options.minStars) continue;

      if (options.query) {
        const q = options.query.toLowerCase();
        const name = (item.name ?? '').toLowerCase();
        const desc = (item.description ?? '').toLowerCase();
        if (!name.includes(q) && !desc.includes(q)) continue;
      }

      repos.push({
        owner: item.owner?.login,
        repo: item.name,
        fullName: item.full_name,
        stars: item.stargazers_count ?? 0,
        isFork: item.fork ?? false,
        isArchived: item.archived ?? false,
        pushedAt: item.pushed_at ?? '',
        description: item.description ?? '',
        defaultBranch: item.default_branch ?? 'main',
      });
    }
  }

  // Probe each repo for spec files
  const results: GitHubSpecResult[] = [];
  for (const repo of repos) {
    const specs = await probeForSpecs(repo.owner, repo.repo, token);
    for (const spec of specs) {
      results.push({
        owner: repo.owner,
        repo: repo.repo,
        repoFullName: repo.fullName,
        filePath: spec.path,
        htmlUrl: spec.htmlUrl,
        specUrl: `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${spec.path}`,
        stars: repo.stars,
        isFork: repo.isFork,
        isArchived: repo.isArchived,
        pushedAt: repo.pushedAt,
        description: repo.description,
      });
    }
  }

  // Sort by stars desc
  results.sort((a, b) => b.stars - a.stars);

  return results;
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/skill/github.ts test/skill/github.test.ts
git commit -m "feat(github): implement topic search with spec probing"
```

---

### Task 5: Fetch Spec Content

**Files:**
- Modify: `src/skill/github.ts`
- Modify: `test/skill/github.test.ts`

- [ ] **Step 1: Write failing tests for `fetchGitHubSpec()`**

```typescript
describe('fetchGitHubSpec', () => {
  it('fetches and parses JSON spec from specUrl', async () => {
    // Mock fetch for raw.githubusercontent.com URL
    // Return valid OpenAPI JSON
    // Verify parsed object
  });

  it('fetches and parses YAML spec', async () => {
    // Return valid YAML string
    // Verify parsed to object via js-yaml
  });

  it('throws on response > 10MB', async () => {
    // Mock Content-Length > 10MB
    // Verify throws
  });

  it('does not use githubFetch (uses direct fetch to raw.githubusercontent.com)', async () => {
    // Verify the URL starts with raw.githubusercontent.com, not api.github.com
  });
});
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement `fetchGitHubSpec()`**

Takes `specUrl` directly (the `raw.githubusercontent.com` URL from `GitHubSpecResult.specUrl`), matching how `fetchSpec()` in `apis-guru.ts` and `fetchSwaggerHubSpec()` in `swaggerhub.ts` both accept a URL string. This ensures the fetched URL is identical to the `specUrl` stored in `importHistory` for `--update` matching.

```typescript
import { resolveAndValidateUrl } from './ssrf.js';

const MAX_SPEC_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Fetch an OpenAPI spec from raw.githubusercontent.com.
 * Uses direct fetch() — does NOT use githubFetch() since this is a different host.
 * raw.githubusercontent.com requests do not count against the GitHub API rate limit.
 * Auth token is sent to raw.githubusercontent.com (GitHub-controlled domain) for private repo support.
 */
export async function fetchGitHubSpec(
  specUrl: string,
  token: string | null,
): Promise<Record<string, any>> {
  const ssrf = await resolveAndValidateUrl(specUrl);
  if (!ssrf.safe) {
    throw new Error(`SSRF check failed for spec URL ${specUrl}: ${ssrf.reason}`);
  }

  const headers: Record<string, string> = { 'User-Agent': 'apitap-import' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(specUrl, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${specUrl}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_SPEC_SIZE) {
    throw new Error(`Spec too large: ${contentLength} bytes (limit: ${MAX_SPEC_SIZE})`);
  }

  const text = await response.text();
  if (text.length > MAX_SPEC_SIZE) {
    throw new Error(`Spec body too large: ${text.length} bytes`);
  }

  // Try JSON first, then YAML
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    const yaml = await import('js-yaml');
    const parsed = yaml.load(text);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Invalid JSON/YAML from ${specUrl}`);
    }
    return parsed as Record<string, any>;
  }
}
```

Run: `node --import tsx --test test/skill/github.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/skill/github.ts test/skill/github.test.ts
git commit -m "feat(github): implement spec content fetching with YAML support"
```

---

### Task 6: CLI Handler — `handleGitHubImport()`

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add route in `handleImport()`**

Find the `handleImport()` function in `src/cli.ts` (around line 502). Add the GitHub route after the SwaggerHub route:

```typescript
// After line 513 (the swaggerhub handler):
  // --from github: GitHub import mode
  if (flags['from'] === 'github') {
    await handleGitHubImport(flags);
    return;
  }
```

Run: `npm run typecheck`
Expected: FAIL — `handleGitHubImport` not defined

- [ ] **Step 2: Add help text for GitHub import**

Find the help text in `src/cli.ts` (around line 84-100 where other import modes are listed). Add:

```
  apitap import --from github --org <name>     Import specs from a GitHub org's repos
  apitap import --from github --topic [name]   Import from topic-tagged repos (--query to filter)
```

- [ ] **Step 3: Implement `handleGitHubImport()`**

Add the function after `handleSwaggerHubImport()` (around line 1122). Follow the same pattern as `handleApisGuruImport()` (which has `--dry-run` support, unlike `handleSwaggerHubImport()`).

Import at the top of `src/cli.ts`:

```typescript
import {
  resolveGitHubToken,
  searchOrgSpecs,
  searchTopicSpecs,
  fetchGitHubSpec,
  filterResults,
  hasServerUrl,
  isLocalhostSpec,
  normalizeSpecServerUrls,
  CANONICAL_TOPICS,
} from './skill/github.js';
```

Key code blocks that must be implemented exactly (these cover the spec's nuanced requirements):

**Flag parsing:**

```typescript
const json = flags.json === true;
const force = flags.force === true;
const update = flags.update === true;
const dryRun = flags['dry-run'] === true;
const noAuthOnly = flags['no-auth-only'] === true;
const includeStale = flags['include-stale'] === true;
const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 20;
const org = typeof flags.org === 'string' ? flags.org : undefined;
const topicFlag = flags.topic;
const query = typeof flags.query === 'string' ? flags.query : undefined;

// Mutual exclusion
if (org && topicFlag) { /* error: --org and --topic are mutually exclusive */ }
if (!org && !topicFlag) { /* error: --org or --topic required */ }

// --min-stars: different defaults per mode
const minStarsDefault = org ? 0 : 10;
const minStars = typeof flags['min-stars'] === 'string'
  ? parseInt(flags['min-stars'], 10) : minStarsDefault;

// --topic parsing: bare --topic = all four topics, --topic openapi = just that one
const topics = typeof topicFlag === 'string'
  ? [topicFlag]
  : CANONICAL_TOPICS;
```

**Auth requirement for `--org`:**

```typescript
const token = await resolveGitHubToken();
if (org && token === null) {
  const msg = "--org requires a GitHub token. Run 'gh auth login' or set GITHUB_TOKEN.";
  if (json) { console.log(JSON.stringify({ success: false, reason: msg })); }
  else { console.error(`Error: ${msg}`); }
  process.exit(1);
}
```

**`--update` check (combines specUrl matching + timestamp comparison — stricter than either existing handler):**

```typescript
// Inside the per-result loop, after mergeSkillFile and before signing:
if (!force && update && existing?.metadata.importHistory?.some(
  h => h.specUrl === result.specUrl && h.importedAt >= result.pushedAt
)) {
  if (!json) console.log(`  [${idx}/${total}] SKIP ${domain.padEnd(40)} up to date`);
  skippedSpecs++;
  specSkips.push({ domain, reason: 'up to date' });
  continue;
}
```

**Rate limit tracking and early-stop:**

```typescript
// Track last known rate limit from githubFetch responses
let lastRateLimit: RateLimit | null = null;

// Before each spec fetch, check if we should stop
if (lastRateLimit && lastRateLimit.remaining === 0) {
  const msg = `GitHub API rate limit exhausted. Resets at ${lastRateLimit.resetAt.toLocaleTimeString()}.`;
  if (!json) console.error(`\n  ${msg}`);
  break;
}
```

Note: `fetchGitHubSpec()` uses direct `fetch()` (not `githubFetch()`), so spec fetches don't consume API rate limit. The rate limit tracking applies to the discovery phase (`searchOrgSpecs`/`searchTopicSpecs`) and `probeForSpecs()` calls. Track `lastRateLimit` from the discovery call results.

**Summary output with separate skip buckets:**

```typescript
if (!json) {
  console.log(`\n  Imported ${imported} specs: ${totalEndpointsAdded.toLocaleString()} endpoints across ${imported} domains`);
  if (repoSkips.length) {
    const reasons = new Map<string, number>();
    for (const s of repoSkips) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    const parts = [...reasons.entries()].map(([r, n]) => `${n} ${r}`);
    console.log(`  Repo skips: ${repoSkips.length} (${parts.join(', ')})`);
  }
  if (specSkips.length) {
    const reasons = new Map<string, number>();
    for (const s of specSkips) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    const parts = [...reasons.entries()].map(([r, n]) => `${n} ${r}`);
    console.log(`  Spec skips: ${specSkips.length} (${parts.join(', ')})`);
  }
  if (lastRateLimit) {
    const used = lastRateLimit.limit - lastRateLimit.remaining;
    let rateLine = `  GitHub API: ${used}/${lastRateLimit.limit} requests used`;
    if (lastRateLimit.remaining < 100) {
      rateLine += ` (resets ${lastRateLimit.resetAt.toLocaleTimeString()})`;
    }
    console.log(rateLine);
  }
  console.log();
}
```

The rest of the handler follows the same structure as `handleApisGuruImport()`:
- Fetch spec via `fetchGitHubSpec(result.specUrl, token)`
- Pre-conversion content filters: `hasServerUrl()`, `isLocalhostSpec()`
- `normalizeSpecServerUrls(spec)` — mutates in place before conversion
- `convertOpenAPISpec(spec, result.specUrl)` — specUrl goes into importMeta for history
- Post-conversion SSRF check on extracted domain
- `--no-auth-only` check on `meta.requiresAuth`
- `mergeSkillFile()`, `--update` check (code above), `--dry-run` guard
- If not dry-run: `signSkillFileAs()` + `writeSkillFile()`
- `--dry-run`: print `htmlUrl` on line below each result
- 100ms polite delay between spec fetches

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All existing tests PASS (no existing code was modified except the new route in `handleImport()`)

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(github): add handleGitHubImport CLI handler"
```

---

### Task 7: Integration Tests

**Files:**
- Create: `test/skill/github-integration.test.ts`

- [ ] **Step 1: Write integration tests with mocked GitHub API**

These tests exercise the full pipeline: discovery → filter → fetch → convert → merge → sign → write. They mock `fetch()` at the global level to intercept GitHub API calls.

```typescript
describe('GitHub import integration', () => {
  it('org scan: discovers, filters, converts, and writes skill files', async () => {
    // Mock: githubFetch for code search returns 2 results (1 valid, 1 fork)
    // Mock: fetch for raw.githubusercontent.com returns valid OpenAPI spec
    // Verify: 1 skill file written, 1 fork skipped
  });

  it('topic search: discovers repos, probes for specs, writes skill files', async () => {
    // Mock: repo search for 4 topics
    // Mock: contents endpoint for spec probing
    // Mock: fetch for raw spec content
    // Verify: skill files written for repos with specs
  });

  it('--dry-run does not write to disk', async () => {
    // Run import with --dry-run
    // Verify no files in skills dir
  });

  it('--update skips already-imported specs', async () => {
    // Pre-create a skill file with importHistory matching the specUrl
    // Run import with --update
    // Verify skipped
  });

  it('stops on rate limit exhaustion', async () => {
    // Mock githubFetch to return X-RateLimit-Remaining: 0 on second call
    // Verify stops with rate limit error
  });

  it('continues when individual spec fetch fails', async () => {
    // Mock first spec fetch to 404, second to succeed
    // Verify: 1 OK, 1 FAIL, continues to second
  });

  it('--org with no token exits with error', async () => {
    // Ensure resolveGitHubToken returns null
    // Verify process exits with clear error message
  });

  it('normalizes templated domains before conversion', async () => {
    // Return spec with servers: [{ url: 'https://{region}.sentry.io/api/0' }]
    // Verify skill file written with domain 'sentry.io', not 'raw.githubusercontent.com'
  });

  it('skips specs with no server URL', async () => {
    // Return spec with no servers and no host
    // Verify skipped with "no server URL" message
  });

  it('silently skips localhost specs', async () => {
    // Return spec with servers: [{ url: 'http://localhost:3000' }]
    // Verify skipped without output line
  });
});
```

Run: `node --import tsx --test test/skill/github-integration.test.ts`
Expected: Implement incrementally, all PASS at end

- [ ] **Step 2: Implement test fixtures and mocking infrastructure**

Create the test file with mock helpers for `fetch()` and `execFileSync`. Use `mock.method(globalThis, 'fetch', ...)` from `node:test` built-in mocking.

- [ ] **Step 3: Implement all integration test cases**

Work through each test case, implementing the mock setup and assertions.

Run: `node --import tsx --test test/skill/github-integration.test.ts`
Expected: All PASS

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests PASS including new ones

- [ ] **Step 5: Commit**

```bash
git add test/skill/github-integration.test.ts
git commit -m "test(github): add integration tests for GitHub import"
```

---

### Task 8: Final Verification + Typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Manual smoke test with `--dry-run`**

Run: `npx tsx src/cli.ts import --from github --org cloudflare --dry-run`
Expected: Discovers Cloudflare's OpenAPI specs, prints dry-run output with spec details and htmlUrls. No disk writes.

Run: `npx tsx src/cli.ts import --from github --topic openapi --min-stars 50 --limit 5 --dry-run`
Expected: Discovers community-curated OpenAPI repos, probes for spec files, prints dry-run output.

- [ ] **Step 4: Final commit if any cleanup needed**

```bash
git add src/skill/github.ts src/cli.ts test/skill/github.test.ts test/skill/github-integration.test.ts
git commit -m "chore(github): final cleanup after manual verification"
```

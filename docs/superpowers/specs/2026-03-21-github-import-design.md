# Design: `apitap import --from github`

GitHub-based OpenAPI spec discovery and import. Finds official OpenAPI specs published by API providers on GitHub and imports them into the apitap skill database.

## Motivation

The best OpenAPI specs live on GitHub, published by the API providers themselves. APIs.guru is curated but limited (2,529 specs). SwaggerHub is large but noisy (third-party uploads, not official). GitHub has the official specs — Cloudflare, Discord, Figma, PagerDuty, Sentry, DataDog, Okta all publish their OpenAPI specs in public repos.

Manual import already works (`apitap import <raw.githubusercontent.com URL>`). This feature automates discovery.

## Scope

**v1 (this PR):**
- Org scan: find specs across an org's repos
- Topic search: find community-curated OpenAPI repos

**Deferred (v2):**
- Global code search (`filename:openapi.json` across all of GitHub) — too noisy, returns forks, test fixtures, stale copies. Needs sophisticated dedup/ranking.

## CLI Interface

```
# Org scan — find specs in an org's repos
apitap import --from github --org cloudflare --limit 20

# Topic search — community-curated OpenAPI repos
apitap import --from github --topic openapi --query payments --min-stars 10 --limit 20
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--org <name>` | string | — | GitHub org to scan. Mutually exclusive with `--topic`. |
| `--topic [name]` | optional string | all four | GitHub topic to search. No value = all four canonical topics. Specific value = just that topic. Mutually exclusive with `--org`. |
| `--query <term>` | string | — | Client-side filter for topic results (matches repo name/description). Only applies to `--topic`. |
| `--min-stars <n>` | number | 0 (org) / 10 (topic) | Minimum GitHub stars. Different defaults: 0 for org (you trust the org), 10 for topic (need a quality floor). Document in help text. |
| `--limit <n>` | number | 20 | Max specs to import. |
| `--no-auth-only` | boolean | false | Skip specs that require auth. |
| `--update` | boolean | false | Skip specs already imported from this URL if repo hasn't been updated since. |
| `--force` | boolean | false | Reimport even if already imported. |
| `--dry-run` | boolean | false | Show what would be imported, don't write to disk. Same output format as real run, prefixed with `(dry run)`. |
| `--include-stale` | boolean | false | Override the 3-year staleness skip. |
| `--json` | boolean | false | Machine-readable JSON output. |

### Validation

- `--org` and `--topic` are mutually exclusive. One must be provided.
- `--query` is only valid with `--topic`.
- `--min-stars` defaults differ by mode (documented in help text).

### `--topic` flag parsing

The existing hand-rolled arg parser in `src/cli.ts` produces `Record<string, string | boolean>`. Bare `--topic` (no value) parses as `true` (boolean); `--topic openapi` parses as `"openapi"` (string). The handler distinguishes these:
- `typeof flags.topic === 'string'` → search only that specific topic
- `flags.topic === true` → search all four canonical topics

This is the first optional-value flag in the CLI — document the behavior in the help text.

### `--update` semantics

The `--update` flag skips specs that were already imported from the same `specUrl` (the `raw.githubusercontent.com` URL) and whose `importHistory[].importedAt` is newer than the repo's `pushedAt`. This uses the same `importHistory` comparison as the APIs.guru handler. Note: if the default branch changes or the file moves, the `specUrl` won't match and the spec will be re-imported (correct behavior — treat it as a new source).

## Module Architecture

### New file: `src/skill/github.ts`

Follows the pattern of `apis-guru.ts` and `swaggerhub.ts` — pure functions for fetching/parsing, no CLI concerns.

### Token Resolution

Lazy initialization on first GitHub API call. Cached for the session in a module-level variable.

```typescript
let cachedToken: string | null | undefined; // undefined = not yet resolved

export async function resolveGitHubToken(): Promise<string | null>
```

Resolution chain:
1. If already resolved (`cachedToken !== undefined`), return cached value.
2. Try `execFileSync('gh', ['auth', 'token'], { timeout: 2000 }).toString().trim()`. Uses `execFileSync` (not `execSync`) to avoid shell injection — no shell involved, direct process spawn.
3. On any error (not installed, not authed, timeout, keychain prompt hang): fall back to `process.env.GITHUB_TOKEN ?? null`.
4. Cache result (even `null`) in module-level var.
5. If `null`: warn to stderr: `"No GitHub token found — rate limited to 60 req/hr. Run 'gh auth login' or set GITHUB_TOKEN."`

The 2s timeout on `execFileSync` prevents CLI stalls if `gh` hangs. Any throw falls through to the env var.

**Auth requirement by mode:**
- `--org` mode uses the Code Search API (`/search/code`), which **requires authentication**. If `resolveGitHubToken()` returns `null`, exit with error: `"--org requires a GitHub token. Run 'gh auth login' or set GITHUB_TOKEN."` Do not attempt unauthenticated code search — it returns 401.
- `--topic` mode uses the Repository Search API (`/search/repositories`), which works unauthenticated at 10 req/min. Token is recommended but not required.

### GitHub API Helper

```typescript
export async function githubFetch(
  path: string,
  token: string | null
): Promise<{ data: any; rateLimit: RateLimit }>
```

- Prefixes `https://api.github.com`
- Sets `Authorization: Bearer <token>` if token present
- Sets `Accept: application/vnd.github+json`
- Sets `User-Agent: apitap-import` (required by GitHub API — requests without it are rejected)
- Parses `X-RateLimit-Remaining` and `X-RateLimit-Reset` from response headers
- On 403 with rate limit exhausted: throw with message including reset time
- Before each batch of parallel requests: check `X-RateLimit-Remaining`, early-stop if 0
- 30s timeout, 10MB response cap (consistent with other importers)
- No SSRF validation needed on `api.github.com` itself — it's a hardcoded trusted host

```typescript
export interface RateLimit {
  remaining: number;
  limit: number;
  resetAt: Date;
}
```

### Org Scan

```typescript
export async function searchOrgSpecs(
  org: string,
  token: string | null
): Promise<GitHubSpecResult[]>
```

1. Run 4 code search queries **sequentially** (not parallel — GitHub's search API has a secondary rate limit of 30 req/min for authenticated users, 10 req/min unauthenticated; parallel fan-out risks hitting it immediately):
   - `filename:openapi.json org:<org>`
   - `filename:openapi.yaml org:<org>`
   - `filename:swagger.json org:<org>`
   - `filename:swagger.yaml org:<org>`
   - Each query uses `per_page=100` (max allowed). GitHub caps code search at 1,000 total results per query, but for a single org this is rarely a concern.
2. Dedup results by `htmlUrl`.
3. Rank: repo stars descending, then file path depth ascending (shallower = more likely canonical).
4. Return spec locations with repo metadata.
5. On 422 response (org not found): throw with clear error: `"GitHub org '<org>' not found."` Do not continue to other queries.

### Topic Search

```typescript
export async function searchTopicSpecs(
  topics: string[],
  token: string | null,
  options: { minStars: number; query?: string }
): Promise<GitHubSpecResult[]>
```

Canonical topics (used when `--topic` has no value):
- `openapi-specification`
- `openapi`
- `openapi3`
- `swagger-api`

1. Fan out topic queries in parallel via `Promise.all`: `topic:<topic> sort:stars order:desc` for each topic. (Repository search has more generous secondary rate limits than code search, so parallel is fine here.)
2. Dedup by repo `fullName`.
3. Filter by `minStars`.
4. Client-side filter by `--query` (substring match on repo name + description, case-insensitive).
5. For each repo, probe for spec files:
   - `GET /repos/{owner}/{repo}/contents/` — check if any root entry's `name` matches `openapi.json`, `openapi.yaml`, `swagger.json`, `swagger.yaml`.
   - If not found at root, check one level deeper in common subdirs: `api/`, `spec/`, `docs/`.
   - Stop there. No recursion beyond these paths.
6. Return spec locations with repo metadata.

### Fetch Spec Content

```typescript
export async function fetchGitHubSpec(
  owner: string,
  repo: string,
  path: string,
  token: string | null
): Promise<Record<string, any>>
```

- Fetches from `raw.githubusercontent.com` URL using direct `fetch()` — does NOT use `githubFetch()` since this is a different host
- `raw.githubusercontent.com` requests do **not** count against the GitHub API rate limit, so spec fetches don't consume the API budget
- Parses JSON or YAML (js-yaml)
- 10MB size cap, 30s timeout
- SSRF validation on the `raw.githubusercontent.com` URL

### Core Type

```typescript
export interface GitHubSpecResult {
  owner: string;
  repo: string;
  repoFullName: string;   // "cloudflare/api-schemas"
  filePath: string;        // "openapi.json" or "specs/openapi.json"
  htmlUrl: string;         // GitHub web URL for the file (for dedup + dry-run display)
  specUrl: string;         // raw.githubusercontent.com URL for fetching
  stars: number;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string;        // ISO timestamp
  description: string;
}
```

## Filter Pipeline

Two phases: metadata filters (cheap, pre-fetch) and content filters (post-fetch). Applied in order.

### Phase 1: Metadata Filters (on `GitHubSpecResult[]`)

Applied before fetching spec content. No API calls.

| # | Filter | Condition | Output |
|---|--------|-----------|--------|
| 1 | Fork | `isFork === true` | `SKIP owner/repo (fork)` |
| 2 | Archived | `isArchived === true` | `SKIP owner/repo (archived)` |
| 3 | Stale | `pushedAt < now - 3 years` | `SKIP owner/repo (stale, last push YYYY-MM-DD)`. Bypassed by `--include-stale`. |
| 4 | Stars | `stars < minStars` (topic only) | `SKIP owner/repo (N stars, below --min-stars M)` |

### Phase 2: Content Filters (on parsed spec)

Applied after fetching and parsing the OpenAPI spec.

| # | Filter | Condition | Output |
|---|--------|-----------|--------|
| 5 | No server URL | No `servers[0].url` and no `host` field in raw spec (checked **before** `convertOpenAPISpec()` to avoid fallback to `raw.githubusercontent.com`) | `SKIP "spec has no server URL, cannot determine API domain"` |
| 6 | Localhost/example | `servers[0].url` matches `localhost`, `127.0.0.1`, `example.com`, `petstore.swagger.io` (also checked on raw spec before conversion) | Silent skip (high volume, zero signal) |
| 7 | SSRF validation | Domain resolves to private IP | `SKIP "domain resolves to private address"` |
| 8 | Templated domain | Domain contains `{var}` segments | Normalize + warn: `"normalized {region}.sentry.io -> sentry.io"`. Continue to import. |
| 9 | >500 endpoints | Spec exceeds 500-endpoint cap | Truncate + note: `"truncated to 500 endpoints (spec has N)"`. Handled by existing `convertOpenAPISpec()` cap. |

### Template Domain Normalizer

```typescript
export function normalizeTemplatedDomain(domain: string): string {
  let d = domain;
  while (d.startsWith('{')) {
    d = d.replace(/^\{[^}]+\}\./, '');
  }
  return d;
}

// Pre-process spec's server URL before conversion
export function normalizeSpecServerUrls(spec: Record<string, any>): void {
  if (spec.servers) {
    for (const server of spec.servers) {
      if (server.url && server.url.includes('{')) {
        try {
          const url = new URL(server.url);
          url.hostname = normalizeTemplatedDomain(url.hostname);
          server.url = url.toString();
        } catch {
          // URL with leading template like https://{region}.sentry.io
          // fails new URL(). Extract hostname manually.
          const match = server.url.match(/^(https?:\/\/)([^/]+)(.*)/);
          if (match) {
            const normalized = normalizeTemplatedDomain(match[2]);
            server.url = match[1] + normalized + match[3];
          }
        }
      }
    }
  }
}
```

**Critical: applied BEFORE `convertOpenAPISpec()`**, not after. The problem: `extractDomainAndBasePath()` inside `convertOpenAPISpec()` calls `new URL(server.url)`, which throws on URLs like `https://{region}.sentry.io`. The template variable makes it an invalid URL, causing fallback to the `specUrl` hostname (`raw.githubusercontent.com` — wrong).

The GitHub handler calls `normalizeSpecServerUrls(spec)` to mutate the raw spec object before passing it to `convertOpenAPISpec()`. This way the converter sees a clean URL like `https://sentry.io` and extracts the correct domain.

Only handles leading template segments (`{region}.sentry.io` -> `sentry.io`). Mid-position templates (`api.{region}.sentry.io`) are out of scope — they're rare and would need per-provider logic.

Lives in `github.ts` for now. Can be moved to the converter if other importers need it later.

## CLI Handler

New function `handleGitHubImport()` in `src/cli.ts`. Same pattern as `handleApisGuruImport()` and `handleSwaggerHubImport()`.

### Flow

1. Resolve GitHub token (lazy, cached).
2. Branch on `--org` vs `--topic`:
   - ORG: `searchOrgSpecs(org, token)`
   - TOPIC: `searchTopicSpecs(topics, token, { minStars, query })`
3. Apply metadata filters (fork, archived, stale, stars).
4. Cap to `--limit`.
5. For each surviving result:
   a. Fetch spec via `fetchGitHubSpec()`.
   b. Pre-conversion content filters on raw spec: no-server-URL check (#5), localhost/example check (#6).
   c. `normalizeSpecServerUrls(spec)` — fix templated domains before conversion.
   d. `convertOpenAPISpec()`.
   e. Post-conversion filters: SSRF validation (#7) on extracted domain.
   f. Check `--no-auth-only`, `--update`, `--force` (same logic as apis-guru).
   g. Read existing skill file.
   h. `mergeSkillFile()`.
   i. If `--dry-run`: print line, continue.
   j. `signSkillFile()` + `writeSkillFile()`.
   k. 100ms polite delay between fetches.
6. Print summary.

### Output Format

```
Scanning cloudflare repos for OpenAPI specs...
Found 8 spec files across 5 repos (3 skipped)

SKIP cloudflare/cloudflare-docs     (fork)
SKIP cloudflare/old-api-tools       (stale, last push 2021-08-03)
SKIP cloudflare/test-schemas        (archived)

[1/5]  OK   api.cloudflare.com       +347 endpoints  (Cloudflare API v4)
[2/5]  OK   workers.cloudflare.com   +42 endpoints   (Workers API)
[3/5]  SKIP gateway.cloudflare.com   spec has no server URL
[4/5]  OK   radar.cloudflare.com     +189 endpoints  (Cloudflare Radar) (truncated to 500)
[5/5]  SKIP test.example.com

Imported 3 specs: 578 endpoints across 3 domains
Repo skips: 3 (1 fork, 1 stale, 1 archived)
Spec skips: 2 (1 no server URL, 1 localhost)
GitHub API: 12/5000 requests used
```

When `X-RateLimit-Remaining < 100`, append reset time:
```
GitHub API: 4988/5000 requests used (resets 19:45 PDT)
```

### Dry-Run Output

Same format, prefixed with `(dry run)`, includes `htmlUrl` for click-through:

```
(dry run) [1/5]  OK   api.cloudflare.com  +347 endpoints
               -> https://github.com/cloudflare/api-schemas/blob/main/openapi.json
```

### JSON Output

Same `{ success, imported, failed, skipped, results[] }` shape as other importers, with added fields:

```json
{
  "success": true,
  "imported": 3,
  "failed": 0,
  "skipped": 5,
  "totalEndpoints": 578,
  "repoSkips": [
    { "repo": "cloudflare/cloudflare-docs", "reason": "fork" }
  ],
  "specSkips": [
    { "domain": "gateway.cloudflare.com", "reason": "no server URL" }
  ],
  "results": [
    {
      "index": 1,
      "status": "ok",
      "domain": "api.cloudflare.com",
      "title": "Cloudflare API v4",
      "endpointsAdded": 347,
      "htmlUrl": "https://github.com/cloudflare/api-schemas/blob/main/openapi.json"
    }
  ],
  "githubApiUsage": {
    "used": 12,
    "limit": 5000,
    "resetAt": "2026-03-21T19:45:00Z"
  }
}
```

## Testing Strategy

### Unit Tests (`test/skill/github.test.ts`)

- `resolveGitHubToken()`: test all three paths (gh success, gh failure + env var, neither)
- `searchOrgSpecs()`: mock GitHub API responses, verify dedup by `htmlUrl`, verify ranking (stars desc, path depth asc)
- `searchTopicSpecs()`: mock responses for all four topics, verify dedup by `fullName`, verify `--query` client-side filter, verify `--min-stars` filter
- `normalizeTemplatedDomain()`: `{region}.sentry.io` -> `sentry.io`, `{sub}.{site}.example.com` -> `example.com`, passthrough for non-templated domains
- Filter pipeline: test each filter independently, test ordering, test `--include-stale` bypass

### Integration Tests (`test/skill/github-integration.test.ts`)

- Full org scan with mocked GitHub API -> skill file on disk
- Full topic search with mocked GitHub API -> skill file on disk
- `--dry-run` mode: verify no disk writes
- `--update` mode: verify skip when already imported
- Rate limit handling: verify early-stop on exhausted limit
- Error recovery: verify graceful handling when individual specs fail (continue to next)

### What NOT to test

- Don't test the converter, merger, signer, or writer — those are already covered by existing tests.
- Don't make live GitHub API calls in CI — all tests use mocked responses.

## What This Does NOT Change

- No changes to `convertOpenAPISpec()`, `mergeSkillFile()`, `signSkillFile()`, `writeSkillFile()`, or the search index. The GitHub importer feeds into the existing pipeline unchanged.
- The templated domain normalizer mutates the raw spec object before passing to `convertOpenAPISpec()` — it does not modify the converter itself.
- No new dependencies. Uses `node:child_process` `execFileSync` (already available, no shell injection risk) for `gh auth token` and stdlib `fetch()` for GitHub API calls.

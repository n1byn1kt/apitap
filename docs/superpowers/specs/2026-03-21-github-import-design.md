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
- Parses `X-RateLimit-Remaining` and `X-RateLimit-Reset` from response headers
- On 403 with rate limit exhausted: throw with message including reset time
- Before each batch of parallel requests: check `X-RateLimit-Remaining`, early-stop if 0
- 30s timeout, 10MB response cap (consistent with other importers)
- SSRF validation on URL

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

1. Fan out 4 code search queries in parallel via `Promise.all`:
   - `filename:openapi.json org:<org>`
   - `filename:openapi.yaml org:<org>`
   - `filename:swagger.json org:<org>`
   - `filename:swagger.yaml org:<org>`
2. Dedup results by `htmlUrl`.
3. Rank: repo stars descending, then file path depth ascending (shallower = more likely canonical).
4. Return spec locations with repo metadata.

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

1. Fan out topic queries in parallel via `Promise.all`: `topic:<topic> sort:stars order:desc` for each topic.
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

- Fetches from `raw.githubusercontent.com` URL
- Parses JSON or YAML (js-yaml)
- 10MB size cap
- 30s timeout

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
| 5 | No server URL | No `servers[0].url` and no `host` | `SKIP "spec has no server URL, cannot determine API domain"` |
| 6 | Localhost/example | `servers[0].url` matches `localhost`, `127.0.0.1`, `example.com`, `petstore.swagger.io` | Silent skip (high volume, zero signal) |
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
```

Applied after `extractDomainAndBasePath()`, before SSRF validation. The normalized domain becomes the skill file key.

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
   b. Apply content filters (no-server, localhost, SSRF, template).
   c. `convertOpenAPISpec()`.
   d. Check `--no-auth-only`, `--update`, `--force` (same logic as apis-guru).
   e. Read existing skill file.
   f. `mergeSkillFile()`.
   g. If `--dry-run`: print line, continue.
   h. `signSkillFile()` + `writeSkillFile()`.
   i. 100ms polite delay between fetches.
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
- The templated domain normalizer is applied before the existing pipeline, not inside it.
- No new dependencies. Uses `node:child_process` `execFileSync` (already available, no shell injection risk) for `gh auth token` and stdlib `fetch()` for GitHub API calls.

// src/skill/github.ts
import { execFileSync as _execFileSync } from 'node:child_process';

// ─── Token resolution ─────────────────────────────────────────────────────────

// Indirection so tests can inject a fake without patching non-configurable
// built-in module exports.
let _execFileSyncImpl: typeof _execFileSync = _execFileSync;

/**
 * Override the execFileSync implementation — for testing only.
 * Returns the previous implementation so callers can restore it.
 */
export function _setExecFileSync(impl: typeof _execFileSync): typeof _execFileSync {
  const prev = _execFileSyncImpl;
  _execFileSyncImpl = impl;
  return prev;
}

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
    cachedToken = _execFileSyncImpl('gh', ['auth', 'token'], { timeout: 2000 })
      .toString()
      .trim();
    if (!cachedToken) {
      // gh returned empty output — treat as failure
      throw new Error('empty token');
    }
  } catch {
    cachedToken = process.env.GITHUB_TOKEN ?? null;
  }

  if (cachedToken === null) {
    console.error(
      "Warning: No GitHub token found — rate limited to 60 req/hr. " +
      "Run 'gh auth login' or set GITHUB_TOKEN.",
    );
  }

  return cachedToken;
}

// ─── GitHub API helper ────────────────────────────────────────────────────────

export interface RateLimit {
  remaining: number;
  limit: number;
  resetAt: Date;
}

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Fetch a GitHub API path and return parsed JSON plus rate-limit metadata.
 * Throws with a descriptive message on HTTP errors and size overruns.
 */
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

  // Parse rate limit before checking status (available even on error responses).
  const rateLimit: RateLimit = {
    remaining: parseInt(response.headers.get('x-ratelimit-remaining') ?? '0', 10),
    limit: parseInt(response.headers.get('x-ratelimit-limit') ?? '0', 10),
    resetAt: new Date(
      parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10) * 1000,
    ),
  };

  if (!response.ok) {
    if (response.status === 403 && rateLimit.remaining === 0) {
      const err = new Error(
        `GitHub API rate limit exhausted. Resets at ${rateLimit.resetAt.toLocaleTimeString()}.` +
          ` Run 'gh auth login' for higher limits.`,
      );
      (err as any).status = 403;
      throw err;
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const waitMsg = retryAfter ? ` Retry after ${retryAfter}s.` : '';
      const err = new Error(`GitHub secondary rate limit hit.${waitMsg}`);
      (err as any).status = 429;
      (err as any).retryAfter = retryAfter ? parseInt(retryAfter, 10) : undefined;
      throw err;
    }
    const err = new Error(
      `GitHub API ${response.status} ${response.statusText} for ${path}`,
    );
    (err as any).status = response.status;
    throw err;
  }

  // Size check via Content-Length header (fast path, avoids reading body).
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error(
      `GitHub API response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_SIZE})`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new Error(
      `GitHub API response body too large: ${text.length} bytes (limit: ${MAX_RESPONSE_SIZE})`,
    );
  }

  return { data: JSON.parse(text), rateLimit };
}

// ─── Template domain normalizer ───────────────────────────────────────────────

/**
 * Strips leading `{var}.` template segments from a domain name.
 * e.g. "{region}.api.example.com" → "api.example.com"
 */
export function normalizeTemplatedDomain(domain: string): string {
  let d = domain;
  while (d.startsWith('{')) {
    const next = d.replace(/^\{[^}]+\}\./, '');
    if (next === d) break; // malformed template — stop
    d = next;
  }
  return d;
}

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

// ─── Result types shared across GitHub import tasks ───────────────────────────

/**
 * Represents a single OpenAPI spec file discovered in a GitHub repository.
 * Returned by org-scan and topic-search importers; consumed by the CLI handler.
 */
export interface GitHubSpecResult {
  owner: string;
  repo: string;
  repoFullName: string; // e.g. "cloudflare/api-schemas"
  filePath: string;     // e.g. "openapi.json" or "specs/openapi.json"
  htmlUrl: string;      // GitHub web URL for the file (for dedup + dry-run display)
  specUrl: string;      // raw.githubusercontent.com URL for fetching content
  stars: number;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string;     // ISO timestamp
  description: string;
}

// ─── Filter pipeline ──────────────────────────────────────────────────────────

export interface FilterOptions {
  includeStale?: boolean;
  minStars?: number;
}

export interface FilterResult {
  passed: GitHubSpecResult[];
  skips: Array<{ repo: string; reason: string }>;
}

/** Repos not pushed to in 3 years are considered stale. */
const STALE_THRESHOLD_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/**
 * Run results through the metadata filter pipeline.
 * Skips forks, archived repos, stale repos (>3 years, unless includeStale),
 * and repos below the minStars threshold.
 */
export function filterResults(
  results: GitHubSpecResult[],
  options: FilterOptions,
): FilterResult {
  const passed: GitHubSpecResult[] = [];
  const skips: Array<{ repo: string; reason: string }> = [];

  for (const result of results) {
    if (result.isFork) {
      skips.push({ repo: result.repoFullName, reason: 'fork' });
      continue;
    }
    if (result.isArchived) {
      skips.push({ repo: result.repoFullName, reason: 'archived' });
      continue;
    }
    if (!options.includeStale) {
      const pushedMs = new Date(result.pushedAt).getTime();
      if (Date.now() - pushedMs > STALE_THRESHOLD_MS) {
        const pushedDate = new Date(result.pushedAt).toISOString().slice(0, 10);
        skips.push({ repo: result.repoFullName, reason: `stale, last push ${pushedDate}` });
        continue;
      }
    }
    if (options.minStars !== undefined && result.stars < options.minStars) {
      skips.push({ repo: result.repoFullName, reason: `${result.stars} stars, below --min-stars ${options.minStars}` });
      continue;
    }
    passed.push(result);
  }

  return { passed, skips };
}

// ─── Org Scan — Code Search ───────────────────────────────────────────────────

export const SPEC_FILENAMES = ['openapi.json', 'openapi.yaml', 'swagger.json', 'swagger.yaml'];

/**
 * Uses GitHub's Code Search API to find OpenAPI spec files across an org's repos.
 * Queries run sequentially — GitHub's code search has a secondary rate limit of
 * 30 req/min (authenticated). Parallel fan-out risks immediate 403.
 */
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

// ─── Spec content predicates ──────────────────────────────────────────────────

/**
 * Returns true if the spec has a usable server URL —
 * either OpenAPI 3.x `servers[0].url` or Swagger 2.0 `host`.
 */
export function hasServerUrl(spec: Record<string, any>): boolean {
  if (spec.host) return true;
  if (Array.isArray(spec.servers) && spec.servers.length > 0 && spec.servers[0].url) {
    return true;
  }
  return false;
}

/** Placeholder domains that indicate a spec is not pointing at a real API. */
const PLACEHOLDER_HOSTS = ['localhost', '127.0.0.1', 'example.com', 'petstore.swagger.io'];

/**
 * Returns true if the spec's server URL points at localhost, a loopback address,
 * or a well-known placeholder domain (example.com, petstore.swagger.io).
 */
export function isLocalhostSpec(spec: Record<string, any>): boolean {
  const urls: string[] = [];

  if (spec.host) {
    urls.push(spec.host);
  }
  if (Array.isArray(spec.servers)) {
    for (const server of spec.servers) {
      if (server.url) urls.push(server.url);
    }
  }

  return urls.some(u =>
    PLACEHOLDER_HOSTS.some(ph => u.includes(ph)),
  );
}

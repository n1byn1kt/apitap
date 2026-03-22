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

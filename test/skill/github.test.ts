// test/skill/github.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../src/skill/github.js';

// ─── resolveGitHubToken ──────────────────────────────────────────────────────

describe('resolveGitHubToken', () => {
  // Capture & restore env around every test.
  let origToken: string | undefined;

  beforeEach(() => {
    origToken = process.env.GITHUB_TOKEN;
    // Always start with a clean cache so tests don't bleed into each other.
    github.resetTokenCache();
  });

  afterEach(() => {
    // Restore env var.
    if (origToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = origToken;
    }
    // Restore real execFileSync.
    github._setExecFileSync(
      // Re-import real impl — we get it by calling _setExecFileSync with a
      // no-op and capturing what comes back, then calling once more to restore.
      // Simpler: just store the original before the suite runs.
      _realExecFileSync,
    );
    github.resetTokenCache();
  });

  // Stash a reference to the real impl before any test can replace it.
  let _realExecFileSync: Parameters<typeof github._setExecFileSync>[0];

  // We capture it on the first beforeEach by swapping in identity and back.
  // Actually, just grab it via a sentinel call at module load time:
  // _setExecFileSync always returns the *previous* impl.
  // We call it once here before any tests run to get the original.
  {
    const dummy: any = () => { throw new Error('unreachable'); };
    _realExecFileSync = github._setExecFileSync(dummy);
    // Restore immediately.
    github._setExecFileSync(_realExecFileSync);
  }

  it('returns token from gh CLI when available', async () => {
    // Inject a fake gh that returns a well-known token string.
    github._setExecFileSync((_cmd, _args, _opts) => Buffer.from('ghp_faketoken123\n'));
    delete process.env.GITHUB_TOKEN;

    const token = await github.resolveGitHubToken();

    assert.strictEqual(token, 'ghp_faketoken123');
  });

  it('falls back to GITHUB_TOKEN env var when gh fails', async () => {
    github._setExecFileSync(() => { throw new Error('gh not found'); });
    process.env.GITHUB_TOKEN = 'test-token-123';

    const token = await github.resolveGitHubToken();

    assert.strictEqual(token, 'test-token-123');
  });

  it('returns null and warns when neither gh nor env var available', async () => {
    github._setExecFileSync(() => { throw new Error('gh not found'); });
    delete process.env.GITHUB_TOKEN;

    const warnings: string[] = [];
    const origErr = console.error.bind(console);
    console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

    let token: string | null;
    try {
      token = await github.resolveGitHubToken();
    } finally {
      console.error = origErr;
    }

    assert.strictEqual(token!, null);
    assert.ok(
      warnings.some(
        w =>
          w.includes('rate limit') ||
          w.includes('GITHUB_TOKEN') ||
          w.includes('gh auth'),
      ),
      `Expected a rate-limit warning in stderr, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('caches result across calls', async () => {
    let callCount = 0;
    github._setExecFileSync(() => {
      callCount++;
      return Buffer.from('cached-token\n');
    });
    delete process.env.GITHUB_TOKEN;

    const t1 = await github.resolveGitHubToken();
    const t2 = await github.resolveGitHubToken();

    assert.strictEqual(t1, 'cached-token');
    assert.strictEqual(t2, 'cached-token');
    // execFileSync must only be called once (on the first resolution).
    assert.strictEqual(callCount, 1);
  });

  it('resetTokenCache() forces re-resolution on next call', async () => {
    let callCount = 0;
    github._setExecFileSync(() => {
      callCount++;
      throw new Error('gh not found');
    });

    process.env.GITHUB_TOKEN = 'first-token';
    const t1 = await github.resolveGitHubToken();
    assert.strictEqual(t1, 'first-token');

    // Change env var and reset cache.
    process.env.GITHUB_TOKEN = 'second-token';
    github.resetTokenCache();

    const t2 = await github.resolveGitHubToken();
    assert.strictEqual(t2, 'second-token');

    // execFileSync was called once per resolution attempt.
    assert.strictEqual(callCount, 2);
  });
});

// ─── githubFetch ─────────────────────────────────────────────────────────────

describe('githubFetch', () => {
  // Helpers to build mock Response objects.
  function makeResponse(
    status: number,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Response {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '59',
      'x-ratelimit-limit': '60',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      ...extraHeaders,
    };
    return new Response(JSON.stringify(body), { status, headers });
  }

  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('sets correct headers with token', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = { ...(init?.headers as Record<string, string>) };
      return makeResponse(200, { ok: true });
    };

    await github.githubFetch('/repos/octocat/hello-world', 'my-token');

    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer my-token');
    assert.strictEqual(capturedHeaders['Accept'], 'application/vnd.github+json');
    assert.strictEqual(capturedHeaders['User-Agent'], 'apitap-import');
  });

  it('omits Authorization header when token is null', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = { ...(init?.headers as Record<string, string>) };
      return makeResponse(200, { ok: true });
    };

    await github.githubFetch('/repos/octocat/hello-world', null);

    assert.ok(
      !('Authorization' in capturedHeaders),
      'Authorization header must not be present for null token',
    );
    assert.strictEqual(capturedHeaders['Accept'], 'application/vnd.github+json');
  });

  it('parses rate limit headers from response', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;

    globalThis.fetch = async () =>
      makeResponse(200, { data: 'hello' }, {
        'x-ratelimit-remaining': '42',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': String(resetEpoch),
      });

    const { rateLimit } = await github.githubFetch('/repos/octocat/hello-world', 'tok');

    assert.strictEqual(rateLimit.remaining, 42);
    assert.strictEqual(rateLimit.limit, 5000);
    assert.strictEqual(rateLimit.resetAt.getTime(), resetEpoch * 1000);
  });

  it('throws on 403 rate limit with reset time', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 600;

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '60',
          'x-ratelimit-reset': String(resetEpoch),
        },
      });

    await assert.rejects(
      () => github.githubFetch('/search/repositories', null),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('rate limit'), `message: ${err.message}`);
        assert.strictEqual((err as any).status, 403);
        return true;
      },
    );
  });

  it('throws on 429 secondary rate limit with retry-after', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'secondary rate limit exceeded' }), {
        status: 429,
        headers: {
          'retry-after': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '60',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
        },
      });

    await assert.rejects(
      () => github.githubFetch('/search/repositories', null),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes('secondary rate limit'),
          `message should include "secondary rate limit", got: ${err.message}`,
        );
        assert.strictEqual((err as any).status, 429);
        assert.strictEqual((err as any).retryAfter, 60);
        return true;
      },
    );
  });

  it('throws on non-403 error responses with descriptive message', async () => {
    globalThis.fetch = async () =>
      new Response('{}', {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {
          'x-ratelimit-remaining': '59',
          'x-ratelimit-limit': '60',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });

    await assert.rejects(
      () => github.githubFetch('/repos/x/y', 'tok'),
      (err: Error) => {
        assert.ok(err.message.includes('422'), `expected 422 in: ${err.message}`);
        assert.strictEqual((err as any).status, 422);
        return true;
      },
    );
  });

  it('throws when content-length exceeds 10 MB', async () => {
    const elevenMB = (11 * 1024 * 1024).toString();

    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: {
          'content-length': elevenMB,
          'x-ratelimit-remaining': '59',
          'x-ratelimit-limit': '60',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });

    await assert.rejects(
      () => github.githubFetch('/repos/huge/file', 'tok'),
      /too large/i,
    );
  });

  it('returns parsed JSON data on success', async () => {
    const payload = { id: 1, name: 'hello-world', stargazers_count: 99 };

    globalThis.fetch = async () => makeResponse(200, payload);

    const { data } = await github.githubFetch('/repos/octocat/hello-world', 'tok');

    assert.deepStrictEqual(data, payload);
  });

  it('constructs full GitHub API URL from path', async () => {
    let capturedUrl = '';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return makeResponse(200, {});
    };

    await github.githubFetch('/search/code?q=openapi', 'tok');

    assert.strictEqual(capturedUrl, 'https://api.github.com/search/code?q=openapi');
  });
});

// ─── normalizeTemplatedDomain ─────────────────────────────────────────────────

describe('normalizeTemplatedDomain', () => {
  it('strips a single leading template segment', () => {
    assert.strictEqual(
      github.normalizeTemplatedDomain('{region}.example.com'),
      'example.com',
    );
  });

  it('strips multiple leading template segments', () => {
    assert.strictEqual(
      github.normalizeTemplatedDomain('{tenant}.{region}.api.example.com'),
      'api.example.com',
    );
  });

  it('passes through a plain domain unchanged', () => {
    assert.strictEqual(
      github.normalizeTemplatedDomain('api.example.com'),
      'api.example.com',
    );
  });

  it('does not infinite-loop on malformed input (no trailing dot)', () => {
    // e.g. "{malformed}" has no trailing "." so replace returns same string → break
    assert.strictEqual(
      github.normalizeTemplatedDomain('{malformed}'),
      '{malformed}',
    );
  });

  it('handles a template without a trailing dot gracefully', () => {
    // "{foo}example.com" starts with "{" but replace won't match /^\{[^}]+\}\./
    // so next === d and loop breaks immediately
    assert.strictEqual(
      github.normalizeTemplatedDomain('{foo}example.com'),
      '{foo}example.com',
    );
  });
});

// ─── normalizeSpecServerUrls ──────────────────────────────────────────────────

describe('normalizeSpecServerUrls', () => {
  it('normalizes a leading template in a parseable URL', () => {
    const spec = {
      servers: [{ url: 'https://{region}.example.com/v1' }],
    };
    github.normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://example.com/v1');
  });

  it('is a no-op when URL contains no template', () => {
    const spec = {
      servers: [{ url: 'https://api.example.com/v1' }],
    };
    github.normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://api.example.com/v1');
  });

  it('does nothing when spec has no servers array', () => {
    const spec: Record<string, any> = { openapi: '3.0.0' };
    assert.doesNotThrow(() => github.normalizeSpecServerUrls(spec));
  });

  it('handles a URL that new URL() cannot parse (leading template)', () => {
    // "https://{region}.sentry.io/api" — new URL() throws on this
    const spec = {
      servers: [{ url: 'https://{region}.sentry.io/api' }],
    };
    github.normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://sentry.io/api');
  });

  it('handles multiple template segments', () => {
    const spec = {
      servers: [{ url: 'https://{tenant}.{region}.api.example.com/v2' }],
    };
    github.normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://api.example.com/v2');
  });

  it('processes multiple server entries', () => {
    const spec = {
      servers: [
        { url: 'https://{region}.api.example.com/v1' },
        { url: 'https://api.example.com/v1' },
      ],
    };
    github.normalizeSpecServerUrls(spec);
    assert.strictEqual(spec.servers[0].url, 'https://api.example.com/v1');
    assert.strictEqual(spec.servers[1].url, 'https://api.example.com/v1');
  });

  it('skips server entries with no url field', () => {
    const spec = {
      servers: [{ description: 'no url here' }],
    };
    assert.doesNotThrow(() => github.normalizeSpecServerUrls(spec));
  });
});

// ─── hasServerUrl ─────────────────────────────────────────────────────────────

describe('hasServerUrl', () => {
  it('returns true for spec with servers array containing a url', () => {
    assert.strictEqual(
      github.hasServerUrl({ servers: [{ url: 'https://api.example.com' }] }),
      true,
    );
  });

  it('returns true for Swagger 2.0 spec with host field', () => {
    assert.strictEqual(
      github.hasServerUrl({ host: 'api.example.com' }),
      true,
    );
  });

  it('returns false when spec has neither servers nor host', () => {
    assert.strictEqual(
      github.hasServerUrl({ openapi: '3.0.0' }),
      false,
    );
  });

  it('returns false when servers array is empty', () => {
    assert.strictEqual(
      github.hasServerUrl({ servers: [] }),
      false,
    );
  });

  it('returns false when servers[0] has no url', () => {
    assert.strictEqual(
      github.hasServerUrl({ servers: [{ description: 'no url' }] }),
      false,
    );
  });
});

// ─── isLocalhostSpec ──────────────────────────────────────────────────────────

describe('isLocalhostSpec', () => {
  it('detects localhost in servers url', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ servers: [{ url: 'http://localhost:8080/api' }] }),
      true,
    );
  });

  it('detects 127.0.0.1 in servers url', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ servers: [{ url: 'http://127.0.0.1:3000' }] }),
      true,
    );
  });

  it('detects example.com as a placeholder domain', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ servers: [{ url: 'https://api.example.com/v1' }] }),
      true,
    );
  });

  it('detects petstore.swagger.io as a placeholder domain', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ servers: [{ url: 'https://petstore.swagger.io/v2' }] }),
      true,
    );
  });

  it('returns false for a real production domain', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ servers: [{ url: 'https://api.github.com' }] }),
      false,
    );
  });

  it('returns false when spec has no servers', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ openapi: '3.0.0' }),
      false,
    );
  });

  it('checks swagger 2.0 host field for localhost', () => {
    assert.strictEqual(
      github.isLocalhostSpec({ host: 'localhost' }),
      true,
    );
  });
});

// ─── filterResults ────────────────────────────────────────────────────────────

/** Helper to build a minimal valid GitHubSpecResult. */
function makeSpec(overrides: Partial<github.GitHubSpecResult> = {}): github.GitHubSpecResult {
  return {
    owner: 'acme',
    repo: 'api-spec',
    repoFullName: 'acme/api-spec',
    filePath: 'openapi.json',
    htmlUrl: 'https://github.com/acme/api-spec/blob/main/openapi.json',
    specUrl: 'https://raw.githubusercontent.com/acme/api-spec/main/openapi.json',
    stars: 100,
    isFork: false,
    isArchived: false,
    pushedAt: new Date().toISOString(), // recent
    description: 'Test API',
    ...overrides,
  };
}

describe('filterResults', () => {
  it('passes a valid, non-fork, non-archived, recent repo', () => {
    const result = github.filterResults([makeSpec()], {});
    assert.strictEqual(result.passed.length, 1);
    assert.strictEqual(result.skips.length, 0);
  });

  it('skips forks', () => {
    const result = github.filterResults([makeSpec({ isFork: true })], {});
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.skips.length, 1);
    assert.ok(result.skips[0].reason.toLowerCase().includes('fork'));
  });

  it('skips archived repos', () => {
    const result = github.filterResults([makeSpec({ isArchived: true })], {});
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.skips.length, 1);
    assert.ok(result.skips[0].reason.toLowerCase().includes('archiv'));
  });

  it('skips stale repos (pushed > 3 years ago) by default', () => {
    const fourYearsAgo = new Date('2020-01-01T00:00:00Z');
    const result = github.filterResults(
      [makeSpec({ pushedAt: fourYearsAgo.toISOString() })],
      {},
    );
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.skips.length, 1);
    assert.ok(result.skips[0].reason.toLowerCase().includes('stale'));
    assert.ok(
      result.skips[0].reason.includes('2020-01-01'),
      `expected date "2020-01-01" in stale reason, got: ${result.skips[0].reason}`,
    );
  });

  it('includes stale repos when includeStale=true', () => {
    const fourYearsAgo = new Date();
    fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
    const result = github.filterResults(
      [makeSpec({ pushedAt: fourYearsAgo.toISOString() })],
      { includeStale: true },
    );
    assert.strictEqual(result.passed.length, 1);
    assert.strictEqual(result.skips.length, 0);
  });

  it('skips repos below minStars threshold', () => {
    const result = github.filterResults(
      [makeSpec({ stars: 2 })],
      { minStars: 5 },
    );
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.skips.length, 1);
    assert.ok(result.skips[0].reason.toLowerCase().includes('star'));
    assert.ok(
      result.skips[0].reason.includes('--min-stars'),
      `expected "--min-stars" in stars reason, got: ${result.skips[0].reason}`,
    );
    assert.ok(
      result.skips[0].reason.includes('2'),
      `expected star count "2" in stars reason, got: ${result.skips[0].reason}`,
    );
  });

  it('passes repos meeting minStars threshold exactly', () => {
    const result = github.filterResults(
      [makeSpec({ stars: 5 })],
      { minStars: 5 },
    );
    assert.strictEqual(result.passed.length, 1);
    assert.strictEqual(result.skips.length, 0);
  });

  it('records correct repo name in skips', () => {
    const result = github.filterResults(
      [makeSpec({ repoFullName: 'myorg/myrepo', isFork: true })],
      {},
    );
    assert.strictEqual(result.skips[0].repo, 'myorg/myrepo');
  });

  it('handles empty input array', () => {
    const result = github.filterResults([], {});
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.skips.length, 0);
  });
});

// ─── GitHubSpecResult interface shape ────────────────────────────────────────

describe('GitHubSpecResult interface', () => {
  it('can be constructed with all required fields', () => {
    // Construct an object matching the exported interface and validate shape.
    const result: github.GitHubSpecResult = {
      owner: 'cloudflare',
      repo: 'api-schemas',
      repoFullName: 'cloudflare/api-schemas',
      filePath: 'openapi.json',
      htmlUrl: 'https://github.com/cloudflare/api-schemas/blob/main/openapi.json',
      specUrl: 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json',
      stars: 1200,
      isFork: false,
      isArchived: false,
      pushedAt: '2026-01-15T10:00:00Z',
      description: 'Cloudflare API schema',
    };

    assert.strictEqual(typeof result.owner, 'string');
    assert.strictEqual(typeof result.repo, 'string');
    assert.strictEqual(typeof result.repoFullName, 'string');
    assert.strictEqual(typeof result.filePath, 'string');
    assert.strictEqual(typeof result.htmlUrl, 'string');
    assert.strictEqual(typeof result.specUrl, 'string');
    assert.strictEqual(typeof result.stars, 'number');
    assert.strictEqual(typeof result.isFork, 'boolean');
    assert.strictEqual(typeof result.isArchived, 'boolean');
    assert.strictEqual(typeof result.pushedAt, 'string');
    assert.strictEqual(typeof result.description, 'string');
  });
});

// ─── searchOrgSpecs ───────────────────────────────────────────────────────────

/** Build a minimal GitHub Code Search API item for a given filename. */
function makeCodeSearchItem(
  overrides: {
    path?: string;
    htmlUrl?: string;
    repoFullName?: string;
    stars?: number;
    fork?: boolean;
    archived?: boolean;
    pushedAt?: string;
    defaultBranch?: string;
    description?: string;
    ownerLogin?: string;
  } = {},
) {
  const repoFullName = overrides.repoFullName ?? 'acme/api-spec';
  const [ownerLogin, repoName] = repoFullName.split('/');
  const path = overrides.path ?? 'openapi.json';
  return {
    path,
    html_url: overrides.htmlUrl ?? `https://github.com/${repoFullName}/blob/main/${path}`,
    repository: {
      name: repoName,
      full_name: repoFullName,
      owner: { login: overrides.ownerLogin ?? ownerLogin },
      stargazers_count: overrides.stars ?? 100,
      fork: overrides.fork ?? false,
      archived: overrides.archived ?? false,
      pushed_at: overrides.pushedAt ?? '2025-01-01T00:00:00Z',
      default_branch: overrides.defaultBranch ?? 'main',
      description: overrides.description ?? 'Test repo',
    },
  };
}

/** Build a mock Response for the code search API. */
function makeCodeSearchResponse(items: unknown[]): Response {
  return new Response(
    JSON.stringify({ total_count: items.length, incomplete_results: false, items }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '25',
        'x-ratelimit-limit': '30',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      },
    },
  );
}

describe('searchOrgSpecs', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  // Helper: URL-aware fetch mock that returns empty org repos for the heuristic phase
  function makeOrgAwareFetch(codeSearchResponses: Response[]) {
    let codeSearchIndex = 0;
    return async (input: RequestInfo | URL) => {
      const url = input.toString();
      // Code search queries
      if (url.includes('/search/code')) {
        return codeSearchResponses[codeSearchIndex++] ?? makeCodeSearchResponse([]);
      }
      // Org repos listing (heuristic phase) — return empty
      if (url.includes('/orgs/') && url.includes('/repos')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }
      // Contents probe — return empty array
      if (url.includes('/contents')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }
      return makeCodeSearchResponse([]);
    };
  }

  it('queries 4 filename patterns and deduplicates by htmlUrl', async () => {
    const capturedUrls: string[] = [];

    // Return one item per query, but make the openapi.yaml item share an htmlUrl
    // with the openapi.json item to verify dedup.
    const sharedHtmlUrl = 'https://github.com/acme/api-spec/blob/main/openapi.json';
    const codeSearchResponses = [
      makeCodeSearchResponse([
        makeCodeSearchItem({ htmlUrl: sharedHtmlUrl, path: 'openapi.json' }),
      ]),
      makeCodeSearchResponse([
        makeCodeSearchItem({ htmlUrl: sharedHtmlUrl, path: 'openapi.json' }),
      ]),
      makeCodeSearchResponse([
        makeCodeSearchItem({
          htmlUrl: 'https://github.com/acme/api-spec/blob/main/swagger.json',
          path: 'swagger.json',
        }),
      ]),
      makeCodeSearchResponse([]),
    ];
    let codeSearchIndex = 0;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      capturedUrls.push(url);
      if (url.includes('/search/code')) {
        return codeSearchResponses[codeSearchIndex++] ?? makeCodeSearchResponse([]);
      }
      // Org repos listing — return empty (no heuristic matches)
      if (url.includes('/orgs/') && url.includes('/repos')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }
      return makeCodeSearchResponse([]);
    };

    const results = await github.searchOrgSpecs('acme', 'tok');

    // 4 code search queries should have been made
    const codeSearchUrls = capturedUrls.filter(u => u.includes('/search/code'));
    assert.strictEqual(codeSearchUrls.length, 4);
    assert.ok(codeSearchUrls[0].includes('filename%3Aopenapi.json'), `q0: ${codeSearchUrls[0]}`);
    assert.ok(codeSearchUrls[1].includes('filename%3Aopenapi.yaml'), `q1: ${codeSearchUrls[1]}`);
    assert.ok(codeSearchUrls[2].includes('filename%3Aswagger.json'), `q2: ${codeSearchUrls[2]}`);
    assert.ok(codeSearchUrls[3].includes('filename%3Aswagger.yaml'), `q3: ${codeSearchUrls[3]}`);

    // Dedup: 2 items with sharedHtmlUrl → 1, plus the swagger.json → total 2
    assert.strictEqual(results.length, 2);
    const htmlUrls = results.map(r => r.htmlUrl);
    assert.strictEqual(new Set(htmlUrls).size, 2, 'All htmlUrls must be unique after dedup');
  });

  it('ranks by stars descending then path depth ascending', async () => {
    const items = [
      makeCodeSearchItem({
        htmlUrl: 'https://github.com/acme/low-stars-shallow/blob/main/openapi.json',
        repoFullName: 'acme/low-stars-shallow',
        path: 'openapi.json',
        stars: 10,
      }),
      makeCodeSearchItem({
        htmlUrl: 'https://github.com/acme/high-stars-deep/blob/main/specs/v2/openapi.json',
        repoFullName: 'acme/high-stars-deep',
        path: 'specs/v2/openapi.json',
        stars: 1000,
      }),
      makeCodeSearchItem({
        htmlUrl: 'https://github.com/acme/high-stars-shallow/blob/main/openapi.json',
        repoFullName: 'acme/high-stars-shallow',
        path: 'openapi.json',
        stars: 1000,
      }),
      makeCodeSearchItem({
        htmlUrl: 'https://github.com/acme/low-stars-deep/blob/main/specs/openapi.json',
        repoFullName: 'acme/low-stars-deep',
        path: 'specs/openapi.json',
        stars: 10,
      }),
    ];
    globalThis.fetch = makeOrgAwareFetch([makeCodeSearchResponse(items)]);

    const results = await github.searchOrgSpecs('acme', 'tok');

    assert.strictEqual(results.length, 4);
    // High stars first
    assert.strictEqual(results[0].stars, 1000);
    assert.strictEqual(results[1].stars, 1000);
    // Among high-stars: shallower path first (depth 1 < depth 3)
    assert.strictEqual(results[0].filePath, 'openapi.json');
    assert.strictEqual(results[1].filePath, 'specs/v2/openapi.json');
    // Low stars last
    assert.strictEqual(results[2].stars, 10);
    assert.strictEqual(results[3].stars, 10);
    // Among low-stars: shallower path first
    assert.strictEqual(results[2].filePath, 'openapi.json');
    assert.strictEqual(results[3].filePath, 'specs/openapi.json');
  });

  it('maps code search response to GitHubSpecResult', async () => {
    const item = makeCodeSearchItem({
      path: 'specs/openapi.json',
      htmlUrl: 'https://github.com/cloudflare/api-schemas/blob/main/specs/openapi.json',
      repoFullName: 'cloudflare/api-schemas',
      stars: 1200,
      fork: false,
      archived: false,
      pushedAt: '2026-01-15T10:00:00Z',
      defaultBranch: 'main',
      description: 'Cloudflare public API schemas',
      ownerLogin: 'cloudflare',
    });

    globalThis.fetch = makeOrgAwareFetch([makeCodeSearchResponse([item])]);

    const results = await github.searchOrgSpecs('cloudflare', 'tok');

    assert.strictEqual(results.length, 1);
    const r = results[0];
    assert.strictEqual(r.owner, 'cloudflare');
    assert.strictEqual(r.repo, 'api-schemas');
    assert.strictEqual(r.repoFullName, 'cloudflare/api-schemas');
    assert.strictEqual(r.filePath, 'specs/openapi.json');
    assert.strictEqual(r.htmlUrl, 'https://github.com/cloudflare/api-schemas/blob/main/specs/openapi.json');
    assert.strictEqual(r.specUrl, 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/specs/openapi.json');
    assert.strictEqual(r.stars, 1200);
    assert.strictEqual(r.isFork, false);
    assert.strictEqual(r.isArchived, false);
    assert.strictEqual(r.pushedAt, '2026-01-15T10:00:00Z');
    assert.strictEqual(r.description, 'Cloudflare public API schemas');
  });

  it('throws descriptive error for nonexistent org (422)', async () => {
    globalThis.fetch = async () =>
      new Response('{}', {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {
          'x-ratelimit-remaining': '29',
          'x-ratelimit-limit': '30',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
        },
      });

    await assert.rejects(
      () => github.searchOrgSpecs('nonexistent-org-xyz', 'tok'),
      (err: Error) => {
        assert.ok(
          err.message.includes('nonexistent-org-xyz'),
          `Expected org name in error message, got: ${err.message}`,
        );
        assert.ok(
          err.message.toLowerCase().includes('not found'),
          `Expected "not found" in error message, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('returns empty array when no specs found', async () => {
    globalThis.fetch = makeOrgAwareFetch([]);

    const results = await github.searchOrgSpecs('empty-org', 'tok');

    assert.strictEqual(results.length, 0);
    assert.ok(Array.isArray(results));
  });

  it('finds specs via name-heuristic when code search returns nothing', async () => {
    // Code search returns nothing, but org has a repo named "api-schemas"
    // with openapi.json at root — name heuristic should find it.
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();

      // Code search — return empty for all 4 patterns
      if (url.includes('/search/code')) {
        return makeCodeSearchResponse([]);
      }

      // Org repos listing — return one repo matching the name heuristic
      if (url.includes('/orgs/acme/repos')) {
        return new Response(JSON.stringify([
          {
            name: 'api-schemas',
            full_name: 'acme/api-schemas',
            owner: { login: 'acme' },
            stargazers_count: 160,
            fork: false,
            archived: false,
            pushed_at: '2026-03-01T00:00:00Z',
            default_branch: 'main',
            description: 'Public API schemas',
          },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }

      // Contents probe for api-schemas root — has openapi.json
      if (url.includes('/repos/acme/api-schemas/contents') && !url.includes('/contents/')) {
        return new Response(JSON.stringify([
          { name: 'openapi.json', path: 'openapi.json', html_url: 'https://github.com/acme/api-schemas/blob/main/openapi.json' },
          { name: 'README.md', path: 'README.md', html_url: 'https://github.com/acme/api-schemas/blob/main/README.md' },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }

      return makeCodeSearchResponse([]);
    };

    const results = await github.searchOrgSpecs('acme', 'tok');

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].repoFullName, 'acme/api-schemas');
    assert.strictEqual(results[0].filePath, 'openapi.json');
    assert.strictEqual(results[0].stars, 160);
  });

  it('deduplicates between code search and name-heuristic results', async () => {
    // Code search finds a spec, name heuristic finds the same repo — should dedup
    const htmlUrl = 'https://github.com/acme/openapi/blob/main/openapi.json';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.includes('/search/code')) {
        return makeCodeSearchResponse([
          makeCodeSearchItem({ htmlUrl, path: 'openapi.json', repoFullName: 'acme/openapi' }),
        ]);
      }

      if (url.includes('/orgs/acme/repos')) {
        return new Response(JSON.stringify([
          { name: 'openapi', full_name: 'acme/openapi', owner: { login: 'acme' }, stargazers_count: 50, fork: false, archived: false, pushed_at: '2026-01-01T00:00:00Z', default_branch: 'main', description: '' },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }

      if (url.includes('/repos/acme/openapi/contents')) {
        return new Response(JSON.stringify([
          { name: 'openapi.json', path: 'openapi.json', html_url: htmlUrl },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }

      return makeCodeSearchResponse([]);
    };

    const results = await github.searchOrgSpecs('acme', 'tok');
    assert.strictEqual(results.length, 1, 'Should dedup code search + heuristic results');
  });

  it('skips repos whose names do not match heuristic patterns', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/search/code')) return makeCodeSearchResponse([]);
      if (url.includes('/orgs/acme/repos')) {
        return new Response(JSON.stringify([
          { name: 'website', full_name: 'acme/website', owner: { login: 'acme' }, stargazers_count: 5000, fork: false, archived: false, pushed_at: '2026-01-01T00:00:00Z', default_branch: 'main', description: '' },
          { name: 'docs', full_name: 'acme/docs', owner: { login: 'acme' }, stargazers_count: 3000, fork: false, archived: false, pushed_at: '2026-01-01T00:00:00Z', default_branch: 'main', description: '' },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
        });
      }
      return makeCodeSearchResponse([]);
    };

    const results = await github.searchOrgSpecs('acme', 'tok');
    assert.strictEqual(results.length, 0, 'Non-matching repo names should not be probed');
  });
});

// ─── searchTopicSpecs ─────────────────────────────────────────────────────────

/** Build a minimal GitHub Repository Search API item. */
function makeRepoSearchItem(
  overrides: {
    fullName?: string;
    stars?: number;
    fork?: boolean;
    archived?: boolean;
    pushedAt?: string;
    defaultBranch?: string;
    description?: string;
  } = {},
) {
  const fullName = overrides.fullName ?? 'acme/api-spec';
  const [ownerLogin, repoName] = fullName.split('/');
  return {
    name: repoName,
    full_name: fullName,
    owner: { login: ownerLogin },
    stargazers_count: overrides.stars ?? 100,
    fork: overrides.fork ?? false,
    archived: overrides.archived ?? false,
    pushed_at: overrides.pushedAt ?? '2025-01-01T00:00:00Z',
    default_branch: overrides.defaultBranch ?? 'main',
    description: overrides.description ?? 'Test repo',
  };
}

/** Build a mock Response for the repo search API. */
function makeRepoSearchResponse(items: unknown[]): Response {
  return new Response(
    JSON.stringify({ total_count: items.length, incomplete_results: false, items }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '25',
        'x-ratelimit-limit': '30',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      },
    },
  );
}

/** Build a mock Response for the contents API (directory listing). */
function makeContentsResponse(entries: Array<{ name: string; path: string; html_url: string }>): Response {
  return new Response(
    JSON.stringify(entries),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '25',
        'x-ratelimit-limit': '30',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      },
    },
  );
}

/** Build a 404 Response for contents API (directory doesn't exist). */
function make404Response(): Response {
  return new Response('{"message":"Not Found"}', {
    status: 404,
    statusText: 'Not Found',
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '25',
      'x-ratelimit-limit': '30',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    },
  });
}

describe('searchTopicSpecs', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('searches all 4 canonical topics when given all', async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      capturedUrls.push(url);
      if (url.includes('/search/repositories')) {
        return makeRepoSearchResponse([]);
      }
      return makeContentsResponse([]);
    };

    await github.searchTopicSpecs(github.CANONICAL_TOPICS, 'tok', { minStars: 0 });

    const searchUrls = capturedUrls.filter(u => u.includes('/search/repositories'));
    assert.strictEqual(searchUrls.length, 4, `Expected 4 topic search calls, got ${searchUrls.length}`);
    assert.ok(searchUrls.some(u => u.includes('openapi-specification')), 'Missing openapi-specification topic');
    assert.ok(searchUrls.some(u => u.includes('topic%3Aopenapi')), 'Missing openapi topic');
    assert.ok(searchUrls.some(u => u.includes('openapi3')), 'Missing openapi3 topic');
    assert.ok(searchUrls.some(u => u.includes('swagger-api')), 'Missing swagger-api topic');
  });

  it('searches single topic when given one', async () => {
    const capturedUrls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      capturedUrls.push(url);
      if (url.includes('/search/repositories')) {
        return makeRepoSearchResponse([]);
      }
      return makeContentsResponse([]);
    };

    await github.searchTopicSpecs(['openapi'], 'tok', { minStars: 0 });

    const searchUrls = capturedUrls.filter(u => u.includes('/search/repositories'));
    assert.strictEqual(searchUrls.length, 1, `Expected 1 search call, got ${searchUrls.length}`);
    assert.ok(searchUrls[0].includes('topic%3Aopenapi'), `URL should contain topic:openapi, got: ${searchUrls[0]}`);
  });

  it('deduplicates repos by fullName across topics', async () => {
    const sharedRepo = makeRepoSearchItem({ fullName: 'acme/shared-repo', stars: 200 });
    let searchCallCount = 0;
    let contentsCallCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/search/repositories')) {
        searchCallCount++;
        // Both topics return the same repo
        return makeRepoSearchResponse([sharedRepo]);
      }
      // Contents calls — return a spec at root
      contentsCallCount++;
      if (!url.includes('/contents/')) {
        // Root contents
        return makeContentsResponse([
          { name: 'openapi.json', path: 'openapi.json', html_url: 'https://github.com/acme/shared-repo/blob/main/openapi.json' },
        ]);
      }
      return make404Response();
    };

    const results = await github.searchTopicSpecs(['openapi', 'openapi3'], 'tok', { minStars: 0 });

    // Should only probe once despite appearing in 2 topic results
    assert.strictEqual(results.length, 1, `Expected 1 result (deduped), got ${results.length}`);
    assert.strictEqual(results[0].repoFullName, 'acme/shared-repo');
    assert.strictEqual(searchCallCount, 2, 'Should have made 2 search calls (one per topic)');
  });

  it('filters by minStars', async () => {
    const lowStarRepo = makeRepoSearchItem({ fullName: 'acme/low-stars', stars: 3 });
    const highStarRepo = makeRepoSearchItem({ fullName: 'acme/high-stars', stars: 500 });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/search/repositories')) {
        return makeRepoSearchResponse([lowStarRepo, highStarRepo]);
      }
      // Contents for high-stars repo only
      if (url.includes('high-stars') && !url.includes('/contents/')) {
        return makeContentsResponse([
          { name: 'openapi.json', path: 'openapi.json', html_url: 'https://github.com/acme/high-stars/blob/main/openapi.json' },
        ]);
      }
      return make404Response();
    };

    const results = await github.searchTopicSpecs(['openapi'], 'tok', { minStars: 10 });

    assert.ok(results.every(r => r.stars >= 10), 'All results should meet minStars threshold');
    assert.ok(results.every(r => r.repoFullName !== 'acme/low-stars'), 'Low-star repo should be excluded');
  });

  it('applies client-side query filter on name and description', async () => {
    const matchByName = makeRepoSearchItem({ fullName: 'acme/stripe-api', description: 'General API' });
    const matchByDesc = makeRepoSearchItem({ fullName: 'acme/payments', description: 'stripe integration' });
    const noMatch = makeRepoSearchItem({ fullName: 'acme/unrelated', description: 'Something else entirely' });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/search/repositories')) {
        return makeRepoSearchResponse([matchByName, matchByDesc, noMatch]);
      }
      // Return a spec file for any repo that makes it past the filter
      if (!url.includes('/contents/')) {
        const repoMatch = url.match(/\/repos\/[^/]+\/([^/]+)\/contents/);
        const repoName = repoMatch?.[1] ?? '';
        return makeContentsResponse([
          { name: 'openapi.json', path: 'openapi.json', html_url: `https://github.com/acme/${repoName}/blob/main/openapi.json` },
        ]);
      }
      return make404Response();
    };

    const results = await github.searchTopicSpecs(['openapi'], 'tok', { minStars: 0, query: 'stripe' });

    const repoNames = results.map(r => r.repoFullName);
    assert.ok(repoNames.includes('acme/stripe-api'), 'Should match by repo name');
    assert.ok(repoNames.includes('acme/payments'), 'Should match by description');
    assert.ok(!repoNames.includes('acme/unrelated'), 'Should exclude non-matching repo');
  });

  it('probes repos for spec files at root and common subdirs', async () => {
    const repo = makeRepoSearchItem({ fullName: 'acme/spec-in-docs', stars: 100 });
    const probedPaths: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/search/repositories')) {
        return makeRepoSearchResponse([repo]);
      }
      // Track contents API calls
      probedPaths.push(url);
      if (url.endsWith('/contents')) {
        // Root — no spec files
        return makeContentsResponse([{ name: 'README.md', path: 'README.md', html_url: 'https://github.com/acme/spec-in-docs/blob/main/README.md' }]);
      }
      if (url.endsWith('/contents/api')) {
        return makeContentsResponse([]);
      }
      if (url.endsWith('/contents/spec')) {
        return makeContentsResponse([]);
      }
      if (url.endsWith('/contents/docs')) {
        // Spec found in docs/
        return makeContentsResponse([
          { name: 'openapi.yaml', path: 'docs/openapi.yaml', html_url: 'https://github.com/acme/spec-in-docs/blob/main/docs/openapi.yaml' },
        ]);
      }
      return make404Response();
    };

    const results = await github.searchTopicSpecs(['openapi'], 'tok', { minStars: 0 });

    assert.strictEqual(results.length, 1, `Expected 1 result, got ${results.length}`);
    assert.strictEqual(results[0].filePath, 'docs/openapi.yaml');
    // Should have probed root, api, spec, docs (stopped after finding in docs)
    assert.ok(probedPaths.some(p => p.endsWith('/contents')), 'Should probe root');
    assert.ok(probedPaths.some(p => p.endsWith('/contents/api')), 'Should probe api/');
    assert.ok(probedPaths.some(p => p.endsWith('/contents/spec')), 'Should probe spec/');
    assert.ok(probedPaths.some(p => p.endsWith('/contents/docs')), 'Should probe docs/');
  });

  it('skips repos where no spec file is found', async () => {
    const repo = makeRepoSearchItem({ fullName: 'acme/no-specs', stars: 100 });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/search/repositories')) {
        return makeRepoSearchResponse([repo]);
      }
      // Return non-spec files everywhere
      return makeContentsResponse([
        { name: 'README.md', path: 'README.md', html_url: 'https://github.com/acme/no-specs/blob/main/README.md' },
      ]);
    };

    const results = await github.searchTopicSpecs(['openapi'], 'tok', { minStars: 0 });

    assert.strictEqual(results.length, 0, `Expected 0 results, got ${results.length}`);
  });
});

// ─── fetchGitHubSpec ──────────────────────────────────────────────────────────

describe('fetchGitHubSpec', () => {
  const TEST_URL = 'https://raw.githubusercontent.com/acme/api-spec/main/openapi.json';

  let origFetch: typeof globalThis.fetch;
  let restoreSsrf: ReturnType<typeof github._setResolveAndValidateUrl>;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    // Inject a fake SSRF validator that always returns safe — avoids real DNS in tests.
    restoreSsrf = github._setResolveAndValidateUrl(async (_url: string) => ({ safe: true }));
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    github._setResolveAndValidateUrl(restoreSsrf);
  });

  it('fetches and parses JSON spec from specUrl', async () => {
    const spec = { openapi: '3.0.0', info: { title: 'Test API' }, paths: {} };

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(JSON.stringify(spec), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await github.fetchGitHubSpec(TEST_URL, 'my-token');

    assert.deepStrictEqual(result, spec);
  });

  it('fetches and parses YAML spec', async () => {
    const yamlBody = [
      'openapi: "3.0.0"',
      'info:',
      '  title: YAML API',
      'paths: {}',
    ].join('\n');

    globalThis.fetch = async () =>
      new Response(yamlBody, {
        status: 200,
        headers: { 'content-type': 'application/yaml' },
      });

    const result = await github.fetchGitHubSpec(TEST_URL, null);

    assert.strictEqual(result.openapi, '3.0.0');
    assert.deepStrictEqual(result.info, { title: 'YAML API' });
  });

  it('throws on response > 10MB (content-length header)', async () => {
    const elevenMB = (11 * 1024 * 1024).toString();

    globalThis.fetch = async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': elevenMB },
      });

    await assert.rejects(
      () => github.fetchGitHubSpec(TEST_URL, null),
      /too large/i,
    );
  });

  it('throws on response body > 10MB (body size check)', async () => {
    const bigBody = 'x'.repeat(11 * 1024 * 1024);

    globalThis.fetch = async () =>
      new Response(bigBody, { status: 200 });

    await assert.rejects(
      () => github.fetchGitHubSpec(TEST_URL, null),
      /too large/i,
    );
  });

  it('does not use githubFetch (uses direct fetch to raw.githubusercontent.com)', async () => {
    const spec = { openapi: '3.0.0', paths: {} };
    const capturedUrls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrls.push(input.toString());
      return new Response(JSON.stringify(spec), { status: 200 });
    };

    await github.fetchGitHubSpec(TEST_URL, 'tok');

    // Must call raw.githubusercontent.com directly, NOT api.github.com
    assert.strictEqual(capturedUrls.length, 1, 'Expected exactly one fetch call');
    assert.ok(
      capturedUrls[0].startsWith('https://raw.githubusercontent.com/'),
      `Expected raw.githubusercontent.com URL, got: ${capturedUrls[0]}`,
    );
    assert.ok(
      !capturedUrls[0].includes('api.github.com'),
      'Must not use api.github.com (githubFetch)',
    );
  });

  it('sends Authorization header when token is provided', async () => {
    const spec = { openapi: '3.0.0', paths: {} };
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = { ...(init?.headers as Record<string, string>) };
      return new Response(JSON.stringify(spec), { status: 200 });
    };

    await github.fetchGitHubSpec(TEST_URL, 'ghp_mytoken');

    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer ghp_mytoken');
    assert.strictEqual(capturedHeaders['User-Agent'], 'apitap-import');
  });

  it('omits Authorization header when token is null', async () => {
    const spec = { openapi: '3.0.0', paths: {} };
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = { ...(init?.headers as Record<string, string>) };
      return new Response(JSON.stringify(spec), { status: 200 });
    };

    await github.fetchGitHubSpec(TEST_URL, null);

    assert.ok(
      !('Authorization' in capturedHeaders),
      'Authorization header must not be present for null token',
    );
  });

  it('throws on non-OK HTTP response', async () => {
    globalThis.fetch = async () =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' });

    await assert.rejects(
      () => github.fetchGitHubSpec(TEST_URL, null),
      /HTTP 404/,
    );
  });

  it('throws when SSRF check fails', async () => {
    // Override to return unsafe
    github._setResolveAndValidateUrl(async (_url: string) => ({
      safe: false,
      reason: 'DNS rebinding: raw.githubusercontent.com resolves to 127.0.0.1',
    }));

    await assert.rejects(
      () => github.fetchGitHubSpec(TEST_URL, null),
      /SSRF check failed/,
    );
  });

  it('throws when content is neither valid JSON nor a YAML object (bare scalar)', async () => {
    // "just a string" fails JSON.parse, then YAML parses it as a string (not an object)
    // → triggers the "Invalid JSON/YAML" guard
    globalThis.fetch = async () =>
      new Response('just a string', { status: 200 });

    await assert.rejects(
      () => github.fetchGitHubSpec(TEST_URL, null),
      /Invalid JSON\/YAML/,
    );
  });
});

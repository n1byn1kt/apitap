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

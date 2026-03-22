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

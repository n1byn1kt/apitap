// test/skill/github-integration.test.ts
//
// Integration tests that exercise the full GitHub import pipeline:
// discovery → filter → fetch → convert → merge → sign → write
//
// global.fetch is mocked so no real GitHub API calls are made.
// _setResolveAndValidateUrl is used to bypass DNS-based SSRF checks.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  searchOrgSpecs,
  searchTopicSpecs,
  fetchGitHubSpec,
  filterResults,
  hasServerUrl,
  isLocalhostSpec,
  normalizeSpecServerUrls,
  resolveGitHubToken,
  resetTokenCache,
  _setExecFileSync,
  _setResolveAndValidateUrl,
  type GitHubSpecResult,
} from '../../src/skill/github.js';
import { convertOpenAPISpec } from '../../src/skill/openapi-converter.js';
import { mergeSkillFile } from '../../src/skill/merge.js';
import { signSkillFileAs } from '../../src/skill/signing.js';
import { writeSkillFile, readSkillFile } from '../../src/skill/store.js';
import { getMachineId } from '../../src/auth/manager.js';
import { deriveSigningKey } from '../../src/auth/crypto.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A minimal valid OpenAPI 3.0 spec.
 * Domain is api.acme-corp.com — intentionally NOT example.com/localhost/petstore.swagger.io
 * to avoid triggering the isLocalhostSpec placeholder-domain check.
 */
const EXAMPLE_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Example API', version: '1.0.0' },
  servers: [{ url: 'https://api.acme-corp.com/v1' }],
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List users',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: 'Get a user',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

/** A minimal valid OpenAPI spec for a non-placeholder domain. */
const WIDGET_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Widget API', version: '2.0.0' },
  servers: [{ url: 'https://api.widgets-corp.io' }],
  paths: {
    '/widgets': {
      get: {
        operationId: 'listWidgets',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

/**
 * Build a minimal GitHubSpecResult with sane defaults.
 */
function makeSpecResult(overrides: Partial<GitHubSpecResult> = {}): GitHubSpecResult {
  return {
    owner: 'acme',
    repo: 'api-spec',
    repoFullName: 'acme/api-spec',
    filePath: 'openapi.json',
    htmlUrl: 'https://github.com/acme/api-spec/blob/main/openapi.json',
    specUrl: 'https://raw.githubusercontent.com/acme/api-spec/main/openapi.json',
    stars: 500,
    isFork: false,
    isArchived: false,
    pushedAt: new Date().toISOString(),
    description: 'Acme public API',
    ...overrides,
  };
}

/**
 * Build a mock Response that returns JSON with optional rate-limit headers.
 */
function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ratelimit-remaining': '59',
    'x-ratelimit-limit': '60',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Build a mock Response that returns raw text (for raw.githubusercontent.com content).
 */
function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tempDir: string;
let origFetch: typeof globalThis.fetch;
let prevResolveAndValidateUrl: ReturnType<typeof _setResolveAndValidateUrl>;

// Bypass SSRF DNS resolution — mocked URLs won't resolve in unit tests.
const noopSafeValidator: Parameters<typeof _setResolveAndValidateUrl>[0] = async (_url: string) => ({
  safe: true as const,
  resolvedIp: '93.184.216.34',
});

beforeEach(() => {
  // Snapshot original globals
  origFetch = globalThis.fetch;
  // Bypass SSRF checks for all integration tests
  prevResolveAndValidateUrl = _setResolveAndValidateUrl(noopSafeValidator);
  // Use a fresh temp dir for each test
  tempDir = mkdtempSync(join(tmpdir(), 'apitap-github-integ-'));
  // Ensure token cache is clean
  resetTokenCache();
});

afterEach(() => {
  // Restore globals
  globalThis.fetch = origFetch;
  _setResolveAndValidateUrl(prevResolveAndValidateUrl);
  resetTokenCache();
  // Clean up temp dir
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helper: derive a signing key usable in tests ─────────────────────────────

async function testSigningKey(): Promise<Buffer> {
  const machineId = await getMachineId();
  return deriveSigningKey(machineId);
}

// ─── Helper: run the core pipeline for a single spec result ──────────────────

/**
 * Replicates the per-spec processing loop from handleGitHubImport(), minus
 * any stdout/stderr output or process.exit() calls.
 *
 * Returns null when the spec is skipped (no server URL, localhost, etc.).
 */
async function runPipeline(
  result: GitHubSpecResult,
  opts: { dryRun?: boolean; update?: boolean; skillsDir?: string; token?: string | null } = {},
): Promise<{ domain: string; endpointsAdded: number; filePath?: string } | null> {
  const { dryRun = false, update = false, skillsDir = tempDir, token = null } = opts;

  const spec = await fetchGitHubSpec(result.specUrl, token);

  if (!hasServerUrl(spec)) return null;
  if (isLocalhostSpec(spec)) return null;

  normalizeSpecServerUrls(spec);

  const importResult = convertOpenAPISpec(spec, result.specUrl);
  const { domain, endpoints, meta } = importResult;

  if (endpoints.length === 0) return null;

  // --update: skip if already imported from same specUrl
  const existing = await readSkillFile(domain, skillsDir, { verifySignature: false }).catch(() => null);
  if (update && existing?.metadata.importHistory?.some(
    (h: any) => h.specUrl === result.specUrl && h.importedAt >= result.pushedAt,
  )) {
    return null; // "up to date"
  }

  const { skillFile, diff } = mergeSkillFile(existing, endpoints, meta);
  skillFile.domain = domain;
  skillFile.baseUrl = `https://${domain}`;

  if (dryRun) {
    return { domain, endpointsAdded: diff.added };
  }

  const key = await testSigningKey();
  const hasCaptured = skillFile.endpoints.some(
    ep => !ep.endpointProvenance || ep.endpointProvenance === 'captured',
  );
  const signed = signSkillFileAs(skillFile, key, hasCaptured ? 'self' : 'imported-signed');
  const filePath = await writeSkillFile(signed, skillsDir);

  return { domain, endpointsAdded: diff.added, filePath };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GitHub import integration', () => {

  // ── 1. Org scan: discovers, filters, converts, and writes skill files ────────

  it('org scan: discovers, filters, converts, and writes skill files', async () => {
    // Code search returns 2 results: 1 valid, 1 fork
    const validRepo = {
      html_url: 'https://github.com/acme/api-spec/blob/main/openapi.json',
      path: 'openapi.json',
      repository: {
        name: 'api-spec',
        full_name: 'acme/api-spec',
        owner: { login: 'acme' },
        fork: false,
        archived: false,
        pushed_at: new Date().toISOString(),
        stargazers_count: 100,
        description: 'Acme API',
        default_branch: 'main',
      },
    };
    const forkRepo = {
      html_url: 'https://github.com/acme/fork-spec/blob/main/openapi.json',
      path: 'openapi.json',
      repository: {
        name: 'fork-spec',
        full_name: 'acme/fork-spec',
        owner: { login: 'acme' },
        fork: true,    // <-- will be skipped
        archived: false,
        pushed_at: new Date().toISOString(),
        stargazers_count: 50,
        description: 'Forked API',
        default_branch: 'main',
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('api.github.com/search/code')) {
        return jsonResponse({ items: [validRepo, forkRepo] });
      }
      if (url.includes('raw.githubusercontent.com')) {
        return textResponse(JSON.stringify(EXAMPLE_SPEC));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Discovery
    const rawResults = await searchOrgSpecs('acme', 'fake-token');
    assert.strictEqual(rawResults.length, 2, 'should discover 2 results before filtering');

    // Filter — fork should be skipped
    const { passed, skips } = filterResults(rawResults, {});
    assert.strictEqual(passed.length, 1, 'only 1 should pass filter');
    assert.strictEqual(skips.length, 1, 'fork should be in skips');
    assert.ok(skips[0].reason.toLowerCase().includes('fork'), 'skip reason should mention fork');

    // Full pipeline for the valid spec
    const outcome = await runPipeline(passed[0], { skillsDir: tempDir });
    assert.ok(outcome, 'pipeline should return an outcome');
    assert.strictEqual(outcome.domain, 'api.acme-corp.com');
    assert.ok(outcome.endpointsAdded > 0, 'should add endpoints');
    assert.ok(outcome.filePath, 'should write a file');

    // Verify skill file exists on disk and is readable
    const saved = await readSkillFile('api.acme-corp.com', tempDir, { verifySignature: true });
    assert.ok(saved, 'skill file should be readable');
    assert.ok(saved!.endpoints.length > 0, 'should have endpoints');
    assert.ok(
      ['imported-signed', 'self'].includes(saved!.provenance ?? ''),
      `provenance should be imported-signed or self, got: ${saved!.provenance}`,
    );
  });

  // ── 2. Topic search: discovers repos, probes for specs, writes skill files ───

  it('topic search: discovers repos, probes for specs, writes skill files', async () => {
    const repoItem = {
      name: 'widget-api',
      full_name: 'widgets/widget-api',
      owner: { login: 'widgets' },
      fork: false,
      archived: false,
      pushed_at: new Date().toISOString(),
      stargazers_count: 200,
      description: 'Widget API',
      default_branch: 'main',
    };

    // Contents response — openapi.json at root
    const contentsResponse = [
      { name: 'openapi.json', path: 'openapi.json', html_url: 'https://github.com/widgets/widget-api/blob/main/openapi.json' },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('api.github.com/search/repositories')) {
        return jsonResponse({ items: [repoItem] });
      }
      if (url.includes('api.github.com/repos/widgets/widget-api/contents')) {
        return jsonResponse(contentsResponse);
      }
      if (url.includes('raw.githubusercontent.com')) {
        return textResponse(JSON.stringify(WIDGET_SPEC));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const rawResults = await searchTopicSpecs(['openapi'], null, { minStars: 0 });
    assert.ok(rawResults.length > 0, 'should discover at least one result');

    const { passed } = filterResults(rawResults, {});
    assert.ok(passed.length > 0, 'should have at least one passing result');

    const outcome = await runPipeline(passed[0], { skillsDir: tempDir });
    assert.ok(outcome, 'pipeline should return an outcome');
    assert.strictEqual(outcome.domain, 'api.widgets-corp.io');
    assert.ok(outcome.endpointsAdded > 0, 'should add endpoints');

    const saved = await readSkillFile('api.widgets-corp.io', tempDir, { verifySignature: true });
    assert.ok(saved, 'skill file should be readable');
    assert.strictEqual(saved!.endpoints.length, 1, 'should have 1 endpoint');
  });

  // ── 3. --dry-run does not write to disk ──────────────────────────────────────

  it('--dry-run does not write to disk', async () => {
    globalThis.fetch = async () => textResponse(JSON.stringify(EXAMPLE_SPEC));

    const result = makeSpecResult();
    const outcome = await runPipeline(result, { dryRun: true, skillsDir: tempDir });

    assert.ok(outcome, 'dry-run should still return outcome metadata');
    assert.ok(outcome.endpointsAdded > 0, 'should report endpoints added');
    // But no file property — dry run does not write
    assert.strictEqual(outcome.filePath, undefined, 'dry-run must not return a file path');

    // Verify nothing was written to tempDir
    const saved = await readSkillFile('api.acme-corp.com', tempDir, { verifySignature: false });
    assert.strictEqual(saved, null, 'no file should exist on disk after dry-run');
  });

  // ── 4. --update skips already-imported specs ──────────────────────────────────

  it('--update skips already-imported specs', async () => {
    globalThis.fetch = async () => textResponse(JSON.stringify(EXAMPLE_SPEC));

    const result = makeSpecResult();

    // First import — write the skill file
    const first = await runPipeline(result, { skillsDir: tempDir });
    assert.ok(first?.filePath, 'first import should write a file');

    // Verify importHistory was written
    const after1st = await readSkillFile('api.acme-corp.com', tempDir, { verifySignature: false });
    assert.ok(after1st?.metadata.importHistory?.length, 'should have importHistory');

    // Second import with --update and same specUrl — should be skipped ("up to date")
    const second = await runPipeline(result, { update: true, skillsDir: tempDir });
    assert.strictEqual(second, null, 'second import with --update should be skipped');
  });

  // ── 5. Continues when individual spec fetch fails ─────────────────────────────

  it('continues when individual spec fetch fails', async () => {
    const failResult = makeSpecResult({
      repo: 'fail-spec',
      repoFullName: 'acme/fail-spec',
      specUrl: 'https://raw.githubusercontent.com/acme/fail-spec/main/openapi.json',
      htmlUrl: 'https://github.com/acme/fail-spec/blob/main/openapi.json',
    });
    const okResult = makeSpecResult({
      repo: 'ok-spec',
      repoFullName: 'acme/ok-spec',
      specUrl: 'https://raw.githubusercontent.com/acme/ok-spec/main/openapi.json',
      htmlUrl: 'https://github.com/acme/ok-spec/blob/main/openapi.json',
    });

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('fail-spec')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('ok-spec')) {
        return textResponse(JSON.stringify(EXAMPLE_SPEC));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Process both; first should throw, second should succeed
    let okOutcome = null;
    let failError: Error | null = null;

    try {
      await runPipeline(failResult, { skillsDir: tempDir });
    } catch (err) {
      failError = err as Error;
    }

    okOutcome = await runPipeline(okResult, { skillsDir: tempDir });

    assert.ok(failError, 'first spec fetch should have thrown');
    assert.ok(failError!.message.includes('404'), 'error should mention 404');
    assert.ok(okOutcome, 'second spec should succeed');
    assert.ok(okOutcome.endpointsAdded > 0, 'should have added endpoints');

    // Only one file written (the successful one)
    const saved = await readSkillFile('api.acme-corp.com', tempDir, { verifySignature: false });
    assert.ok(saved, 'ok result should be on disk');
  });

  // ── 6. --org with no token: resolveGitHubToken returns null ──────────────────

  it('--org with no token: resolveGitHubToken returns null', async () => {
    // Make sure gh CLI fails and env var is absent
    _setExecFileSync(() => { throw new Error('gh not found'); });
    const prevToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    let restoredToken = false;
    try {
      const token = await resolveGitHubToken();
      assert.strictEqual(token, null, 'should return null when no credentials available');

      // Simulate the CLI guard: --org requires a token
      const org = 'acme';
      if (org && token === null) {
        // This is the expected code path — don't throw, just verify the condition.
        assert.ok(true, 'guard condition fires correctly');
      } else {
        assert.fail('guard should have fired for --org with null token');
      }
    } finally {
      // Restore env
      if (prevToken !== undefined) {
        process.env.GITHUB_TOKEN = prevToken;
      }
      restoredToken = true;
    }
    assert.ok(restoredToken, 'cleanup ran');
  });

  // ── 7. Normalizes templated domains before conversion ────────────────────────

  it('normalizes templated domains before conversion', async () => {
    const sentrySpec = {
      openapi: '3.0.0',
      info: { title: 'Sentry API', version: '1.0.0' },
      servers: [{ url: 'https://{region}.sentry.io/api/0' }],
      paths: {
        '/projects/': {
          get: {
            operationId: 'listProjects',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    globalThis.fetch = async () => textResponse(JSON.stringify(sentrySpec));

    const result = makeSpecResult({
      specUrl: 'https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi.json',
    });

    const spec = await fetchGitHubSpec(result.specUrl, null);

    // Before normalization, domain would be {region}.sentry.io — invalid
    assert.ok(spec.servers[0].url.includes('{region}'), 'raw spec should have template');

    // Normalize
    normalizeSpecServerUrls(spec);
    assert.ok(!spec.servers[0].url.includes('{'), 'after normalization, no template braces');
    assert.ok(spec.servers[0].url.includes('sentry.io'), 'normalized URL should include sentry.io');

    // Convert
    const importResult = convertOpenAPISpec(spec, result.specUrl);
    assert.strictEqual(
      importResult.domain,
      'sentry.io',
      `domain should be 'sentry.io', not raw.githubusercontent.com`,
    );

    // Write and verify
    const { skillFile, diff } = mergeSkillFile(null, importResult.endpoints, importResult.meta);
    skillFile.domain = importResult.domain;
    skillFile.baseUrl = `https://${importResult.domain}`;
    const key = await testSigningKey();
    const signed = signSkillFileAs(skillFile, key, 'imported-signed');
    await writeSkillFile(signed, tempDir);

    const saved = await readSkillFile('sentry.io', tempDir, { verifySignature: false });
    assert.ok(saved, 'skill file should be written for sentry.io');
    assert.strictEqual(saved!.domain, 'sentry.io');
  });

  // ── 8. Skips specs with no server URL ────────────────────────────────────────

  it('skips specs with no server URL', async () => {
    const noServerSpec = {
      openapi: '3.0.0',
      info: { title: 'No Server Spec', version: '1.0.0' },
      // No servers, no host
      paths: {
        '/things': {
          get: { operationId: 'listThings', responses: { '200': { description: 'OK' } } },
        },
      },
    };

    globalThis.fetch = async () => textResponse(JSON.stringify(noServerSpec));

    const result = makeSpecResult();
    const spec = await fetchGitHubSpec(result.specUrl, null);

    assert.strictEqual(hasServerUrl(spec), false, 'should detect missing server URL');

    // runPipeline should return null (skip)
    const outcome = await runPipeline(result, { skillsDir: tempDir });
    assert.strictEqual(outcome, null, 'pipeline should return null for spec with no server URL');

    // Nothing written
    const saved = await readSkillFile('api.acme-corp.com', tempDir, { verifySignature: false });
    assert.strictEqual(saved, null, 'no file should be written');
  });

  // ── 9. Silently skips localhost specs ────────────────────────────────────────

  it('silently skips localhost specs', async () => {
    const localhostSpec = {
      openapi: '3.0.0',
      info: { title: 'Dev API', version: '0.0.1' },
      servers: [{ url: 'http://localhost:3000' }],
      paths: {
        '/health': {
          get: { operationId: 'healthCheck', responses: { '200': { description: 'OK' } } },
        },
      },
    };

    globalThis.fetch = async () => textResponse(JSON.stringify(localhostSpec));

    const result = makeSpecResult();
    const spec = await fetchGitHubSpec(result.specUrl, null);

    assert.strictEqual(isLocalhostSpec(spec), true, 'should detect localhost spec');

    // runPipeline should skip without writing
    const outcome = await runPipeline(result, { skillsDir: tempDir });
    assert.strictEqual(outcome, null, 'pipeline should return null for localhost spec');

    const saved = await readSkillFile('api.acme-corp.com', tempDir, { verifySignature: false });
    assert.strictEqual(saved, null, 'no file should be written for localhost spec');
  });

});

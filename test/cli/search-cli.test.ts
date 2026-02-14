// test/cli/search-cli.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSkillFile } from '../../src/skill/store.js';
import type { SkillFile } from '../../src/types.js';

const execFileAsync = promisify(execFile);

function makeSkill(domain: string, endpoints: Array<{ id: string; method: string; path: string; tier?: string }>): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: `https://${domain}`,
    endpoints: endpoints.map(ep => ({
      id: ep.id,
      method: ep.method,
      path: ep.path,
      queryParams: {},
      headers: {},
      responseShape: { type: 'object', fields: ['id'] },
      examples: {
        request: { url: `https://${domain}${ep.path}`, headers: {} },
        responsePreview: null,
      },
      replayability: {
        tier: (ep.tier ?? 'green') as 'green' | 'yellow' | 'orange' | 'red' | 'unknown',
        verified: true,
        signals: [],
      },
    })),
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.4.0' },
    provenance: 'self',
  };
}

async function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(
      'node',
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { ...process.env, ...env }, timeout: 10000 },
    );
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('CLI: search command', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-cli-search-'));
    await writeSkillFile(makeSkill('gamma-api.polymarket.com', [
      { id: 'get-events', method: 'GET', path: '/events', tier: 'green' },
      { id: 'get-teams', method: 'GET', path: '/teams', tier: 'green' },
    ]), testDir);
    await writeSkillFile(makeSkill('api.github.com', [
      { id: 'get-repos', method: 'GET', path: '/repos', tier: 'yellow' },
    ]), testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('outputs JSON search results with --json', async () => {
    const { stdout } = await runCli(
      ['search', 'polymarket', '--json'],
      { APITAP_SKILLS_DIR: testDir },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.found, true);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].domain, 'gamma-api.polymarket.com');
  });

  it('outputs JSON not-found with --json', async () => {
    const { stdout } = await runCli(
      ['search', 'nonexistent', '--json'],
      { APITAP_SKILLS_DIR: testDir },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.found, false);
    assert.ok(parsed.suggestion);
  });

  it('outputs human-readable results without --json', async () => {
    const { stdout } = await runCli(
      ['search', 'polymarket'],
      { APITAP_SKILLS_DIR: testDir },
    );
    assert.ok(stdout.includes('gamma-api.polymarket.com'));
    assert.ok(stdout.includes('get-events'));
    assert.ok(stdout.includes('green'));
  });

  it('shows error when no query provided', async () => {
    const { stderr } = await runCli(
      ['search'],
      { APITAP_SKILLS_DIR: testDir },
    );
    assert.ok(stderr.includes('Query required'));
  });

  it('searches by endpoint path', async () => {
    const { stdout } = await runCli(
      ['search', 'repos', '--json'],
      { APITAP_SKILLS_DIR: testDir },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.found, true);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].endpointId, 'get-repos');
  });
});

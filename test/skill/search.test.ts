// test/skill/search.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile } from '../../src/skill/store.js';
import { searchSkills } from '../../src/skill/search.js';
import type { SkillFile } from '../../src/types.js';

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

describe('searchSkills', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-search-'));
    // Write two skill files
    await writeSkillFile(makeSkill('gamma-api.polymarket.com', [
      { id: 'get-events', method: 'GET', path: '/events', tier: 'green' },
      { id: 'get-teams', method: 'GET', path: '/teams', tier: 'green' },
      { id: 'post-orders', method: 'POST', path: '/orders', tier: 'orange' },
    ]), testDir);
    await writeSkillFile(makeSkill('api.github.com', [
      { id: 'get-repos', method: 'GET', path: '/repos', tier: 'green' },
      { id: 'get-issues', method: 'GET', path: '/issues', tier: 'yellow' },
    ]), testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('finds endpoints matching domain name', async () => {
    const results = await searchSkills('polymarket', testDir);
    assert.ok(results.found);
    assert.equal(results.results!.length, 3);
    assert.ok(results.results!.every(r => r.domain === 'gamma-api.polymarket.com'));
  });

  it('finds endpoints matching endpoint path', async () => {
    const results = await searchSkills('events', testDir);
    assert.ok(results.found);
    assert.equal(results.results!.length, 1);
    assert.equal(results.results![0].endpointId, 'get-events');
    assert.equal(results.results![0].tier, 'green');
  });

  it('finds endpoints matching endpoint ID', async () => {
    const results = await searchSkills('get-repos', testDir);
    assert.ok(results.found);
    assert.equal(results.results!.length, 1);
    assert.equal(results.results![0].endpointId, 'get-repos');
    assert.equal(results.results![0].domain, 'api.github.com');
  });

  it('returns found: false when no matches', async () => {
    const results = await searchSkills('nonexistent', testDir);
    assert.equal(results.found, false);
    assert.equal(results.results, undefined);
    assert.ok(results.suggestion);
  });

  it('matches case-insensitively', async () => {
    const results = await searchSkills('POLYMARKET', testDir);
    assert.ok(results.found);
    assert.equal(results.results!.length, 3);
  });

  it('matches partial domain names', async () => {
    const results = await searchSkills('github', testDir);
    assert.ok(results.found);
    assert.equal(results.results!.length, 2);
  });

  it('matches method + path queries', async () => {
    const results = await searchSkills('POST orders', testDir);
    assert.ok(results.found);
    assert.equal(results.results!.length, 1);
    assert.equal(results.results![0].endpointId, 'post-orders');
  });

  it('returns empty results when skills dir is empty', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'apitap-empty-'));
    try {
      const results = await searchSkills('anything', emptyDir);
      assert.equal(results.found, false);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('includes tier and verified status in results', async () => {
    const results = await searchSkills('orders', testDir);
    assert.ok(results.found);
    const orderResult = results.results![0];
    assert.equal(orderResult.tier, 'orange');
    assert.equal(orderResult.verified, true);
  });
});

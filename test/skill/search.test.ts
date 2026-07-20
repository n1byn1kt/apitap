// test/skill/search.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkillFile } from '../../src/skill/store.js';
import { searchSkills } from '../../src/skill/search.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(
  domain: string,
  endpoints: Array<{ id: string; method: string; path: string; tier?: string }>,
  provenance: string = 'self',
): SkillFile {
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
    provenance: provenance as SkillFile['provenance'],
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

  describe('result limiting (unbounded-output fix)', () => {
    beforeEach(async () => {
      // A domain with many endpoints, mixed tiers
      await writeSkillFile(makeSkill('big.example.com',
        Array.from({ length: 80 }, (_, i) => ({
          id: `get-widget-${i}`,
          method: 'GET',
          path: `/widget/${i}`,
          tier: i % 4 === 0 ? 'green' : i % 4 === 1 ? 'yellow' : i % 4 === 2 ? 'orange' : 'red',
        }))), testDir);
    });

    it('caps results at the default limit and flags truncation', async () => {
      const results = await searchSkills('widget', testDir);
      assert.ok(results.found);
      assert.equal(results.results!.length, 50);
      assert.equal(results.truncated, true);
      assert.match(results.summary!, /showing 50 of 80/);
    });

    it('respects an explicit limit option', async () => {
      const results = await searchSkills('widget', testDir, { limit: 5 });
      assert.ok(results.found);
      assert.equal(results.results!.length, 5);
      assert.equal(results.truncated, true);
    });

    it('prefers replayable tiers when truncating', async () => {
      const results = await searchSkills('widget', testDir, { limit: 20 });
      // 20 green + 20 yellow exist; a red endpoint must not displace them
      assert.ok(results.results!.every(r => r.tier === 'green'));
    });

    it('does not set truncated when under the limit', async () => {
      const results = await searchSkills('events', testDir);
      assert.ok(results.found);
      assert.equal(results.truncated, undefined);
    });

    it('caps the domain list in the no-match suggestion', async () => {
      for (let i = 0; i < 30; i++) {
        await writeSkillFile(makeSkill(`filler-${i}.example.com`, [
          { id: 'get-root', method: 'GET', path: '/root' },
        ]), testDir);
      }
      const results = await searchSkills('zzz-no-such-thing', testDir);
      assert.equal(results.found, false);
      assert.ok(results.suggestion!.length < 1500, `suggestion too long: ${results.suggestion!.length}`);
      assert.match(results.suggestion!, /and \d+ more/);
    });
  });

  describe('search ranking', () => {
    beforeEach(async () => {
      // api.github.com already exists from the outer beforeEach:
      // provenance 'self', tier green/yellow, path /repos and /issues (domain match on 'github').
      // apis.guru: provenance 'imported', tier unknown, 3 endpoints with 'github' in the path only.
      await writeSkillFile(makeSkill('apis.guru', [
        { id: 'get-repos-github', method: 'GET', path: '/repos/github', tier: 'unknown' },
        { id: 'get-orgs-github', method: 'GET', path: '/orgs/github', tier: 'unknown' },
        { id: 'get-users-github', method: 'GET', path: '/users/github', tier: 'unknown' },
      ], 'imported'), testDir);

      // 'widget' path match, equal tier (unknown), differing provenance.
      await writeSkillFile(makeSkill('store-imported.example.com', [
        { id: 'get-item', method: 'GET', path: '/widget/1', tier: 'unknown' },
      ], 'imported'), testDir);
      await writeSkillFile(makeSkill('store-self.example.com', [
        { id: 'get-item', method: 'GET', path: '/widget/2', tier: 'unknown' },
      ], 'self'), testDir);

      // 'gadget' path match, equal locality, differing tier — tier should decide over provenance.
      await writeSkillFile(makeSkill('shopa.example.com', [
        { id: 'get-item', method: 'GET', path: '/gadget/a', tier: 'green' },
      ], 'imported'), testDir);
      await writeSkillFile(makeSkill('shopb.example.com', [
        { id: 'get-item', method: 'GET', path: '/gadget/b', tier: 'unknown' },
      ], 'self'), testDir);

      // 'thing' — domain match (red tier) must outrank path-substring match (green tier).
      await writeSkillFile(makeSkill('api.thing.com', [
        { id: 'get-root', method: 'GET', path: '/root', tier: 'red' },
      ], 'self'), testDir);
      await writeSkillFile(makeSkill('other.example.com', [
        { id: 'get-item', method: 'GET', path: '/thing/1', tier: 'green' },
      ], 'self'), testDir);
    });

    it('domain match outranks path-substring match regardless of count', async () => {
      const res = await searchSkills('github', testDir);
      assert.equal(res.results![0].domain, 'api.github.com');
    });

    it('self provenance outranks imported at equal tier and locality', async () => {
      const res = await searchSkills('widget', testDir);
      assert.equal(res.results![0].provenance, 'self');
    });

    it('tier beats provenance after locality: green-imported above unknown-self', async () => {
      const res = await searchSkills('gadget', testDir);
      assert.equal(res.results![0].tier, 'green');
    });

    it('locality beats tier: red-tier domain match outranks green-tier path-substring match (deliberate)', async () => {
      const res = await searchSkills('thing', testDir);
      assert.equal(res.results![0].domain, 'api.thing.com');
    });

    it('results carry provenance', async () => {
      const res = await searchSkills('github', testDir);
      assert.ok(res.results!.every(r => typeof r.provenance === 'string'));
    });

    it('sorts even when under the limit', async () => {
      const res = await searchSkills('github', testDir, { limit: 50 });
      // domain-match block first, then ordered by tier within same locality — no unknown before green at same locality
      assert.equal(res.results![0].domain, 'api.github.com');
    });
  });
});

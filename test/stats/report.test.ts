// test/stats/report.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateStatsReport, formatStatsHuman } from '../../src/stats/report.js';
import type { SkillFile } from '../../src/types.js';

const TEST_DIR = join(tmpdir(), `apitap-stats-test-${Date.now()}`);

function makeSkillFile(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    version: '1.2',
    domain: 'example.com',
    capturedAt: new Date().toISOString(),
    baseUrl: 'https://example.com',
    endpoints: [
      {
        id: 'get-data',
        method: 'GET',
        path: '/api/data',
        queryParams: {},
        headers: {},
        responseShape: { type: 'object' },
        examples: { request: { url: 'https://example.com/api/data', headers: {} }, responsePreview: null },
        responseBytes: 5000,
        replayability: { tier: 'green', verified: true, signals: [] },
      },
    ],
    metadata: {
      captureCount: 10,
      filteredCount: 8,
      toolVersion: '1.0.0',
      browserCost: {
        domBytes: 400000,
        totalNetworkBytes: 600000,
        totalRequests: 10,
      },
    },
    provenance: 'self',
    ...overrides,
  };
}

describe('generateStatsReport', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty report for missing directory', async () => {
    const report = await generateStatsReport('/nonexistent/path');
    assert.equal(report.domains.length, 0);
    assert.equal(report.totals.domains, 0);
  });

  it('calculates token savings from measured browser cost', async () => {
    const skill = makeSkillFile();
    await writeFile(join(TEST_DIR, 'example.com.json'), JSON.stringify(skill));

    const report = await generateStatsReport(TEST_DIR);
    assert.equal(report.domains.length, 1);

    const d = report.domains[0];
    assert.equal(d.domain, 'example.com');
    assert.equal(d.domBytes, 400000);
    assert.equal(d.browserTokens, 100000);
    assert.ok(d.replayTokens > 0);
    assert.ok(d.savingsPercent > 90);
  });

  it('includes response bytes in replay token calc', async () => {
    const skill = makeSkillFile();
    await writeFile(join(TEST_DIR, 'example.com.json'), JSON.stringify(skill));

    const report = await generateStatsReport(TEST_DIR);
    const d = report.domains[0];
    // replayTokens = (skillFileBytes + responseBytes) / 4
    // responseBytes = 5000, skillFileBytes varies
    assert.ok(d.replayTokens >= 5000 / 4, `replayTokens ${d.replayTokens} should include response bytes`);
  });

  it('handles multiple domains', async () => {
    await writeFile(join(TEST_DIR, 'a.com.json'), JSON.stringify(makeSkillFile({ domain: 'a.com' })));
    await writeFile(join(TEST_DIR, 'b.com.json'), JSON.stringify(makeSkillFile({ domain: 'b.com' })));

    const report = await generateStatsReport(TEST_DIR);
    assert.equal(report.totals.domains, 2);
    assert.equal(report.totals.endpoints, 2);
  });

  it('calculates total savings across domains', async () => {
    await writeFile(join(TEST_DIR, 'a.com.json'), JSON.stringify(makeSkillFile({ domain: 'a.com' })));
    await writeFile(join(TEST_DIR, 'b.com.json'), JSON.stringify(makeSkillFile({ domain: 'b.com' })));

    const report = await generateStatsReport(TEST_DIR);
    assert.equal(report.totals.browserTokens, 200000);
    assert.ok(report.totals.savingsPercent > 90);
  });

  it('does not count unverified endpoints as replayable', async () => {
    const skill = makeSkillFile();
    skill.endpoints.push({
      id: 'post-action',
      method: 'POST',
      path: '/api/action',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/api/action', headers: {} }, responsePreview: null },
      // No replayability field — previously counted as replayable
    });
    await writeFile(join(TEST_DIR, 'example.com.json'), JSON.stringify(skill));

    const report = await generateStatsReport(TEST_DIR);
    assert.equal(report.domains[0].endpoints, 2);
    assert.equal(report.domains[0].replayable, 1); // Only green, not unverified
  });

  it('counts replayable endpoints (green/yellow)', async () => {
    const skill = makeSkillFile();
    skill.endpoints.push({
      id: 'get-secret',
      method: 'GET',
      path: '/api/secret',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/api/secret', headers: {} }, responsePreview: null },
      replayability: { tier: 'red', verified: false, signals: ['anti-bot'] },
    });
    await writeFile(join(TEST_DIR, 'example.com.json'), JSON.stringify(skill));

    const report = await generateStatsReport(TEST_DIR);
    assert.equal(report.domains[0].endpoints, 2);
    assert.equal(report.domains[0].replayable, 1);
  });
});

describe('formatStatsHuman', () => {
  it('shows no skill files message for empty report', () => {
    const output = formatStatsHuman({
      domains: [],
      totals: { domains: 0, endpoints: 0, replayable: 0, totalDomBytes: 0, browserTokens: 0, replayTokens: 0, savingsPercent: 0 },
    });
    assert.ok(output.includes('No skill files found'));
  });

  it('includes domain name and savings in output', () => {
    // Use non-default domBytes so formatStatsHuman detects it as measured
    const output = formatStatsHuman({
      domains: [{
        domain: 'example.com',
        endpoints: 3,
        replayable: 3,
        domBytes: 500000,
        totalNetworkBytes: 600000,
        skillFileBytes: 2000,
        totalResponseBytes: 5000,
        browserTokens: 125000,
        replayTokens: 1750,
        savingsPercent: 98.6,
      }],
      totals: {
        domains: 1, endpoints: 3, replayable: 3,
        totalDomBytes: 500000, browserTokens: 125000, replayTokens: 1750, savingsPercent: 98.6,
      },
    });
    assert.ok(output.includes('example.com'));
    assert.ok(output.includes('98.6%'));
    assert.ok(output.includes('measured DOM size'));
  });
});

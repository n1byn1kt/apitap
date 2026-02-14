// test/inspect/report.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInspectReport, formatInspectHuman } from '../../src/inspect/report.js';
import type { SkillFile } from '../../src/types.js';

function makeSkillFile(domain: string): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: new Date().toISOString(),
    baseUrl: `https://${domain}`,
    endpoints: [
      {
        id: 'get-data',
        method: 'GET',
        path: '/api/data',
        queryParams: {},
        headers: {},
        responseShape: { type: 'array', fields: ['id', 'name', 'value'] },
        examples: { request: { url: `https://${domain}/api/data`, headers: {} }, responsePreview: null },
        responseBytes: 12000,
        replayability: { tier: 'green', verified: true, signals: [] },
      },
      {
        id: 'get-user',
        method: 'GET',
        path: '/api/user/me',
        queryParams: {},
        headers: { authorization: '[stored]' },
        responseShape: { type: 'object', fields: ['id', 'name', 'email'] },
        examples: { request: { url: `https://${domain}/api/user/me`, headers: {} }, responsePreview: null },
        responseBytes: 1100,
        replayability: { tier: 'yellow', verified: false, signals: ['needs-auth'] },
      },
    ],
    metadata: { captureCount: 50, filteredCount: 40, toolVersion: '1.0.0' },
    provenance: 'self',
  };
}

describe('buildInspectReport', () => {
  it('builds report with correct endpoint count', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      domBytes: 500000,
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.replayable, 2); // green + yellow
    assert.equal(report.summary.authRequired, 1);
  });

  it('calculates token savings from DOM bytes', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      domBytes: 800000, // 200K tokens
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    assert.equal(report.summary.browserTokens, 200000);
    assert.ok(report.summary.replayTokens > 0);
    assert.ok(report.summary.savingsPercent > 95);
  });

  it('includes anti-bot signals', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      antiBotSignals: ['cloudflare', 'rate-limited'],
      targetDomain: 'example.com',
    });

    assert.deepEqual(report.antiBot, ['cloudflare', 'rate-limited']);
  });

  it('does not count unknown tier as replayable', () => {
    const skill = makeSkillFile('example.com');
    // Add an endpoint with no replayability (unknown)
    skill.endpoints.push({
      id: 'post-action',
      method: 'POST',
      path: '/api/action',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/api/action', headers: {} }, responsePreview: null },
      responseBytes: 500,
    });
    const skills = new Map([['example.com', skill]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      domBytes: 500000,
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.replayable, 2); // green + yellow only, not unknown
  });

  it('merges endpoints across multiple domains', () => {
    const skills = new Map([
      ['api.example.com', makeSkillFile('api.example.com')],
      ['cdn.example.com', makeSkillFile('cdn.example.com')],
    ]);
    const report = buildInspectReport({
      skills,
      totalRequests: 200,
      filteredRequests: 160,
      duration: 30,
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    assert.equal(report.summary.total, 4);
  });
});

describe('formatInspectHuman', () => {
  it('includes domain name and endpoint table', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      domBytes: 500000,
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    const output = formatInspectHuman(report);
    assert.ok(output.includes('example.com'));
    assert.ok(output.includes('API Discovery Report'));
    assert.ok(output.includes('/api/data'));
    assert.ok(output.includes('green'));
    assert.ok(output.includes('apitap capture'));
  });

  it('shows anti-bot warning when detected', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      antiBotSignals: ['cloudflare'],
      targetDomain: 'example.com',
    });

    const output = formatInspectHuman(report);
    assert.ok(output.includes('cloudflare'));
  });

  it('shows savings when DOM bytes measured', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      domBytes: 500000,
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    const output = formatInspectHuman(report);
    assert.ok(output.includes('Savings:'));
    assert.ok(output.includes('%'));
  });

  it('shows explanation when savings are negative', () => {
    const skill = makeSkillFile('example.com');
    // Give endpoints huge response sizes to exceed DOM
    skill.endpoints[0].responseBytes = 2000000;
    skill.endpoints[1].responseBytes = 2000000;
    const skills = new Map([['example.com', skill]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      domBytes: 100000, // Small DOM, huge responses → negative savings
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    assert.ok(report.summary.savingsPercent < 0);
    const output = formatInspectHuman(report);
    assert.ok(output.includes('browser automation may be more token-efficient'));
  });

  it('shows data shapes for endpoints with fields', () => {
    const skills = new Map([['example.com', makeSkillFile('example.com')]]);
    const report = buildInspectReport({
      skills,
      totalRequests: 100,
      filteredRequests: 80,
      duration: 30,
      antiBotSignals: [],
      targetDomain: 'example.com',
    });

    const output = formatInspectHuman(report);
    assert.ok(output.includes('Data shapes:'));
    assert.ok(output.includes('id, name'));
  });
});

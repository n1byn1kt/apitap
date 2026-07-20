import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDoctorSummary, formatDoctorReport } from '../../src/doctor/format.js';
import type { DoctorReport, Finding } from '../../src/doctor/types.js';

function finding(over: Partial<Finding>): Finding {
  return { checkId: 'stale-capture', domain: 'a.com', severity: 'warn', message: 'stale', fixable: false, ...over };
}

function report(findings: Finding[], over: Partial<DoctorReport> = {}): DoctorReport {
  return { scanned: 10, findings, fixes: [], remaining: findings, quarantined: [], ...over };
}

describe('formatDoctorSummary', () => {
  it('prints per-check counts grouped by severity, not per-finding lines', () => {
    const findings = [
      finding({ domain: 'junky.com', checkId: 'junk-domain', severity: 'junk' }),
      ...Array.from({ length: 5 }, (_, i) => finding({ domain: `w${i}.com` })),
      finding({ domain: 'w0.com', checkId: 'unverified-tier', severity: 'info' }),
    ];
    const out = formatDoctorSummary(report(findings), false);
    assert.match(out, /10 skills scanned/);
    assert.match(out, /JUNK\s+1/);
    assert.match(out, /junk-domain: 1/);
    assert.match(out, /WARN\s+5/);
    assert.match(out, /stale-capture: 5/);
    // No per-finding dump: each warn domain appears at most in the top-domains block, not one line per finding
    assert.doesNotMatch(out, /w3\.com\s+stale-capture: stale/);
  });

  it('ranks top domains by severity weight (junk=10, warn=3, info=1) and caps at 10', () => {
    const findings = [
      finding({ domain: 'junky.com', checkId: 'junk-domain', severity: 'junk' }),
      ...Array.from({ length: 4 }, () => finding({ domain: 'warny.com' })), // weight 12
      ...Array.from({ length: 12 }, (_, i) => finding({ domain: `d${i}.com` })), // weight 3 each
    ];
    const out = formatDoctorSummary(report(findings), false);
    const topBlock = out.slice(out.indexOf('Top domains'));
    const warnyPos = topBlock.indexOf('warny.com');
    const junkyPos = topBlock.indexOf('junky.com');
    assert.ok(warnyPos !== -1 && junkyPos !== -1);
    assert.ok(warnyPos < junkyPos, 'warny (12) ranks above junky (10)');
    const listed = topBlock.match(/d\d+\.com/g) ?? [];
    assert.ok(listed.length <= 8, 'top-domains block capped at 10 total domains');
  });

  it('keeps the fix hint and adds verbose hint', () => {
    const findings = [finding({ fixable: true })];
    const out = formatDoctorSummary(report(findings), false);
    assert.match(out, /apitap doctor --fix/);
    assert.match(out, /--verbose/);
  });

  it('annotates quarantined domains in fix mode', () => {
    const f = finding({ domain: 'bad.com', checkId: 'empty-skill', fixable: true });
    const r = report([f], {
      fixes: [{ domain: 'bad.com', checkId: 'empty-skill', action: 'quarantine' }],
      quarantined: ['bad.com'],
      remaining: [],
    });
    const out = formatDoctorSummary(r, true);
    assert.match(out, /bad\.com.*\[QUARANTINED\]/);
    assert.match(out, /--restore/);
  });

  it('clean store prints the clean message', () => {
    const out = formatDoctorSummary(report([]), false);
    assert.match(out, /clean/);
  });
});

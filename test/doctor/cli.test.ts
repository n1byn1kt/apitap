// test/doctor/cli.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDoctorReport } from '../../src/doctor/format.js';
import type { DoctorReport } from '../../src/doctor/types.js';

const report: DoctorReport = {
  scanned: 3,
  findings: [
    { checkId: 'junk-domain', domain: 'cdn.segment.com', severity: 'junk', fixable: true, message: 'domain is on the capture blocklist' },
    { checkId: 'stale-capture', domain: 'zillow.com', severity: 'warn', fixable: false, message: 'captured 2026-03-14 (127 days ago) — re-capture' },
    { checkId: 'unverified-tier', domain: 'zillow.com', severity: 'info', fixable: false, message: '5 endpoint(s) never verified (tier unknown)' },
  ],
  fixes: [],
  remaining: [],
  quarantined: [],
};

describe('formatDoctorReport', () => {
  it('groups by severity junk > warn > info with a summary and --fix hint', () => {
    const out = formatDoctorReport(report, false);
    const junkIdx = out.indexOf('JUNK');
    const warnIdx = out.indexOf('WARN');
    const infoIdx = out.indexOf('INFO');
    assert.ok(junkIdx >= 0 && junkIdx < warnIdx && warnIdx < infoIdx);
    assert.match(out, /3 skills scanned/);
    assert.match(out, /apitap doctor --fix/);
    assert.match(out, /cdn\.segment\.com/);
  });

  it('fix mode annotates applied fixes and shows the restore hint', () => {
    const fixed: DoctorReport = {
      ...report,
      fixes: [{ domain: 'cdn.segment.com', checkId: 'junk-domain', action: 'quarantine' }],
      quarantined: ['cdn.segment.com'],
      remaining: report.findings.slice(1),
    };
    const out = formatDoctorReport(fixed, true);
    assert.match(out, /QUARANTINED/);
    assert.match(out, /apitap doctor --restore/);
    assert.doesNotMatch(out, /apitap doctor --fix/); // no hint when already fixing
  });

  it('clean report says so', () => {
    const clean: DoctorReport = { scanned: 5, findings: [], fixes: [], remaining: [], quarantined: [] };
    assert.match(formatDoctorReport(clean, false), /no findings/i);
  });
});

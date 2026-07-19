// src/doctor/format.ts
import type { DoctorReport, Finding, Severity } from './types.js';

const ORDER: Severity[] = ['junk', 'warn', 'info'];
const HEADER: Record<Severity, string> = { junk: 'JUNK', warn: 'WARN', info: 'INFO' };

export function formatDoctorReport(report: DoctorReport, fixMode: boolean): string {
  const lines: string[] = [`apitap doctor — ${report.scanned} skills scanned`, ''];
  if (report.findings.length === 0) {
    lines.push('No findings — skill store is clean.');
    return lines.join('\n');
  }
  const fixedKey = new Set(report.fixes.map(f => `${f.domain} ${f.checkId}`));
  const annotation = (f: Finding): string => {
    if (!fixMode || !f.fixable || !fixedKey.has(`${f.domain} ${f.checkId}`)) return '';
    const fix = report.fixes.find(x => x.domain === f.domain && x.checkId === f.checkId)!;
    return fix.action === 'quarantine' ? '  [QUARANTINED]' : '  [FIXED]';
  };
  for (const sev of ORDER) {
    const group = report.findings.filter(f => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`${HEADER[sev]} (${group.length})`);
    for (const f of group) {
      lines.push(`  ${f.domain.padEnd(34)} ${f.checkId}: ${f.message}${annotation(f)}`);
    }
    lines.push('');
  }
  const fixable = report.findings.filter(f => f.fixable).length;
  lines.push(`Summary: ${report.findings.length} findings (${fixable} fixable), ${report.fixes.length} fixed, ${report.remaining.length} remaining.`);
  if (fixMode) {
    if (report.quarantined.length > 0) {
      lines.push(`Undo: apitap doctor --restore <domain>  (quarantined: ${report.quarantined.join(', ')})`);
    } else if (report.fixes.length > 0) {
      lines.push('Undo: apitap doctor --restore <domain>');
    }
  } else if (fixable > 0) {
    lines.push(`Run \`apitap doctor --fix\` to apply the ${fixable} safe fixes.`);
  }
  return lines.join('\n');
}

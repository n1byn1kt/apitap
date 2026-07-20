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

const SEVERITY_WEIGHT: Record<Severity, number> = { junk: 10, warn: 3, info: 1 };
const TOP_DOMAINS = 10;

export function formatDoctorSummary(report: DoctorReport, fixMode: boolean): string {
  const lines: string[] = [`apitap doctor — ${report.scanned} skills scanned`, ''];
  if (report.findings.length === 0) {
    lines.push('No findings — skill store is clean.');
    return lines.join('\n');
  }

  // Per-check counts grouped by severity
  for (const sev of ORDER) {
    const group = report.findings.filter(f => f.severity === sev);
    if (group.length === 0) continue;
    const byCheck = new Map<string, number>();
    for (const f of group) byCheck.set(f.checkId, (byCheck.get(f.checkId) ?? 0) + 1);
    const checks = [...byCheck.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id}: ${n}`)
      .join(' · ');
    lines.push(`${HEADER[sev].padEnd(5)} ${String(group.length).padEnd(5)} ${checks}`);
  }
  lines.push('');

  // Top domains by severity-weighted finding count
  const weight = new Map<string, number>();
  const checksByDomain = new Map<string, Finding[]>();
  for (const f of report.findings) {
    weight.set(f.domain, (weight.get(f.domain) ?? 0) + SEVERITY_WEIGHT[f.severity]);
    let list = checksByDomain.get(f.domain);
    if (!list) {
      list = [];
      checksByDomain.set(f.domain, list);
    }
    list.push(f);
  }
  const quarantined = new Set(report.quarantined);
  const fixedKey = new Set(report.fixes.map(x => `${x.domain} ${x.checkId}`));
  const top = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_DOMAINS);
  lines.push('Top domains (severity-weighted):');
  for (const [domain] of top) {
    const fs = checksByDomain.get(domain)!;
    const byCheck = new Map<string, number>();
    let junk = false;
    for (const f of fs) {
      byCheck.set(f.checkId, (byCheck.get(f.checkId) ?? 0) + 1);
      if (f.severity === 'junk') junk = true;
    }
    const parts = [...byCheck.entries()].map(([id, n]) => (n > 1 ? `${id} ×${n}` : id)).join(', ');
    let tag = '';
    if (fixMode && quarantined.has(domain)) tag = '  [QUARANTINED]';
    else if (fixMode && fs.some(f => fixedKey.has(`${domain} ${f.checkId}`))) tag = '  [FIXED]';
    lines.push(`  ${domain.padEnd(34)} ${junk ? '[JUNK] ' : ''}${parts}${tag}`);
  }
  lines.push('');

  // Summary + hints (mirrors formatDoctorReport tail)
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
  lines.push('Run `apitap doctor --verbose` or `apitap doctor <domain>` for full detail.');
  return lines.join('\n');
}

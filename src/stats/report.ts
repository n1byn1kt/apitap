// src/stats/report.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile } from '../types.js';

const DEFAULT_SKILLS_DIR = join(homedir(), '.apitap', 'skills');

export interface DomainStats {
  domain: string;
  endpoints: number;
  replayable: number;
  domBytes: number;
  totalNetworkBytes: number;
  skillFileBytes: number;
  totalResponseBytes: number;
  browserTokens: number;
  replayTokens: number;
  savingsPercent: number;
}

export interface StatsReport {
  domains: DomainStats[];
  totals: {
    domains: number;
    endpoints: number;
    replayable: number;
    totalDomBytes: number;
    browserTokens: number;
    replayTokens: number;
    savingsPercent: number;
  };
}

/** Default browser token estimate when no measurement available (conservative). */
const DEFAULT_DOM_BYTES = 400_000; // ~100K tokens

export async function generateStatsReport(
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<StatsReport> {
  let files: string[];
  try {
    files = (await readdir(skillsDir)).filter(f => f.endsWith('.json'));
  } catch {
    return emptyReport();
  }

  const domains: DomainStats[] = [];

  for (const file of files) {
    const filePath = join(skillsDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const skill = JSON.parse(content) as SkillFile;
      const fileStats = await stat(filePath);
      const skillFileBytes = fileStats.size;

      // Browser cost: use measured if available, else default
      const domBytes = skill.metadata.browserCost?.domBytes ?? DEFAULT_DOM_BYTES;
      const totalNetworkBytes = skill.metadata.browserCost?.totalNetworkBytes ?? 0;

      // Replay cost: skill file + response data
      const totalResponseBytes = skill.endpoints.reduce(
        (sum, ep) => sum + (ep.responseBytes ?? 0), 0,
      );

      const browserTokens = Math.round(domBytes / 4);
      const replayTokens = Math.round((skillFileBytes + totalResponseBytes) / 4);
      const savingsPercent = browserTokens > 0
        ? Math.round((1 - replayTokens / browserTokens) * 1000) / 10
        : 0;

      const replayable = skill.endpoints.filter(ep => {
        const tier = ep.replayability?.tier;
        return tier === 'green' || tier === 'yellow';
      }).length;

      domains.push({
        domain: skill.domain,
        endpoints: skill.endpoints.length,
        replayable,
        domBytes,
        totalNetworkBytes,
        skillFileBytes,
        totalResponseBytes,
        browserTokens,
        replayTokens,
        savingsPercent,
      });
    } catch {
      // Skip invalid files
    }
  }

  const totals = {
    domains: domains.length,
    endpoints: domains.reduce((s, d) => s + d.endpoints, 0),
    replayable: domains.reduce((s, d) => s + d.replayable, 0),
    totalDomBytes: domains.reduce((s, d) => s + d.domBytes, 0),
    browserTokens: domains.reduce((s, d) => s + d.browserTokens, 0),
    replayTokens: domains.reduce((s, d) => s + d.replayTokens, 0),
    savingsPercent: 0,
  };
  totals.savingsPercent = totals.browserTokens > 0
    ? Math.round((1 - totals.replayTokens / totals.browserTokens) * 1000) / 10
    : 0;

  return { domains, totals };
}

export function formatStatsHuman(report: StatsReport): string {
  if (report.domains.length === 0) {
    return '  No skill files found. Run `apitap capture <url>` first.';
  }

  const lines: string[] = [
    '',
    '  ApiTap — Usage Report',
    '  ' + '═'.repeat(22),
    '',
    `  Skill files:      ${report.totals.domains} domains`,
    `  Total endpoints:  ${report.totals.endpoints}`,
    `  Replayable:       ${report.totals.replayable} (green/yellow tier)`,
    '',
    '  Token savings (measured):',
  ];

  // Table
  const domCol = 24;
  const hdr = [
    '  ' + pad('Domain', domCol) + pad('DOM size', 10) + pad('Browser', 10) + pad('ApiTap', 10) + 'Saved',
  ];
  const sep = '  ' + '─'.repeat(domCol) + '─'.repeat(10) + '─'.repeat(10) + '─'.repeat(10) + '─'.repeat(8);

  lines.push(sep);
  lines.push(...hdr);
  lines.push(sep);

  for (const d of report.domains) {
    const domName = d.domain.length > domCol - 2
      ? d.domain.slice(0, domCol - 3) + '…'
      : d.domain;
    const hasMeasured = d.domBytes !== DEFAULT_DOM_BYTES;
    const browserLabel = hasMeasured
      ? formatTokens(d.browserTokens)
      : `~${formatTokens(d.browserTokens)}`;
    lines.push(
      '  ' +
      pad(domName, domCol) +
      pad(formatBytes(d.domBytes), 10) +
      pad(browserLabel, 10) +
      pad(formatTokens(d.replayTokens), 10) +
      `${d.savingsPercent}%`,
    );
  }

  lines.push(sep);
  const hasMeasuredTotals = report.domains.some(d => d.domBytes !== DEFAULT_DOM_BYTES);
  const totalBrowserLabel = hasMeasuredTotals
    ? formatTokens(report.totals.browserTokens)
    : `~${formatTokens(report.totals.browserTokens)}`;
  lines.push(
    '  ' +
    pad('Total', domCol) +
    pad(formatBytes(report.totals.totalDomBytes), 10) +
    pad(totalBrowserLabel, 10) +
    pad(formatTokens(report.totals.replayTokens), 10) +
    `${report.totals.savingsPercent}%`,
  );
  lines.push(sep);
  lines.push('');

  if (hasMeasuredTotals) {
    lines.push('  Browser: measured DOM size during capture (page.content().length / 4)');
  } else {
    lines.push('  Browser: estimated ~100K tokens/site (re-capture for measured values)');
  }
  lines.push('  ApiTap:  measured skill file + API response sizes');
  lines.push('');

  return lines.join('\n');
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tk`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tk`;
  return `${tokens} tk`;
}

function emptyReport(): StatsReport {
  return {
    domains: [],
    totals: {
      domains: 0, endpoints: 0, replayable: 0,
      totalDomBytes: 0, browserTokens: 0, replayTokens: 0, savingsPercent: 0,
    },
  };
}

// src/inspect/report.ts
import type { SkillFile, SkillEndpoint } from '../types.js';
import { detectAntiBot, type AntiBotSignal } from '../capture/anti-bot.js';

export interface InspectReport {
  domain: string;
  scanDuration: number;
  totalRequests: number;
  filteredRequests: number;
  domBytes?: number;
  endpoints: InspectEndpoint[];
  antiBot: AntiBotSignal[];
  summary: {
    total: number;
    replayable: number;
    authRequired: number;
    framework: string | null;
    browserTokens: number;
    replayTokens: number;
    savingsPercent: number;
  };
}

interface InspectEndpoint {
  method: string;
  path: string;
  tier: string;
  auth: string;
  responseBytes: number;
  responseShape: { type: string; fields?: string[] };
  graphql: { operations: string[] } | null;
  pagination: { type: string; paramName: string } | null;
}

/**
 * Build an inspect report from capture results.
 */
export function buildInspectReport(options: {
  skills: Map<string, SkillFile>;
  totalRequests: number;
  filteredRequests: number;
  duration: number;
  domBytes?: number;
  antiBotSignals: AntiBotSignal[];
  targetDomain: string;
}): InspectReport {
  const { skills, totalRequests, filteredRequests, duration, domBytes, antiBotSignals, targetDomain } = options;

  // Merge all endpoints across domains for the report
  const allEndpoints: InspectEndpoint[] = [];
  let totalResponseBytes = 0;
  let authCount = 0;

  for (const skill of skills.values()) {
    for (const ep of skill.endpoints) {
      const auth = getAuthLabel(ep);
      if (auth !== 'none') authCount++;

      const respBytes = ep.responseBytes ?? 0;
      totalResponseBytes += respBytes;

      allEndpoints.push({
        method: ep.method,
        path: ep.path,
        tier: ep.replayability?.tier ?? 'unknown',
        auth,
        responseBytes: respBytes,
        responseShape: ep.responseShape,
        graphql: isGraphQL(ep) ? { operations: [ep.id.replace(/^(get|post)-graphql-/, '')] } : null,
        pagination: ep.pagination ? { type: ep.pagination.type, paramName: ep.pagination.paramName } : null,
      });
    }
  }

  const replayable = allEndpoints.filter(ep =>
    ep.tier === 'green' || ep.tier === 'yellow',
  ).length;

  const browserTokens = domBytes ? Math.round(domBytes / 4) : 0;
  const replayTokens = Math.round(totalResponseBytes / 4);
  const savingsPercent = browserTokens > 0
    ? Math.round((1 - replayTokens / browserTokens) * 1000) / 10
    : 0;

  const framework = detectFramework(allEndpoints);

  return {
    domain: targetDomain,
    scanDuration: duration,
    totalRequests,
    filteredRequests,
    domBytes,
    endpoints: allEndpoints,
    antiBot: antiBotSignals,
    summary: {
      total: allEndpoints.length,
      replayable,
      authRequired: authCount,
      framework,
      browserTokens,
      replayTokens,
      savingsPercent,
    },
  };
}

export function formatInspectHuman(report: InspectReport): string {
  const lines: string[] = [
    '',
    `  ${report.domain} — API Discovery Report`,
    '  ' + '═'.repeat(report.domain.length + 25),
    '',
    `  Scan duration:    ${report.scanDuration}s`,
    `  Total requests:   ${report.totalRequests}`,
    `  Filtered (noise): ${report.filteredRequests} (${pct(report.filteredRequests, report.totalRequests)})`,
    `  API endpoints:    ${report.summary.total}` + endpointBreakdown(report.endpoints),
    '',
  ];

  // Auth and anti-bot info
  if (report.summary.authRequired > 0) {
    lines.push(`  Auth required:    ${report.summary.authRequired} endpoints`);
  } else {
    lines.push('  Auth required:    None');
  }

  if (report.antiBot.length > 0) {
    lines.push(`  Anti-bot:         ${report.antiBot.join(', ')} detected`);
  } else {
    lines.push('  Anti-bot:         None detected');
  }

  if (report.summary.framework) {
    lines.push(`  Framework:        ${report.summary.framework}`);
  }

  lines.push('');

  // Endpoint table
  if (report.endpoints.length > 0) {
    lines.push('  Endpoints:');
    const methodW = 8;
    const pathW = 32;
    const tierW = 8;
    const authW = 8;
    const sizeW = 10;

    const sep = '  ' + '─'.repeat(methodW + pathW + tierW + authW + sizeW);
    lines.push(sep);
    lines.push('  ' + pad('Method', methodW) + pad('Path', pathW) + pad('Tier', tierW) + pad('Auth', authW) + 'Size');
    lines.push(sep);

    for (const ep of report.endpoints) {
      const pathStr = ep.path.length > pathW - 2 ? ep.path.slice(0, pathW - 3) + '…' : ep.path;
      lines.push('  ' +
        pad(ep.method, methodW) +
        pad(pathStr, pathW) +
        pad(ep.tier, tierW) +
        pad(ep.auth, authW) +
        formatBytes(ep.responseBytes),
      );
    }
    lines.push(sep);
  }

  lines.push('');

  // Data shapes
  const shapedEndpoints = report.endpoints.filter(ep => ep.responseShape.fields?.length);
  if (shapedEndpoints.length > 0) {
    lines.push('  Data shapes:');
    for (const ep of shapedEndpoints.slice(0, 5)) {
      const fields = ep.responseShape.fields!.slice(0, 6).join(', ');
      const suffix = ep.responseShape.fields!.length > 6 ? ', ...' : '';
      lines.push(`    ${ep.method} ${ep.path} → { type: "${ep.responseShape.type}", fields: [${fields}${suffix}] }`);
    }
    lines.push('');
  }

  // Summary
  lines.push('  Summary:');
  lines.push(`    Replayable: ${report.summary.replayable} of ${report.summary.total} endpoints`);
  if (report.domBytes && report.summary.browserTokens > 0) {
    lines.push(`    DOM size:   ${formatBytes(report.domBytes)} = ${formatTokens(report.summary.browserTokens)} (what browser automation sends to LLM)`);
    lines.push(`    API replay: ${formatTokens(report.summary.replayTokens)}`);
    lines.push(`    Savings:    ${report.summary.savingsPercent}%`);
    if (report.summary.savingsPercent < 0) {
      lines.push('              API responses exceed DOM size — browser automation may be more token-efficient');
    }
  }
  lines.push('');
  lines.push(`  To capture these endpoints: apitap capture ${report.domain}`);
  lines.push('');

  return lines.join('\n');
}

function getAuthLabel(ep: SkillEndpoint): string {
  const headers = ep.headers;
  if (headers.authorization?.includes('[stored]')) return 'Bearer';
  if (headers['x-api-key']?.includes('[stored]')) return 'API Key';
  for (const [key, val] of Object.entries(headers)) {
    if (val === '[stored]') return key;
  }
  return 'none';
}

function isGraphQL(ep: SkillEndpoint): boolean {
  return ep.id.includes('graphql');
}

function detectFramework(endpoints: InspectEndpoint[]): string | null {
  const paths = endpoints.map(e => e.path);
  if (paths.some(p => p.includes('_next/'))) return 'Next.js';
  if (paths.some(p => p.includes('__nuxt'))) return 'Nuxt';
  if (endpoints.some(e => e.graphql)) return 'GraphQL';
  return null;
}

function endpointBreakdown(endpoints: InspectEndpoint[]): string {
  const rest = endpoints.filter(e => !e.graphql).length;
  const gql = endpoints.filter(e => e.graphql).length;
  if (gql > 0) return ` (${rest} REST, ${gql} GraphQL)`;
  return '';
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes > 0) return `${bytes} B`;
  return '-';
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tokens`;
  return `${tokens} tokens`;
}

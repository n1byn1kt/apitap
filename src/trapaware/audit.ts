// src/trapaware/audit.ts
import { appendFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Finding, ReadFinding, EgressFinding } from './types.js';

function xdgStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
}

export function getAuditLogPath(): string {
  return join(xdgStateHome(), 'apitap', 'findings.jsonl');
}

/**
 * Build the JSONL line for a finding. For read findings, the `url` parameter
 * is the page the scanner ran on. For egress findings, `url` is unused
 * (attribution lives on the finding itself via domain + requestPath).
 *
 * EXCERPTS ARE NEVER ADDED FOR EGRESS FINDINGS. Only whitelisted fields
 * are copied from the EgressFinding into the serialized line.
 */
function buildLine(finding: Finding, url: string | undefined): string {
  const ts = new Date().toISOString();
  if (finding.source === 'read') {
    const line = {
      ts,
      source: 'read' as const,
      url,
      scanner: finding.scanner,
      severity: finding.severity,
      hiddenBy: finding.hiddenBy,
      location: finding.location,
      excerpt: finding.excerpt,
      rationale: finding.rationale,
    };
    return JSON.stringify(line);
  }
  // EgressFinding — never include any `excerpt` or raw match content.
  const line = {
    ts,
    source: 'egress' as const,
    domain: finding.domain,
    requestPath: finding.requestPath,
    scanner: finding.scanner,
    severity: finding.severity,
    paramLocation: finding.paramLocation,
    paramPath: finding.paramPath,
    matchLength: finding.matchLength,
    action: finding.action,
    rationale: finding.rationale,
  };
  return JSON.stringify(line);
}

/**
 * Append a single finding to the audit log. Creates parent directory and
 * file as needed with 0o700 / 0o600 permissions.
 *
 * Write failures are logged to stderr but do not throw — the caller's
 * request must not be failed because the audit log was unavailable.
 */
export async function appendFinding(
  finding: Finding,
  url: string | undefined,
): Promise<void> {
  const path = getAuditLogPath();
  const line = buildLine(finding, url) + '\n';
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    // chmod in case the file pre-existed with different perms
    await chmod(path, 0o600).catch(() => { /* best-effort */ });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`apitap: audit log write failed: ${msg}\n`);
  }
}

export interface ReadFindingsOptions {
  source?: 'read' | 'egress';
  scanner?: string;
  since?: string; // ISO 8601
}

/**
 * Read all findings from the audit log, optionally filtered.
 * Malformed lines are skipped with a stderr warning.
 */
export async function readFindings(
  opts: ReadFindingsOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const path = getAuditLogPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(l => l.length > 0);
  const results: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`apitap: skipping malformed audit line\n`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (opts.source && obj.source !== opts.source) continue;
    if (opts.scanner && obj.scanner !== opts.scanner) continue;
    if (opts.since && typeof obj.ts === 'string' && obj.ts < opts.since) continue;
    results.push(obj);
  }
  return results;
}

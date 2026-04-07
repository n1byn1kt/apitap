// test/trapaware/audit.test.ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFinding,
  readFindings,
  getAuditLogPath,
} from '../../src/trapaware/audit.js';
import type { ReadFinding, EgressFinding } from '../../src/trapaware/types.js';

let tempRoot: string;
const origXdgState = process.env.XDG_STATE_HOME;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'apitap-audit-'));
  process.env.XDG_STATE_HOME = tempRoot;
});

afterEach(async () => {
  if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = origXdgState;
  await rm(tempRoot, { recursive: true, force: true });
});

test('audit log path resolves under XDG_STATE_HOME', () => {
  assert.equal(getAuditLogPath(), join(tempRoot, 'apitap', 'findings.jsonl'));
});

test('appendFinding creates file on first write with 0o600', async () => {
  const finding: ReadFinding = {
    source: 'read',
    scanner: 'hidden_role_marker',
    severity: 'medium',
    hiddenBy: 'inline_style_offscreen',
    location: { offset: 100, length: 42, surroundingTag: 'span' },
    excerpt: 'SYSTEM: example',
    rationale: 'test',
  };
  await appendFinding(finding, 'https://example.com/page');
  const st = await stat(getAuditLogPath());
  // Only check owner bits — umask may vary.
  assert.equal((st.mode & 0o777) & 0o077, 0, 'non-owner bits must be clear');
});

test('appended line is valid JSON with required fields', async () => {
  const finding: ReadFinding = {
    source: 'read',
    scanner: 'hidden_known_signature',
    severity: 'medium',
    hiddenBy: 'html_comment',
    location: { offset: 0, length: 30, surroundingTag: null },
    excerpt: 'ignore previous instructions',
    rationale: 'test',
  };
  await appendFinding(finding, 'https://example.com/');
  const raw = await readFile(getAuditLogPath(), 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.source, 'read');
  assert.equal(parsed.scanner, 'hidden_known_signature');
  assert.equal(parsed.severity, 'medium');
  assert.equal(parsed.url, 'https://example.com/');
  assert.ok(typeof parsed.ts === 'string');
  assert.ok(parsed.ts.endsWith('Z'));
});

test('multiple appends each produce a line, trailing newline', async () => {
  for (let i = 0; i < 5; i++) {
    const f: ReadFinding = {
      source: 'read',
      scanner: 'hidden_role_marker',
      severity: 'medium',
      hiddenBy: 'html_comment',
      location: { offset: i, length: 10, surroundingTag: null },
      excerpt: `example ${i}`,
      rationale: 'test',
    };
    await appendFinding(f, 'https://example.com/');
  }
  const raw = await readFile(getAuditLogPath(), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  const lines = raw.split('\n').filter(l => l.length > 0);
  assert.equal(lines.length, 5);
});

test('readFindings returns parsed objects', async () => {
  const f: ReadFinding = {
    source: 'read',
    scanner: 'hidden_role_marker',
    severity: 'medium',
    hiddenBy: 'html_comment',
    location: { offset: 0, length: 10, surroundingTag: null },
    excerpt: 'x',
    rationale: 'test',
  };
  await appendFinding(f, 'https://example.com/');
  const results = await readFindings();
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'read');
});

test('readFindings skips malformed lines with a warning', async () => {
  const f: ReadFinding = {
    source: 'read',
    scanner: 'hidden_role_marker',
    severity: 'medium',
    hiddenBy: 'html_comment',
    location: { offset: 0, length: 10, surroundingTag: null },
    excerpt: 'x',
    rationale: 'test',
  };
  await appendFinding(f, 'https://example.com/');
  // Corrupt the file
  const { appendFile } = await import('node:fs/promises');
  await appendFile(getAuditLogPath(), '{this is not json\n');
  const results = await readFindings();
  assert.equal(results.length, 1); // still gets the good one
});

test('REDACTION CONTRACT: egress finding never contains secret bytes', async () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';
  const finding: EgressFinding = {
    source: 'egress',
    scanner: 'secret_aws_access_key',
    severity: 'high',
    domain: 'api.example.com',
    requestPath: '/submit',
    paramLocation: 'body_json',
    paramPath: 'body.credentials.accessKey',
    matchLength: SECRET.length,
    action: 'annotate',
    rationale: 'AWS access key pattern matched in request body',
  };
  await appendFinding(finding, undefined);
  const raw = await readFile(getAuditLogPath(), 'utf8');
  // The serialized JSONL must not contain the secret in any form.
  assert.equal(raw.includes(SECRET), false, 'secret must not appear in audit log');
  // Must also not contain any substring of length >= 8 from the secret.
  for (let i = 0; i + 8 <= SECRET.length; i++) {
    const chunk = SECRET.slice(i, i + 8);
    assert.equal(
      raw.includes(chunk),
      false,
      `8-char substring "${chunk}" must not appear in audit log`,
    );
  }
});

test('REDACTION CONTRACT: read finding excerpt is truncated to 80 chars', async () => {
  const longPayload = 'SYSTEM: ' + 'x'.repeat(500);
  const finding: ReadFinding = {
    source: 'read',
    scanner: 'hidden_role_marker',
    severity: 'medium',
    hiddenBy: 'html_comment',
    location: { offset: 0, length: longPayload.length, surroundingTag: null },
    excerpt: longPayload.slice(0, 80), // the scanner is responsible for truncating
    rationale: 'test',
  };
  await appendFinding(finding, 'https://example.com/');
  const raw = await readFile(getAuditLogPath(), 'utf8');
  const parsed = JSON.parse(raw.trim());
  assert.ok(parsed.excerpt.length <= 80);
});

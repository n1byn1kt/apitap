// test/e2e/replay-with-egress-annotate.test.ts
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

let server: Server;
let baseUrl: string;
let capturedBody = '';

let tempRoot: string;
const origXdgState = process.env.XDG_STATE_HOME;
const origXdgConfig = process.env.XDG_CONFIG_HOME;

function skillFile(): SkillFile {
  return {
    version: '1.2',
    domain: '127.0.0.1',
    capturedAt: '2026-04-06T00:00:00Z',
    baseUrl,
    endpoints: [{
      id: 'post-submit',
      method: 'POST',
      path: '/submit',
      queryParams: {},
      headers: { 'content-type': 'application/json' },
      requestBody: {
        template: JSON.stringify({ token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
        contentType: 'application/json',
      },
      examples: { request: { url: `${baseUrl}/submit` } },
    } as any],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: 'test' },
    provenance: 'self',
    egress_check: true,
    egress_action: 'annotate',
  };
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      capturedBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  capturedBody = '';
  tempRoot = await mkdtemp(join(tmpdir(), 'apitap-egress-annotate-'));
  process.env.XDG_STATE_HOME = tempRoot;
  process.env.XDG_CONFIG_HOME = tempRoot;
});

afterEach(async () => {
  if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = origXdgState;
  if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdgConfig;
  await rm(tempRoot, { recursive: true, force: true });
});

test('E2E annotate: request goes out, warnings attached to response', async () => {
  const skill = skillFile();
  const result = await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });

  assert.ok(capturedBody.includes('ghp_'));
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings!.length, 1);
  assert.equal(result.warnings![0].scanner, 'secret_github_classic_pat');
  assert.equal(result.warnings![0].action, 'annotate');
});

test('E2E annotate: audit log file is created with a finding', async () => {
  const skill = skillFile();
  await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });

  const logPath = join(tempRoot, 'apitap', 'findings.jsonl');
  const raw = await readFile(logPath, 'utf8');
  const lines = raw.trim().split('\n').filter(l => l.length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.source, 'egress');
  assert.equal(parsed.scanner, 'secret_github_classic_pat');
  assert.equal(parsed.action, 'annotate');
  assert.equal(raw.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), false);
});

test('E2E annotate: clean request has no warnings field', async () => {
  const skill = skillFile();
  skill.endpoints[0].requestBody!.template = JSON.stringify({ foo: 'bar' });
  const result = await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });
  assert.equal('warnings' in result, false, 'no warnings field when scan found nothing');
});

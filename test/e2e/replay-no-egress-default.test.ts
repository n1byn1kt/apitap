// test/e2e/replay-no-egress-default.test.ts
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

let server: Server;
let baseUrl: string;
let capturedRequests: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];

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
  };
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedRequests.push({
        method: req.method || '',
        url: req.url || '',
        headers: req.headers as any,
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  capturedRequests = [];
  tempRoot = await mkdtemp(join(tmpdir(), 'apitap-cronjob-'));
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

test('CRON CONTRACT: outbound request bytes unchanged when egress check absent', async () => {
  const skill = skillFile();
  await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });

  assert.equal(capturedRequests.length, 1);
  const req = capturedRequests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/submit');
  assert.equal(
    req.body,
    JSON.stringify({ token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
    'request body must go out byte-identical with no egress check',
  );
});

test('CRON CONTRACT: response envelope has no warnings field when egress check absent', async () => {
  const skill = skillFile();
  const result = await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });

  assert.equal(
    'warnings' in result,
    false,
    'response envelope must not have a warnings field when egress check is disabled',
  );
  assert.equal(result.status, 200);
  assert.ok(result.headers);
  assert.ok(result.data);
});

test('CRON CONTRACT: findings.jsonl does NOT exist after replay with egress check absent', async () => {
  const skill = skillFile();
  await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });

  const expectedPath = join(tempRoot, 'apitap', 'findings.jsonl');
  let existed = true;
  try { await stat(expectedPath); } catch { existed = false; }
  assert.equal(existed, false, 'findings.jsonl must not be created by a disabled egress check');

  let parentExisted = true;
  try { await stat(join(tempRoot, 'apitap')); } catch { parentExisted = false; }
  assert.equal(parentExisted, false, 'trapaware parent directory must not be created');
});

test('CRON CONTRACT: replay with secret body + default config → secret flows through unchanged', async () => {
  // This is the critical inverse: a skill file with egress_check unset and
  // no global config should NOT scan, NOT log, NOT annotate, NOT block,
  // even when the outbound body contains an obvious secret.
  const skill = skillFile();
  const result = await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });

  assert.equal(capturedRequests.length, 1);
  assert.ok(capturedRequests[0].body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.equal('warnings' in result, false);
  const expectedPath = join(tempRoot, 'apitap', 'findings.jsonl');
  let existed = true;
  try { await stat(expectedPath); } catch { existed = false; }
  assert.equal(existed, false);
});

// test/e2e/replay-with-egress-block.test.ts
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { SkillFile } from '../../src/types.js';

let server: Server;
let baseUrl: string;
let fetchWasCalled = false;

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
        template: JSON.stringify({ key: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }),
        contentType: 'application/json',
      },
      examples: { request: { url: `${baseUrl}/submit` } },
    } as any],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: 'test' },
    provenance: 'self',
    egress_check: true,
    egress_action: 'block',
  };
}

before(async () => {
  server = createServer((_req, res) => {
    fetchWasCalled = true;
    res.writeHead(200);
    res.end();
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
  fetchWasCalled = false;
  tempRoot = await mkdtemp(join(tmpdir(), 'apitap-egress-block-'));
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

test('E2E block: AWS key in body causes replay to throw', async () => {
  const skill = skillFile();
  await assert.rejects(
    replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true }),
    /Egress blocked/,
  );
  assert.equal(fetchWasCalled, false, 'network fetch must not happen when blocked');
});

test('E2E block: PII-only request is NOT blocked (PII is medium, block only on high)', async () => {
  const skill = skillFile();
  skill.endpoints[0].requestBody!.template = JSON.stringify({ email: 'user@example.com' });
  await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });
  assert.equal(fetchWasCalled, true);
});

test('E2E block: clean request passes through', async () => {
  const skill = skillFile();
  skill.endpoints[0].requestBody!.template = JSON.stringify({ foo: 'bar' });
  await replayEndpoint(skill, 'post-submit', { _skipSsrfCheck: true });
  assert.equal(fetchWasCalled, true);
});

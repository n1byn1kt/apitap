// test/replay/query-auth.test.ts — query-param credentials (#87)
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEndpoint } from '../../src/replay/engine.js';
import { scanOutboundRequest } from '../../src/replay/egress.js';
import { AuthManager } from '../../src/auth/manager.js';
import type { SkillFile } from '../../src/types.js';

const KEY = 'test-algolia-key-not-real-0123456';

describe('replayEndpoint query-param credentials (#87)', () => {
  let server: Server;
  let other: Server;
  let port: number;
  let otherPort: number;
  let otherQuery: Record<string, string> | null = null;
  let testDir: string;
  let stateDir: string;
  let authManager: AuthManager;
  const prevState = process.env.XDG_STATE_HOME;

  before(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const query = Object.fromEntries(u.searchParams);
      if (u.pathname === '/redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/landing?page=2&x-algolia-api-key=${query['x-algolia-api-key'] ?? ''}` });
        res.end();
        return;
      }
      res.writeHead(query['x-algolia-api-key'] === KEY ? 200 : 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query }));
    });
    other = createServer((req, res) => {
      otherQuery = Object.fromEntries(new URL(req.url!, 'http://x').searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>(r => server.listen(0, r));
    await new Promise<void>(r => other.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    otherPort = (other.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>(r => server.close(() => r()));
    await new Promise<void>(r => other.close(() => r()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-qauth-'));
    stateDir = await mkdtemp(join(tmpdir(), 'apitap-qauth-state-'));
    process.env.XDG_STATE_HOME = stateDir;
    authManager = new AuthManager(testDir, 'test-machine-id');
    otherQuery = null;
  });

  afterEach(async () => {
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    await rm(testDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  function makeSkill(placeholder: '[stored]' | '[scrubbed]', path = '/1/indexes/Item_dev/query'): SkillFile {
    const base = `http://localhost:${port}`;
    return {
      version: '1.1',
      domain: 'localhost',
      capturedAt: '2026-10-10T00:00:00.000Z',
      baseUrl: base,
      endpoints: [{
        id: 'get-search',
        method: 'GET',
        path,
        queryParams: {
          query: { type: 'string', example: 'rust' },
          'x-algolia-api-key': { type: 'string', example: placeholder },
        },
        headers: {},
        responseShape: { type: 'object' },
        examples: {
          request: { url: `${base}${path}?query=rust&x-algolia-api-key=${placeholder}`, headers: {} },
          responsePreview: null,
        },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: 'test' },
      provenance: 'unsigned',
    } as SkillFile;
  }

  const storeKey = () => authManager.store('localhost', {
    type: 'api-key', header: '', value: '',
    queryParams: [{ name: 'x-algolia-api-key', value: KEY }],
  });

  it('injects a stored query credential for a [stored] placeholder', async () => {
    await storeKey();
    const result = await replayEndpoint(makeSkill('[stored]'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    assert.equal((result.data as any).query['x-algolia-api-key'], KEY);
  });

  it('resolves [scrubbed] from older skill files by param name', async () => {
    await storeKey();
    const result = await replayEndpoint(makeSkill('[scrubbed]'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(result.status, 200);
  });

  it('deletes an unresolved placeholder and explains the missing query credential', async () => {
    const result = await replayEndpoint(makeSkill('[stored]'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(result.status, 403);
    const data = result.data as any;
    assert.equal(data.error, 'Query credential missing');
    assert.match(data.suggestion, /x-algolia-api-key/);
    assert.equal(data.originalResponse.query['x-algolia-api-key'], undefined, 'literal placeholder must not be sent');
  });

  it('a caller-supplied value wins over the stored credential', async () => {
    await storeKey();
    const result = await replayEndpoint(makeSkill('[stored]'), 'get-search', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
      params: { 'x-algolia-api-key': 'caller-supplied-key' },
    });
    assert.equal(result.status, 403);
    assert.equal((result.data as any).originalResponse.query['x-algolia-api-key'], 'caller-supplied-key');
  });

  it('egress scanner sees the pre-injection URL, so block mode does not self-block', async () => {
    // A vendor-shaped token is something the scanner flags as high severity
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const raw = scanOutboundRequest({
      url: `http://localhost:${port}/q?access_token=${token}`, method: 'GET',
      domain: 'localhost', requestPath: '/q',
    });
    assert.ok(raw.some(f => f.severity === 'high'), 'scanner should flag the raw token in the URL');

    await authManager.store('localhost', {
      type: 'api-key', header: '', value: '',
      queryParams: [{ name: 'access_token', value: token }],
    });
    const skill = makeSkill('[stored]');
    const ep = skill.endpoints[0];
    delete ep.queryParams['x-algolia-api-key'];
    ep.queryParams.access_token = { type: 'string', example: '[stored]' };
    ep.examples.request.url = `http://localhost:${port}${ep.path}?query=rust&access_token=[stored]`;

    const result = await replayEndpoint(skill, 'get-search', {
      authManager, domain: 'localhost', _skipSsrfCheck: true, egressCheck: 'block',
    });
    assert.equal(result.warnings, undefined);
    assert.equal((result.data as any).originalResponse.query.access_token, token);
  });

  it('strips the stored query credential on a cross-host redirect', async () => {
    await storeKey();
    await replayEndpoint(makeSkill('[stored]', '/redirect'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.ok(otherQuery, 'redirect target was reached');
    assert.equal(otherQuery!.page, '2');
    assert.equal(otherQuery!['x-algolia-api-key'], undefined);
  });

  it('round-trips stored auth without queryParams (pre-v2.3.1 auth.enc)', async () => {
    await authManager.store('localhost', { type: 'bearer', header: 'authorization', value: 'Bearer abc' });
    const auth = await authManager.retrieve('localhost');
    assert.equal(auth?.queryParams, undefined);
    assert.equal(auth?.header, 'authorization');
  });
});

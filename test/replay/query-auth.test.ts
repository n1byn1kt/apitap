// test/replay/query-auth.test.ts — query-param credentials (#87)
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEndpoint, containsInjected, stripAuthForRedirect, stripQueryAuthForRedirect } from '../../src/replay/engine.js';
import { scanOutboundRequest } from '../../src/replay/egress.js';
import { AuthManager } from '../../src/auth/manager.js';
import type { SkillFile } from '../../src/types.js';

// Google-key-shaped test value, assembled so secret scanners don't match a literal
const FAKE_GOOGLE_STYLE_KEY = ['AI', 'za'].join('') + 'FAKE0tEst1KeY2nOt3ReAl4vAlUe5xyz67';

const KEY = 'test-algolia-key-not-real-0123456';

describe('replayEndpoint query-param credentials (#87)', () => {
  let server: Server;
  let other: Server;
  let port: number;
  let otherPort: number;
  let otherQuery: Record<string, string> | null = null;
  let lastQuery: Record<string, string> | null = null;
  let testDir: string;
  let stateDir: string;
  let authManager: AuthManager;
  const prevState = process.env.XDG_STATE_HOME;

  before(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const query = Object.fromEntries(u.searchParams);
      lastQuery = query;
      if (u.pathname === '/redirect-encoded') {
        const back = encodeURIComponent(`http://localhost:${port}/search?x-algolia-api-key=${query['x-algolia-api-key'] ?? ''}`);
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/landing?returnUrl=${back}` });
        res.end();
        return;
      }
      if (u.pathname === '/echo-raw') {
        // Echo the raw query string, form-encoded as the client sent it
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Echo': u.search });
        res.end(JSON.stringify({ raw: u.search }));
        return;
      }
      if (u.pathname === '/redirect-deep') {
        // Key wrapped in more encoding layers than the checker unwraps
        let wrapped = `x-algolia-api-key=${query['x-algolia-api-key'] ?? ''}`;
        for (let i = 0; i < 12; i++) wrapped = encodeURIComponent(wrapped);
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/landing?next=${wrapped}` });
        res.end();
        return;
      }
      if (u.pathname === '/redirect-bad-utf8') {
        // Every byte of the key percent-encoded, in one run with an invalid UTF-8 byte (#93)
        const hex = [...Buffer.from(query['x-algolia-api-key'] ?? '')].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/landing?next=%41%FF${hex}%42` });
        res.end();
        return;
      }
      if (u.pathname === '/redirect-plain') {
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/landing?next=${encodeURIComponent('https://example.com/a?b=c d+e')}` });
        res.end();
        return;
      }
      if (u.pathname === '/redirect-malformed') {
        // A stray malformed escape plus a double-encoded copy of the key
        const twice = encodeURIComponent(encodeURIComponent(`x-algolia-api-key=${query['x-algolia-api-key'] ?? ''}`));
        res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/landing/%zz?next=${twice}` });
        res.end();
        return;
      }
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
    lastQuery = null;
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
    assert.equal(lastQuery!['x-algolia-api-key'], KEY);
  });

  it('redacts an injected credential the API echoes back in the response', async () => {
    await storeKey();
    const result = await replayEndpoint(makeSkill('[stored]'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(result.status, 200);
    assert.equal((result.data as any).query['x-algolia-api-key'], '[stored]');
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it('redacts a form-encoded echo of a key with special characters', async () => {
    const secret = "k y(Ab12)!~'Cd34";
    await authManager.store('localhost', {
      type: 'api-key', header: '', value: '',
      queryParams: [{ name: 'x-algolia-api-key', value: secret }],
    });
    const result = await replayEndpoint(makeSkill('[stored]', '/echo-raw'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(lastQuery!['x-algolia-api-key'], secret);
    const out = JSON.stringify(result);
    assert.ok(!out.includes(new URLSearchParams({ v: secret }).toString().slice(2)), 'form-encoded key must be redacted');
    assert.match((result.data as any).raw, /x-algolia-api-key=\[stored\]/);
    assert.match(result.headers['x-echo'], /\[stored\]/);
  });

  it('does not fill a generic `key=[scrubbed]` from storage (may have been a sort key)', async () => {
    await authManager.store('localhost', {
      type: 'api-key', header: '', value: '',
      queryParams: [{ name: 'key', value: FAKE_GOOGLE_STYLE_KEY }],
    });
    const skill = makeSkill('[stored]');
    const ep = skill.endpoints[0];
    delete ep.queryParams['x-algolia-api-key'];
    ep.queryParams.key = { type: 'string', example: '[scrubbed]' };
    ep.examples.request.url = `http://localhost:${port}${ep.path}?query=rust&key=[scrubbed]`;

    await replayEndpoint(skill, 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(lastQuery!.key, undefined);
  });

  it('does not inject a key pinned to a different host', async () => {
    await authManager.store('localhost', {
      type: 'api-key', header: '', value: '',
      queryParams: [{ name: 'x-algolia-api-key', value: KEY, host: 'search.other-host.test' }],
    });
    const result = await replayEndpoint(makeSkill('[stored]'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(result.status, 403);
    assert.equal(lastQuery!['x-algolia-api-key'], undefined);
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
    assert.equal(lastQuery!['x-algolia-api-key'], undefined, 'literal placeholder must not be sent');
  });

  it('drops a scrubbed one-time param silently and keeps the login hint', async () => {
    const skill = makeSkill('[stored]');
    const ep = skill.endpoints[0];
    delete ep.queryParams['x-algolia-api-key'];
    ep.queryParams.state = { type: 'string', example: '[scrubbed]' };
    ep.examples.request.url = `http://localhost:${port}${ep.path}?query=rust&state=[scrubbed]`;

    const result = await replayEndpoint(skill, 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.equal(result.status, 403);
    const data = result.data as any;
    assert.equal(data.error, 'Authentication required');
    assert.match(data.suggestion, /log in/);
    assert.equal(data.originalResponse.query.state, undefined);
  });

  it('a caller-supplied value wins over the stored credential', async () => {
    await storeKey();
    const result = await replayEndpoint(makeSkill('[stored]'), 'get-search', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
      params: { 'x-algolia-api-key': 'caller-supplied-key' },
    });
    assert.equal(result.status, 403);
    assert.equal(lastQuery!['x-algolia-api-key'], 'caller-supplied-key');
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
    assert.equal(lastQuery!.access_token, token);
  });

  it('strips the stored query credential on a cross-host redirect', async () => {
    await storeKey();
    await replayEndpoint(makeSkill('[stored]', '/redirect'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.ok(otherQuery, 'redirect target was reached');
    assert.equal(otherQuery!.page, '2');
    assert.equal(otherQuery!['x-algolia-api-key'], undefined);
  });

  it('refuses a cross-host redirect that carries the key inside another param', async () => {
    await storeKey();
    await assert.rejects(
      () => replayEndpoint(makeSkill('[stored]', '/redirect-encoded'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true }),
      /redirect target carries a stored query credential/,
    );
    assert.equal(otherQuery, null, 'redirect target must not be reached');
  });

  it('still catches a double-encoded key next to a malformed escape', async () => {
    // Characters that change under encoding, so only real decoding finds it
    await authManager.store('localhost', {
      type: 'api-key', header: '', value: '',
      queryParams: [{ name: 'x-algolia-api-key', value: 'k+y/Ab12=Cd34&Ef' }],
    });
    await assert.rejects(
      () => replayEndpoint(makeSkill('[stored]', '/redirect-malformed'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true }),
      /redirect target carries a stored query credential/,
    );
    assert.equal(otherQuery, null);
  });

  it('fails closed on a redirect target encoded deeper than it unwraps', async () => {
    await authManager.store('localhost', {
      type: 'api-key', header: '', value: '',
      queryParams: [{ name: 'x-algolia-api-key', value: 'k+y/Ab12=Cd34&Ef' }],
    });
    await assert.rejects(
      () => replayEndpoint(makeSkill('[stored]', '/redirect-deep'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true }),
      /redirect target carries a stored query credential/,
    );
    assert.equal(otherQuery, null);
  });

  it('catches a percent-encoded key inside an escape run with invalid UTF-8 (#93)', async () => {
    await storeKey();
    await assert.rejects(
      () => replayEndpoint(makeSkill('[stored]', '/redirect-bad-utf8'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true }),
      /redirect target carries a stored query credential/,
    );
    assert.equal(otherQuery, null);
  });

  it('refuses stored auth for a foreign host even with SSRF checks disabled (#90)', async () => {
    await storeKey();
    const skill = makeSkill('[stored]');
    skill.baseUrl = `http://127.0.0.1:${otherPort}`;
    await assert.rejects(
      () => replayEndpoint(skill, 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true }),
      /Domain-lock violation/,
    );
    assert.equal(otherQuery, null, 'foreign host must not be reached');
  });

  it('still follows an ordinary cross-host redirect without the key', async () => {
    await storeKey();
    await replayEndpoint(makeSkill('[stored]', '/redirect-plain'), 'get-search', { authManager, domain: 'localhost', _skipSsrfCheck: true });
    assert.ok(otherQuery, 'redirect target was reached');
    assert.equal(otherQuery!.next, 'https://example.com/a?b=c d+e');
  });

  it('round-trips stored auth without queryParams (pre-v2.3.1 auth.enc)', async () => {
    await authManager.store('localhost', { type: 'bearer', header: 'authorization', value: 'Bearer abc' });
    const auth = await authManager.retrieve('localhost');
    assert.equal(auth?.queryParams, undefined);
    assert.equal(auth?.header, 'authorization');
  });
});

describe('redirect auth stripping on scheme downgrade (#91)', () => {
  const headers = { Authorization: 'Bearer secret-token-value', Accept: 'application/json' };
  const https = new URL('https://api.example.com/data?api_key=' + KEY);

  it('drops auth headers on a same-host https → http redirect', () => {
    const out = stripAuthForRedirect(headers, https, new URL('http://api.example.com/data'));
    assert.deepEqual(out, { Accept: 'application/json' });
  });

  it('keeps auth headers on a same-host https → https redirect', () => {
    assert.deepEqual(stripAuthForRedirect(headers, https, new URL('https://api.example.com/v2')), headers);
  });

  it('keeps auth headers on an http → https upgrade', () => {
    const http = new URL('http://api.example.com/data');
    assert.deepEqual(stripAuthForRedirect(headers, http, new URL('https://api.example.com/data')), headers);
  });

  it('strips the stored query key on a same-host https → http redirect', () => {
    const target = new URL('http://api.example.com/data?api_key=' + KEY + '&page=2');
    stripQueryAuthForRedirect(target, https, ['api_key'], [KEY]);
    assert.equal(target.searchParams.get('api_key'), null);
    assert.equal(target.searchParams.get('page'), '2');
  });

  it('refuses a downgraded redirect that carries the key elsewhere', () => {
    const target = new URL('http://api.example.com/data?next=' + encodeURIComponent('/x?api_key=' + KEY));
    assert.throws(() => stripQueryAuthForRedirect(target, https, ['api_key'], [KEY]), /redirect target carries/);
  });

  it('leaves a same-host https → https redirect untouched', () => {
    const target = new URL('https://api.example.com/v2?api_key=' + KEY);
    stripQueryAuthForRedirect(target, https, ['api_key'], [KEY]);
    assert.equal(target.searchParams.get('api_key'), KEY);
  });
});

describe('containsInjected lenient decoding (#93)', () => {
  const hex = (s: string) => [...Buffer.from(s)].map(b => '%' + b.toString(16).padStart(2, '0')).join('');

  it('finds a fully percent-encoded key next to an invalid UTF-8 byte', () => {
    assert.equal(containsInjected(`/x?n=%41%FF${hex(KEY)}%42`, [KEY]), true);
  });

  it('finds it double-encoded next to an invalid byte', () => {
    assert.equal(containsInjected(`/x?n=${encodeURIComponent('%FF' + hex(KEY))}`, [KEY]), true);
  });

  it('still decodes valid multibyte UTF-8 in the same run', () => {
    const key = 'zażółć-key-1234';
    assert.equal(containsInjected(`/x?n=%FF${hex(key)}`, [key]), true);
  });

  it('does not report a run without the key', () => {
    assert.equal(containsInjected('/x?n=%41%FF%42%E2%82%AC', [KEY]), false);
  });
});

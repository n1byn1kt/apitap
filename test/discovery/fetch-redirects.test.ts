// test/discovery/fetch-redirects.test.ts
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { safeFetchDetailed, MAX_REDIRECTS } from '../../src/discovery/fetch.js';

let server: Server | undefined;
let baseUrl = '';
let hits = 0;

function listen(handler: Parameters<typeof createServer>[1]): Promise<void> {
  hits = 0;
  return new Promise((resolve) => {
    server = createServer((req, res) => { hits++; handler!(req, res); });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      resolve();
    });
  });
}

describe('safeFetch redirect handling', () => {
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('follows a single redirect', async () => {
    await listen((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { Location: '/end' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('landed');
    });
    const { result } = await safeFetchDetailed(`${baseUrl}/start`, { skipSsrf: true });
    assert.equal(result?.status, 200);
    assert.equal(result?.body, 'landed');
  });

  it('terminates a redirect loop with TOO_MANY_REDIRECTS', async () => {
    await listen((req, res) => {
      res.writeHead(302, { Location: req.url === '/a' ? '/b' : '/a' }); res.end();
    });
    const { result, error } = await safeFetchDetailed(`${baseUrl}/a`, { skipSsrf: true });
    assert.equal(result, null);
    assert.equal(error?.code, 'TOO_MANY_REDIRECTS');
    assert.equal(hits, MAX_REDIRECTS + 1, 'initial request plus MAX_REDIRECTS follows, then stop');
  });

  it('checks every hop of a chain, not just the first', async () => {
    // skipSsrf lifts the range check for loopback test servers, but the
    // scheme check still runs per hop — a mid-chain file: URL must stop it.
    await listen((req, res) => {
      if (req.url === '/1') { res.writeHead(302, { Location: '/2' }); res.end(); return; }
      res.writeHead(302, { Location: 'file:///etc/passwd' }); res.end();
    });
    const { result, error } = await safeFetchDetailed(`${baseUrl}/1`, { skipSsrf: true });
    assert.equal(result, null);
    assert.equal(error?.kind, 'ssrf');
    assert.match(error!.message, /Non-HTTP scheme: file:/);
    assert.equal(hits, 2, 'both loopback hops were requested before the file: hop was refused');
  });

  it('settles a redirect on headers without draining a slow body', async () => {
    await listen((req, res) => {
      if (req.url === '/ok') { res.writeHead(200); res.end('ok'); return; }
      res.writeHead(302, { Location: '/ok', 'Content-Length': '10000000' });
      res.write('x'); // then never finish
    });
    const started = Date.now();
    const { result } = await safeFetchDetailed(`${baseUrl}/slow`, { skipSsrf: true, timeout: 3000 });
    assert.equal(result?.body, 'ok');
    assert.ok(Date.now() - started < 1500, 'must not wait on the redirect body');
  });

  it('settles HEAD on headers without draining a slow body', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'Content-Length': '10000000' });
      res.flushHeaders(); // a HEAD response ignores write(), so push headers explicitly
    });
    const started = Date.now();
    const { result } = await safeFetchDetailed(`${baseUrl}/`, { skipSsrf: true, method: 'HEAD', timeout: 3000 });
    assert.equal(result?.status, 200);
    assert.ok(Date.now() - started < 1500);
  });
});

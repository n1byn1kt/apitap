// test/net/transport.test.ts — pinnedFetch must behave like the fetch() it replaced.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { pinnedFetch, SsrfBlockedError } from '../../src/net/transport.js';

let server: Server | undefined;
let base = '';
let seen: { method?: string; headers: IncomingMessage['headers']; body: string }[] = [];

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  seen = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ method: req.method, headers: req.headers, body }); handler(req, res); });
    });
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`; resolve(); });
  });
}

describe('pinnedFetch', () => {
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('sends method, headers and a string body with content-length', async () => {
    await listen((_q, s) => { s.writeHead(201, { 'content-type': 'application/json' }); s.end('{"id":7}'); });
    const res = await pinnedFetch(`${base}/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api': 'k' }, body: '{"a":1}', skipSsrf: true,
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 7 });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, '{"a":1}');
    assert.equal(seen[0].headers['content-length'], '7');
    assert.equal(seen[0].headers['content-type'], 'application/json', 'caller content-type wins, not duplicated');
    assert.equal(seen[0].headers['x-api'], 'k');
  });

  it('ignores caller framing headers (stale content-length, host)', async () => {
    await listen((_q, s) => s.end('ok'));
    const res = await pinnedFetch(base, {
      method: 'POST',
      headers: { 'Content-Length': '2', 'Host': 'evil.example', 'Transfer-Encoding': 'chunked' },
      body: '{"id":"999"}',
      skipSsrf: true,
    });
    assert.equal(await res.text(), 'ok');
    assert.equal(seen[0].body, '{"id":"999"}');
    assert.equal(seen[0].headers['content-length'], '12');
    assert.match(seen[0].headers['host'] ?? '', /^127\.0\.0\.1:/);
  });

  it('sends no body and no content-length on a bodyless request despite a captured length', async () => {
    await listen((_q, s) => s.end('ok'));
    const res = await pinnedFetch(base, { headers: { 'content-length': '2' }, skipSsrf: true, signal: AbortSignal.timeout(2000) });
    assert.equal(await res.text(), 'ok');
    assert.equal(seen[0].headers['content-length'], undefined);
  });

  it("adds fetch's default headers only when absent", async () => {
    await listen((_q, s) => s.end('ok'));
    await pinnedFetch(base, { headers: { 'User-Agent': 'custom/1' }, body: 'x', method: 'POST', skipSsrf: true });
    const h = seen[0].headers;
    assert.equal(h['user-agent'], 'custom/1');
    assert.equal(h['accept'], '*/*');
    assert.equal(h['content-type'], 'text/plain;charset=UTF-8');
  });

  it('decodes gzip and keeps multiple set-cookie values', async () => {
    await listen((_q, s) => {
      s.writeHead(200, { 'content-encoding': 'gzip', 'set-cookie': ['a=1', 'b=2'] });
      s.end(gzipSync('zipped'));
    });
    const res = await pinnedFetch(base, { skipSsrf: true });
    assert.equal(await res.text(), 'zipped');
    assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
  });

  it('does not follow redirects', async () => {
    await listen((_q, s) => { s.writeHead(302, { location: '/elsewhere' }); s.end('moved'); });
    const res = await pinnedFetch(base, { skipSsrf: true });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/elsewhere');
    await res.body?.cancel();
    assert.equal(seen.length, 1);
  });

  it('returns a null body for 204 and HEAD', async () => {
    await listen((q, s) => { s.writeHead(q.method === 'HEAD' ? 200 : 204); s.end(); });
    assert.equal((await pinnedFetch(base, { skipSsrf: true })).body, null);
    assert.equal((await pinnedFetch(base, { method: 'HEAD', skipSsrf: true })).body, null);
  });

  it('honours an abort signal', async () => {
    await listen(() => { /* never respond */ });
    await assert.rejects(pinnedFetch(base, { skipSsrf: true, signal: AbortSignal.timeout(200) }), /abort|timeout/i);
  });

  it('blocks private literals and non-http schemes before connecting', async () => {
    await assert.rejects(pinnedFetch('http://127.0.0.1/'), SsrfBlockedError);
    await assert.rejects(pinnedFetch('http://[::7f00:1]/'), SsrfBlockedError);
    await assert.rejects(pinnedFetch('file:///etc/passwd', { skipSsrf: true }), SsrfBlockedError);
  });
});

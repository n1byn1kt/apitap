// test/net/fetch-following.test.ts
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fetchFollowing, transport, pinnedFetch, SsrfBlockedError, MAX_FOLLOW_REDIRECTS } from '../../src/net/transport.js';

const dns = createRequire(import.meta.url)('node:dns') as typeof import('node:dns');
const realLookup = dns.lookup;

let servers: Server[] = [];
type Seen = { host: string; url?: string; method?: string; headers: IncomingMessage['headers']; body: string };
let seen: Seen[] = [];

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ host, url: req.url, method: req.method, headers: req.headers, body });
        handler(req, res);
      });
    });
    servers.push(s);
    s.listen(0, host, () => resolve(`http://${host}:${(s.address() as { port: number }).port}`));
  });
}

describe('fetchFollowing', () => {
  afterEach(async () => {
    transport.fetch = pinnedFetch;
    (dns as any).lookup = realLookup;
    syncBuiltinESMExports();
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
    seen = [];
  });

  it('follows a same-origin redirect and keeps credentials', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end(); return; }
      res.end('landed');
    });
    const res = await fetchFollowing(`${base}/start`, { headers: { Authorization: 'Bearer T' }, skipSsrf: true });
    assert.equal(await res.text(), 'landed');
    assert.equal(seen[1].headers.authorization, 'Bearer T');
  });

  it('drops Authorization and Cookie when a redirect changes origin', async () => {
    // 127.0.0.2 is loopback on Linux but a different origin from 127.0.0.1.
    const other = await listen((_q, res) => res.end('other'), '127.0.0.2');
    const base = await listen((_q, res) => { res.writeHead(302, { location: `${other}/spec` }); res.end(); });
    const res = await fetchFollowing(`${base}/`, {
      headers: { Authorization: 'Bearer GH-TOKEN', Cookie: 's=1', 'User-Agent': 'x' },
      skipSsrf: true,
    });
    assert.equal(await res.text(), 'other');
    const hop = seen.find((s) => s.host === '127.0.0.2')!;
    assert.equal(hop.headers.authorization, undefined);
    assert.equal(hop.headers.cookie, undefined);
    assert.equal(hop.headers['user-agent'], 'x');
  });

  it('turns a 303 after POST into a bodyless GET', async () => {
    const base = await listen((req, res) => {
      if (req.method === 'POST') { res.writeHead(303, { location: '/done' }); res.end(); return; }
      res.end('ok');
    });
    await fetchFollowing(`${base}/`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'text/plain' }, skipSsrf: true });
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[1].body, '');
    assert.equal(seen[1].headers['content-type'], undefined);
  });

  it('stops after MAX_FOLLOW_REDIRECTS', async () => {
    const base = await listen((req, res) => { res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' }); res.end(); });
    await assert.rejects(fetchFollowing(`${base}/a`, { skipSsrf: true }), /more than 5 redirects/);
    assert.equal(seen.length, MAX_FOLLOW_REDIRECTS + 1);
  });

  it('sends every hop back through the SSRF checks', async () => {
    // First hop: a public-looking redirect. Second hop must hit the real
    // pinnedFetch checks and be refused before connecting.
    const calls: string[] = [];
    transport.fetch = async (url, init) => {
      calls.push(url);
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      return pinnedFetch(url, init);
    };
    await assert.rejects(fetchFollowing('https://specs.example.com/openapi.json'), SsrfBlockedError);
    assert.deepEqual(calls, ['https://specs.example.com/openapi.json', 'http://169.254.169.254/latest/meta-data/']);
  });

  it('re-checks a redirect hostname at connect time (hop 2 resolves internal)', async () => {
    const internal = await listen((_q, res) => res.end('internal'));
    const port = new URL(internal).port;
    (dns as any).lookup = (_h: string, opts: any, cb: any) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (opts?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
      else cb(null, '127.0.0.1', 4);
    };
    syncBuiltinESMExports();
    transport.fetch = async (url, init) => {
      if (url.startsWith('https://specs.example.com/')) {
        return new Response(null, { status: 302, headers: { location: `http://internal.example.org:${port}/admin` } });
      }
      return pinnedFetch(url, init);
    };
    await assert.rejects(fetchFollowing('https://specs.example.com/openapi.json'), /internal\.example\.org resolves to 127\.0\.0\.1/);
    assert.equal(seen.length, 0);
  });

  it('does not follow 300/305 (returned as-is, like fetch)', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/') { res.writeHead(305, { location: '/proxy' }); res.end(); return; }
      res.end('followed');
    });
    const res = await fetchFollowing(`${base}/`, { skipSsrf: true });
    assert.equal(res.status, 305);
    await res.body?.cancel();
    assert.equal(seen.length, 1);
  });

  it('refuses a Location with userinfo, even same-origin', async () => {
    const base = await listen((_q, res) => {
      const u = new URL(base); u.username = 'user'; u.password = 'pw'; u.pathname = '/x';
      res.writeHead(302, { location: u.toString() }); res.end();
    });
    await assert.rejects(fetchFollowing(`${base}/`, { headers: { Authorization: 'Bearer T' }, skipSsrf: true }), /credentials refused/);
    assert.equal(seen.length, 1);
  });

  it('treats a scheme or port change as cross-origin', async () => {
    const other = await listen((_q, res) => res.end('other'));
    const base = await listen((_q, res) => { res.writeHead(307, { location: `${other}/` }); res.end(); });
    await fetchFollowing(`${base}/`, { headers: { Authorization: 'Bearer T' }, skipSsrf: true });
    assert.equal(seen[1].headers.authorization, undefined, 'same host, different port = different origin');
  });

  it('301 after PUT keeps method and body; body headers dropped only when switching to GET', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/a') { res.writeHead(301, { location: '/b' }); res.end(); return; }
      res.end('ok');
    });
    await fetchFollowing(`${base}/a`, { method: 'PUT', body: '{"a":1}', headers: { 'content-type': 'application/json', 'content-encoding': 'identity' }, skipSsrf: true });
    assert.equal(seen[1].method, 'PUT');
    assert.equal(seen[1].body, '{"a":1}');
    await fetchFollowing(`${base}/a`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json', 'content-encoding': 'identity' }, skipSsrf: true });
    assert.equal(seen[3].method, 'GET');
    assert.equal(seen[3].headers['content-type'], undefined);
    assert.equal(seen[3].headers['content-encoding'], undefined);
  });

  it('follows a redirect whose (discarded) body is not valid gzip', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/next', 'content-encoding': 'gzip' }); res.end('not-gzip'); return; }
      res.end('next-ok');
    });
    const res = await fetchFollowing(`${base}/start`, { skipSsrf: true });
    assert.equal(await res.text(), 'next-ok');
  });
});

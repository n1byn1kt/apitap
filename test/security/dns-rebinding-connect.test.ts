// test/security/dns-rebinding-connect.test.ts
// The SSRF range check must run on the address the socket actually connects
// to. A pre-check followed by fetch(hostname) re-resolves, so a TTL-0 rebind
// (public on check, loopback on connect) used to get through.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:http';
import { safeFetchDetailed, validatingLookup } from '../../src/discovery/fetch.js';

const require = createRequire(import.meta.url);
const dns = require('node:dns') as typeof import('node:dns');
const realLookup = dns.lookup;
const realPromisesLookup = dns.promises.lookup;

type Answer = { address: string; family: number }[];
function stubLookup(answers: (host: string, call: number) => Answer): { calls: () => number } {
  let n = 0;
  (dns as any).lookup = (host: string, opts: any, cb: any) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const list = answers(host, n++);
    if (opts?.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  };
  syncBuiltinESMExports();
  return { calls: () => n };
}

let server: Server;
let port = 0;
let hits = 0;

describe('SSRF check at connect time (DNS rebinding)', () => {
  before(() => new Promise<void>((resolve) => {
    server = createServer((_req, res) => { hits++; res.end('internal secret'); });
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  }));
  after(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    (dns as any).lookup = realLookup;
    (dns.promises as any).lookup = realPromisesLookup;
    syncBuiltinESMExports();
    hits = 0;
  });

  it('blocks a rebind: public answer to a pre-check, loopback to the socket', async () => {
    // A resolveAndValidateUrl-style pre-check (dns.promises) sees a public
    // IP; the connection's own lookup (callback dns.lookup) sees loopback.
    // Pre-check-then-fetch code connects to the internal server here.
    (dns.promises as any).lookup = async () => ({ address: '93.184.215.14', family: 4 });
    stubLookup(() => [{ address: '127.0.0.1', family: 4 }]);
    const { result, error } = await safeFetchDetailed(`http://rebind.example.com:${port}/`);
    assert.equal(result, null);
    assert.equal(error?.kind, 'ssrf');
    assert.equal(hits, 0, 'no request may reach the internal server');
  });

  it('blocks a hostname whose connect-time lookup returns loopback', async () => {
    const stub = stubLookup(() => [{ address: '127.0.0.1', family: 4 }]);
    const { result, error } = await safeFetchDetailed(`http://rebind.example.com:${port}/`);
    assert.equal(result, null);
    assert.equal(error?.kind, 'ssrf');
    assert.match(error!.message, /127\.0\.0\.1/);
    assert.equal(hits, 0, 'no request may reach the internal server');
    assert.ok(stub.calls() >= 1, 'the connection lookup must be the one validated');
  });

  it('blocks when any address in a multi-address answer is private', async () => {
    stubLookup(() => [
      { address: '93.184.215.14', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const { result, error } = await safeFetchDetailed(`http://mixed.example.com:${port}/`);
    assert.equal(result, null);
    assert.equal(error?.kind, 'ssrf');
    assert.equal(hits, 0);
  });

  it('blocks IPv4-mapped IPv6 loopback from the resolver', async () => {
    stubLookup(() => [{ address: '::ffff:127.0.0.1', family: 6 }]);
    const { error } = await safeFetchDetailed(`http://mapped.example.com:${port}/`);
    assert.equal(error?.kind, 'ssrf');
    assert.equal(hits, 0);
  });
});

describe('validatingLookup callback shapes', () => {
  afterEach(() => { (dns as any).lookup = realLookup; syncBuiltinESMExports(); });

  it('returns an address array when called with all: true', async () => {
    stubLookup(() => [{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }]);
    const out = await new Promise<unknown>((resolve, reject) =>
      validatingLookup('ok.example.com', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));
    assert.deepEqual(out, [
      { address: '93.184.215.14', family: 4 },
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
    ]);
  });

  it('returns (address, family) when called without all', async () => {
    stubLookup(() => [{ address: '93.184.215.14', family: 4 }]);
    const out = await new Promise<[unknown, unknown]>((resolve, reject) =>
      validatingLookup('ok.example.com', {}, (err, addr, fam) => (err ? reject(err) : resolve([addr, fam]))));
    assert.deepEqual(out, ['93.184.215.14', 4]);
  });
});

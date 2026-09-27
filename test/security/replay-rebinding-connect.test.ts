// test/security/replay-rebinding-connect.test.ts
// Replay and OAuth refresh carry credentials, so a DNS rebind there sends
// auth headers / refresh tokens to an internal host. Each case gives the
// pre-check (dns.promises) a public IP and the socket lookup (dns.lookup)
// loopback — the shape a TTL-0 rebind produces. Pre-check-then-fetch code
// reaches the internal server; the pinned transport must not.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:http';
import { replayEndpoint } from '../../src/replay/engine.js';
import { refreshOAuth } from '../../src/auth/oauth-refresh.js';
import { pinnedFetch, SsrfBlockedError } from '../../src/net/transport.js';
import type { SkillFile } from '../../src/types.js';

const require = createRequire(import.meta.url);
const dns = require('node:dns') as typeof import('node:dns');
const realLookup = dns.lookup;
const realPromisesLookup = dns.promises.lookup;

function rebind(): void {
  (dns.promises as any).lookup = async (_h: string, opts?: any) =>
    opts?.all ? [{ address: '93.184.215.14', family: 4 }] : { address: '93.184.215.14', family: 4 };
  (dns as any).lookup = (_h: string, opts: any, cb: any) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  };
  syncBuiltinESMExports();
}

let server: Server;
let port = 0;
let hits: { url?: string; auth?: string; body: string }[] = [];

function skillFor(host: string): SkillFile {
  const baseUrl = `http://${host}:${port}`;
  return {
    version: '1.1',
    domain: host,
    baseUrl,
    capturedAt: '2026-09-27T00:00:00.000Z',
    endpoints: [{
      id: 'get-data',
      method: 'GET',
      path: '/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: `${baseUrl}/data`, headers: {} }, responsePreview: null },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'unsigned',
  } as SkillFile;
}

describe('pinned transport blocks DNS rebinding on credential-carrying paths', () => {
  before(() => new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits.push({ url: req.url, auth: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"access_token":"stolen","ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  }));
  after(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    (dns as any).lookup = realLookup;
    (dns.promises as any).lookup = realPromisesLookup;
    syncBuiltinESMExports();
    hits = [];
  });

  it('pinnedFetch refuses to connect', async () => {
    rebind();
    await assert.rejects(pinnedFetch(`http://rebind.example.com:${port}/`), (err: Error) =>
      err instanceof SsrfBlockedError && /resolves to 127\.0\.0\.1/.test(err.message));
    assert.equal(hits.length, 0);
  });

  it('replayEndpoint never sends the stored credential to the internal host', async () => {
    rebind();
    const stored = { type: 'bearer', header: 'authorization', value: 'Bearer SECRET-TOKEN' };
    const authManager = {
      retrieve: async () => stored,
      retrieveWithFallback: async () => stored,
      retrieveTokens: async () => null,
    } as any;
    // The pre-check sees the public answer and passes; only the connect-time
    // lookup can produce this message.
    await assert.rejects(
      replayEndpoint(skillFor('rebind.example.com'), 'get-data', { authManager, domain: 'rebind.example.com' }),
      /SSRF blocked: rebind\.example\.com resolves to 127\.0\.0\.1/,
    );
    assert.equal(hits.length, 0, `internal server was hit: ${JSON.stringify(hits)}`);
  });

  it('refreshOAuth never posts the refresh token to the internal host', async () => {
    rebind();
    const result = await refreshOAuth(
      'rebind.example.com',
      { tokenEndpoint: `http://rebind.example.com:${port}/token`, grantType: 'refresh_token', clientId: 'c1' },
      {
        retrieveOAuthCredentials: async () => ({ refreshToken: 'rt_SECRET', clientSecret: 'cs_SECRET' }),
        retrieve: async () => null,
        store: async () => {},
        storeOAuthCredentials: async () => {},
      } as any,
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Token endpoint blocked: rebind\.example\.com resolves to 127\.0\.0\.1/);
    assert.equal(hits.length, 0, `internal server was hit: ${JSON.stringify(hits)}`);
  });
});

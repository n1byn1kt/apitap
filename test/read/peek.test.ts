// test/read/peek.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { peek } from '../../src/read/peek.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

let server: Server;
let baseUrl: string;
let responseHeaders: Record<string, string>;
let responseStatus: number;

function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(responseStatus, responseHeaders);
      res.end(req.method === 'HEAD' ? '' : 'ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function teardownServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

describe('peek', () => {
  beforeEach(async () => {
    responseHeaders = { 'Content-Type': 'text/html' };
    responseStatus = 200;
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  it('clean 200 returns accessible=true, recommendation=read', async () => {
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.status, 200);
    assert.equal(result.accessible, true);
    assert.equal(result.recommendation, 'read');
    assert.equal(result.botProtection, null);
    assert.equal(result.framework, null);
  });

  it('403 returns blocked', async () => {
    responseStatus = 403;
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.status, 403);
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
  });

  it('429 returns blocked', async () => {
    responseStatus = 429;
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.status, 429);
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
  });

  it('401 returns auth_required', async () => {
    responseStatus = 401;
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.status, 401);
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'auth_required');
  });

  it('cloudflare CDN alone (cf-ray, 200) is NOT bot protection and stays readable', async () => {
    responseHeaders['cf-ray'] = '12345-IAD';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, null);
    assert.equal(result.accessible, true);
    assert.equal(result.recommendation, 'read');
    assert.ok(result.signals.some(s => s.includes('cloudflare CDN')));
  });

  it('cloudflare bot management cookie (__cf_bm) detected as botProtection=cloudflare', async () => {
    responseHeaders['cf-ray'] = '12345-IAD';
    responseHeaders['set-cookie'] = '__cf_bm=abc123; path=/; HttpOnly';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'cloudflare');
  });

  it('bot protection on a 200 reports the vendor but stays accessible with a warning', async () => {
    responseHeaders['x-px-captcha'] = '1';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'perimeterx');
    assert.equal(result.accessible, true);
    assert.equal(result.recommendation, 'read');
    assert.ok(result.signals.some(s => s.includes('deeper paths may challenge')));
  });

  it('bot protection on a 403 is blocked', async () => {
    responseStatus = 403;
    responseHeaders['x-px-captcha'] = '1';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'perimeterx');
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
  });

  it('datadome x-datadome header detected as botProtection=datadome', async () => {
    responseStatus = 403;
    responseHeaders['x-datadome'] = 'protected';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'datadome');
    assert.equal(result.recommendation, 'blocked');
  });

  it('akamai bot manager cookie (_abck) detected as botProtection=akamai', async () => {
    responseHeaders['set-cookie'] = '_abck=xyz~0~-1; path=/; ak_bmsc=abc';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'akamai');
  });

  it('perimeterx _px3 cookie detected as botProtection=perimeterx', async () => {
    responseHeaders['set-cookie'] = '_px3=deadbeef; path=/';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'perimeterx');
  });

  it('kasada x-kpsdk-ct header detected as botProtection=kasada', async () => {
    responseHeaders['x-kpsdk-ct'] = 'token';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'kasada');
  });

  it('imperva visid_incap cookie detected as botProtection=imperva', async () => {
    responseHeaders['set-cookie'] = 'visid_incap_123=abc; path=/';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'imperva');
  });

  it('next.js x-powered-by detected as framework=next.js, recommendation=read', async () => {
    responseHeaders['x-powered-by'] = 'Next.js';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.framework, 'next.js');
    assert.equal(result.recommendation, 'read');
    assert.ok(result.signals.some(s => s.includes('Next.js')));
  });

  it('wordpress api.w.org link detected as framework=wordpress', async () => {
    responseHeaders['link'] = '</wp-json/>; rel="https://api.w.org/"';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.framework, 'wordpress');
    assert.ok(result.signals.some(s => s.includes('api.w.org')));
  });

  it('shopify x-shopify-stage detected as framework=shopify', async () => {
    responseHeaders['x-shopify-stage'] = 'production';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.framework, 'shopify');
    assert.ok(result.signals.some(s => s.includes('x-shopify-stage')));
  });

  it('server header captured', async () => {
    responseHeaders['server'] = 'nginx/1.24.0';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.server, 'nginx/1.24.0');
  });

  it('content-type captured', async () => {
    responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.contentType, 'application/json; charset=utf-8');
  });

  it('5xx returns blocked', async () => {
    responseStatus = 502;
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.status, 502);
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
  });

  it('JSON API behind Cloudflare returns accessible=true, not blocked', async () => {
    responseHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'cf-ray': '12345-IAD',
    };
    responseStatus = 200;
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.status, 200);
    assert.equal(result.accessible, true);
    assert.equal(result.recommendation, 'read');
    assert.equal(result.botProtection, null);
  });

  it('HTML 200 behind Cloudflare CDN is readable; a challenged 403 is blocked', async () => {
    responseHeaders = {
      'Content-Type': 'text/html',
      'cf-ray': '12345-IAD',
    };
    responseStatus = 200;
    const ok = await peek(baseUrl, { skipSsrf: true });
    assert.equal(ok.accessible, true);
    assert.equal(ok.recommendation, 'read');
    assert.equal(ok.botProtection, null);

    responseHeaders['cf-mitigated'] = 'challenge';
    responseStatus = 403;
    const challenged = await peek(baseUrl, { skipSsrf: true });
    assert.equal(challenged.accessible, false);
    assert.equal(challenged.recommendation, 'blocked');
    assert.equal(challenged.botProtection, 'cloudflare');
  });

  it('SSRF blocked URL returns blocked with fetch failed signal', async () => {
    // Without skipSsrf, localhost is blocked by SSRF protection
    const result = await peek('http://127.0.0.1:9999');
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
    assert.ok(result.signals.includes('fetch failed'));
  });
});

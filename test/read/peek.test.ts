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

  it('cloudflare cf-ray header detected as botProtection=cloudflare, blocked', async () => {
    responseHeaders['cf-ray'] = '12345-IAD';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'cloudflare');
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
    assert.ok(result.signals.some(s => s.includes('cf-ray')));
  });

  it('cloudflare cf-cache-status header detected as botProtection=cloudflare', async () => {
    responseHeaders['cf-cache-status'] = 'HIT';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'cloudflare');
    assert.ok(result.signals.some(s => s.includes('cf-cache-status')));
  });

  it('perimeterx x-px-* header detected as botProtection=perimeterx, blocked', async () => {
    responseHeaders['x-px-captcha'] = '1';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'perimeterx');
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
    assert.ok(result.signals.some(s => s.includes('x-px-')));
  });

  it('datadome x-datadome header detected as botProtection=datadome, blocked', async () => {
    responseHeaders['x-datadome'] = 'protected';
    const result = await peek(baseUrl, { skipSsrf: true });
    assert.equal(result.botProtection, 'datadome');
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
    assert.ok(result.signals.some(s => s.includes('x-datadome')));
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

  it('SSRF blocked URL returns blocked with fetch failed signal', async () => {
    // Without skipSsrf, localhost is blocked by SSRF protection
    const result = await peek('http://127.0.0.1:9999');
    assert.equal(result.accessible, false);
    assert.equal(result.recommendation, 'blocked');
    assert.ok(result.signals.includes('fetch failed'));
  });
});

// test/discovery/fetch.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch } from '../../src/discovery/fetch.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

let server: Server;
let baseUrl: string;

function setupServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
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

describe('safeFetch', () => {
  afterEach(async () => {
    await teardownServer();
  });

  it('fetches a URL and returns result', async () => {
    await setupServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>Hello</html>');
    });

    const result = await safeFetch(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result!.status, 200);
    assert.ok(result!.body.includes('Hello'));
    assert.ok(result!.contentType.includes('text/html'));
  });

  it('blocks SSRF to localhost', async () => {
    const result = await safeFetch('http://localhost:8080');
    assert.equal(result, null);
  });

  it('blocks SSRF to private IPs', async () => {
    const result = await safeFetch('http://10.0.0.1/api');
    assert.equal(result, null);
  });

  it('blocks non-HTTP schemes', async () => {
    const result = await safeFetch('file:///etc/passwd');
    assert.equal(result, null);
  });

  it('returns null for unreachable URLs', async () => {
    const result = await safeFetch('http://127.0.0.1:59996', { timeout: 1000, skipSsrf: true });
    assert.equal(result, null);
  });

  it('respects timeout', async () => {
    await setupServer((req, res) => {
      // Never respond
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 10000);
    });

    const start = Date.now();
    const result = await safeFetch(baseUrl, { timeout: 500, skipSsrf: true });
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed < 3000, `Took ${elapsed}ms, expected < 3000ms`);
  });

  it('supports HEAD requests', async () => {
    await setupServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Custom': 'test' });
      res.end(req.method === 'HEAD' ? '' : '{"data":true}');
    });

    const result = await safeFetch(baseUrl, { method: 'HEAD', skipSsrf: true });
    assert.ok(result);
    assert.equal(result!.status, 200);
    assert.equal(result!.body, '');
  });

  it('truncates oversized bodies', async () => {
    await setupServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(10000));
    });

    const result = await safeFetch(baseUrl, { maxBodySize: 100, skipSsrf: true });
    assert.ok(result);
    assert.equal(result!.body.length, 100);
  });

  it('lowercases header keys', async () => {
    await setupServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'X-Custom-Header': 'value' });
      res.end('ok');
    });

    const result = await safeFetch(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result!.headers['content-type'], 'text/html');
    assert.equal(result!.headers['x-custom-header'], 'value');
  });

  it('allows 127.0.0.1 when skipSsrf is true', async () => {
    await setupServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    const result = await safeFetch(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result!.status, 200);
  });

  it('blocks 127.0.0.1 when skipSsrf is false', async () => {
    await setupServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    const result = await safeFetch(baseUrl, { skipSsrf: false });
    assert.equal(result, null);
  });
});

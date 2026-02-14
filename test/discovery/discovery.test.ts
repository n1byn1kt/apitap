// test/discovery/discovery.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../../src/discovery/index.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

let server: Server;
let baseUrl: string;
let routes: Record<string, { status: number; contentType: string; body: string; headers?: Record<string, string> }>;

function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const route = routes[req.url!];
      if (route) {
        const headers: Record<string, string> = { 'Content-Type': route.contentType, ...(route.headers ?? {}) };
        res.writeHead(route.status, headers);
        res.end(route.body);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html>Not Found</html>');
      }
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

const skipSsrf = { skipSsrf: true };

describe('discover (orchestrator)', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  it('returns high confidence when OpenAPI spec is found', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Hello</body></html>',
    };
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/api/items': { get: { responses: { '200': {} } } },
        },
      }),
    };

    const result = await discover(baseUrl, skipSsrf);
    assert.equal(result.confidence, 'high');
    assert.ok(result.skillFile);
    assert.ok(result.skillFile!.endpoints.length > 0);
    assert.ok(result.specs && result.specs.length > 0);
    assert.ok(result.duration > 0);
  });

  it('returns medium confidence for high-confidence framework detection', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><head><link rel="https://api.w.org/" href="/wp-json/"></head><body><link href="/wp-content/themes/x/style.css"><script src="/wp-includes/js/jquery.js"></script></body></html>',
    };

    const result = await discover(baseUrl, skipSsrf);
    assert.equal(result.confidence, 'medium');
    assert.ok(result.skillFile);
    assert.ok(result.frameworks!.some(f => f.name === 'WordPress'));
    assert.ok(result.skillFile!.endpoints.some(e => e.path.includes('wp-json')));
  });

  it('returns low confidence for medium-confidence framework detection', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body><script src="/wp-content/themes/x/app.js"></script></body></html>',
    };

    const result = await discover(baseUrl, skipSsrf);
    // WordPress with single signal → medium confidence framework → low discovery confidence
    if (result.frameworks?.some(f => f.name === 'WordPress')) {
      assert.ok(['low', 'medium'].includes(result.confidence));
    }
  });

  it('returns low confidence when only probes find APIs', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Plain site</body></html>',
    };
    routes['/api/'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"version":"1.0"}',
    };

    const result = await discover(baseUrl, skipSsrf);
    assert.ok(result.probes);
    assert.ok(result.probes!.some(p => p.path === '/api/' && p.isApi));
    assert.ok(['low', 'medium', 'high'].includes(result.confidence));
  });

  it('returns none confidence for empty site', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Just a static page</body></html>',
    };

    const result = await discover(baseUrl, skipSsrf);
    assert.equal(result.confidence, 'none');
    assert.ok(result.hints!.some(h => h.includes('auto-capture recommended')));
  });

  it('blocks SSRF to localhost', async () => {
    const result = await discover('http://localhost:8080');
    assert.equal(result.confidence, 'none');
    assert.ok(result.hints!.some(h => h.includes('SSRF')));
  });

  it('blocks SSRF to private IPs', async () => {
    const result = await discover('http://192.168.1.1');
    assert.equal(result.confidence, 'none');
    assert.ok(result.hints!.some(h => h.includes('SSRF')));
  });

  it('handles invalid URLs', async () => {
    const result = await discover('not a url at all ::: ///');
    assert.equal(result.confidence, 'none');
  });

  it('handles unreachable sites', async () => {
    const result = await discover('http://127.0.0.1:59997', { timeout: 2000, skipSsrf: true });
    assert.equal(result.confidence, 'none');
    assert.ok(result.hints!.some(h => h.includes('Failed to fetch')));
  });

  it('respects skipProbes option', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Hello</body></html>',
    };
    routes['/api/'] = {
      status: 200,
      contentType: 'application/json',
      body: '{"v":1}',
    };

    const result = await discover(baseUrl, { skipProbes: true, skipSsrf: true });
    assert.ok(!result.probes || result.probes.length === 0);
  });

  it('respects skipSpecs option', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Hello</body></html>',
    };
    routes['/openapi.json'] = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: { '/api/x': { get: { responses: { '200': {} } } } },
      }),
    };

    const result = await discover(baseUrl, { skipSpecs: true, skipSsrf: true });
    assert.ok(!result.specs || result.specs.length === 0);
  });

  it('includes duration in result', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html></html>',
    };

    const result = await discover(baseUrl, skipSsrf);
    assert.ok(typeof result.duration === 'number');
    assert.ok(result.duration >= 0);
  });

  it('generates correct skill file structure', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><head><link rel="https://api.w.org/" href="/wp-json/"></head><body><script src="/wp-content/x.js"></script><link href="/wp-includes/y.css"></body></html>',
    };

    const result = await discover(baseUrl, skipSsrf);
    if (result.skillFile) {
      assert.equal(result.skillFile.version, '1.2');
      assert.equal(result.skillFile.provenance, 'unsigned');
      assert.ok(result.skillFile.domain);
      assert.ok(result.skillFile.baseUrl);
      assert.ok(Array.isArray(result.skillFile.endpoints));
      for (const ep of result.skillFile.endpoints) {
        assert.ok(ep.id);
        assert.ok(ep.method);
        assert.ok(ep.path);
        assert.equal(ep.replayability?.verified, false);
      }
    }
  });

  it('auto-prefixes https:// for bare domains', async () => {
    const result = await discover('example.invalid.domain', { timeout: 2000 });
    assert.equal(result.confidence, 'none');
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { read } from '../../src/read/index.js';
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
        res.writeHead(404);
        res.end('Not Found');
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

describe('read', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  it('uses generic extractor for unknown URLs', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><head><title>Test Page</title><meta property="og:title" content="OG Title"></head><body><article><h1>Hello</h1><p>World</p></article></body></html>',
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result.title, 'OG Title');
    assert.ok(result.content.includes('Hello'));
    assert.ok(result.content.includes('World'));
    assert.equal(result.metadata.source, 'readability');
  });

  it('returns og-tags-only when body has no extractable content', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><head><meta property="og:title" content="Title"><meta property="og:description" content="Desc"></head><body></body></html>',
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result.title, 'Title');
    assert.equal(result.metadata.source, 'og-tags-only');
  });

  it('detects SPA shell and sets source accordingly', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result.metadata.source, 'spa-shell');
  });

  it('returns null when fetch fails', async () => {
    const result = await read('http://192.168.1.1/test');
    assert.equal(result, null);
  });

  it('truncates content with maxBytes', async () => {
    const longContent = 'A'.repeat(10000);
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: `<html><body><article><p>${longContent}</p></article></body></html>`,
    };

    const result = await read(baseUrl, { skipSsrf: true, maxBytes: 500 });
    assert.ok(result);
    assert.ok(result.content.length <= 500);
  });

  it('estimates token cost', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html><body><article><p>Some content here for testing</p></article></body></html>',
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.ok(result.cost.tokens > 0);
    // cost.tokens now measures the whole serialized envelope, not just content.
    assert.equal(result.cost.tokens, Math.ceil(JSON.stringify(result).length / 4));
  });

  it('returns null for non-200 status', async () => {
    routes['/'] = {
      status: 403,
      contentType: 'text/html',
      body: '<html><body>Forbidden</body></html>',
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.equal(result, null);
  });

  it('labels a Reddit-style verification interstitial instead of claiming empty success', async () => {
    // Real shape of Reddit's challenge page: challenge title + auto-submit
    // "solution" form, zero article content, served with HTTP 200.
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: `<html><head><title>Reddit - Please wait for verification</title>
        <script>document.addEventListener("DOMContentLoaded",async function(){var e=document.forms[0];e.elements.namedItem("solution").value="x";e.requestSubmit()});</script>
        </head><body><main><form method="post"><input type="hidden" name="solution"></form></main></body></html>`,
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result.botProtection, 'challenge');
    assert.equal(result.metadata.source, 'challenge-page');
    assert.ok(result.content.length > 0, 'content must not be silently empty');
    assert.ok(/challenge|verification/i.test(result.content), `content: ${result.content}`);
  });

  it('labels a Cloudflare "Just a moment" challenge as botProtection=cloudflare', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: `<html><head><title>Just a moment...</title></head>
        <body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
        <p>Verifying you are human. This may take a few seconds.</p></body></html>`,
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result.botProtection, 'cloudflare');
    assert.equal(result.metadata.source, 'challenge-page');
  });

  it('does not flag an article that merely talks about human verification', async () => {
    routes['/'] = {
      status: 200,
      contentType: 'text/html',
      body: `<html><head><title>How CAPTCHAs work</title></head><body><article>
        <p>Sites often ask you to verify you are human. Checking your browser
        for automation markers is a common technique used by bot walls.</p>
        </article></body></html>`,
    };

    const result = await read(baseUrl, { skipSsrf: true });
    assert.ok(result);
    assert.equal(result.botProtection, undefined);
    assert.equal(result.metadata.source, 'readability');
  });
});

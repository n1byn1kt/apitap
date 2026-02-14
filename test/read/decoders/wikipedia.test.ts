// test/read/decoders/wikipedia.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { wikipediaDecoder } from '../../../src/read/decoders/wikipedia.js';

let server: Server;
let baseUrl: string;
let routes: Record<string, { status: number; contentType: string; body: string }>;

function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const route = routes[req.url!];
      if (route) {
        res.writeHead(route.status, { 'Content-Type': route.contentType });
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

describe('wikipediaDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('matches English Wikipedia URLs', () => {
      assert.ok(wikipediaDecoder.patterns.some(p => p.test('https://en.wikipedia.org/wiki/TypeScript')));
    });

    it('matches other language Wikipedia URLs', () => {
      assert.ok(wikipediaDecoder.patterns.some(p => p.test('https://de.wikipedia.org/wiki/Berlin')));
      assert.ok(wikipediaDecoder.patterns.some(p => p.test('https://fr.wikipedia.org/wiki/Paris')));
    });

    it('does not match non-Wikipedia URLs', () => {
      assert.ok(!wikipediaDecoder.patterns.some(p => p.test('https://example.com/wiki/page')));
    });
  });

  describe('decoding', () => {
    it('decodes a Wikipedia article', async () => {
      const articleData = {
        title: 'TypeScript',
        extract: 'TypeScript is a free and open-source high-level programming language developed by Microsoft.',
        description: 'Programming language',
        thumbnail: {
          source: 'https://upload.wikimedia.org/thumb/TypeScript.png',
        },
        content_urls: {
          desktop: {
            page: 'https://en.wikipedia.org/wiki/TypeScript',
          },
        },
        timestamp: '2024-01-15T12:00:00Z',
      };

      routes['/api/rest_v1/page/summary/TypeScript'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(articleData),
      };

      const result = await wikipediaDecoder.decode(
        'https://en.wikipedia.org/wiki/TypeScript',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'TypeScript');
      assert.ok(result!.content.includes('high-level programming language'));
      assert.equal(result!.description, 'Programming language');
      assert.equal(result!.metadata.source, 'wikipedia-rest');
      assert.equal(result!.metadata.siteName, 'Wikipedia');
      assert.equal(result!.images.length, 1);
      assert.ok(result!.images[0].src.includes('TypeScript.png'));
    });

    it('returns null on API error', async () => {
      routes['/api/rest_v1/page/summary/Nonexistent_Page'] = {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ type: 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found' }),
      };

      const result = await wikipediaDecoder.decode(
        'https://en.wikipedia.org/wiki/Nonexistent_Page',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('handles articles without thumbnail', async () => {
      const articleData = {
        title: 'Stub Article',
        extract: 'This is a stub article with minimal content.',
        description: null,
        content_urls: {
          desktop: {
            page: 'https://en.wikipedia.org/wiki/Stub_Article',
          },
        },
      };

      routes['/api/rest_v1/page/summary/Stub_Article'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(articleData),
      };

      const result = await wikipediaDecoder.decode(
        'https://en.wikipedia.org/wiki/Stub_Article',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Stub Article');
      assert.equal(result!.images.length, 0);
      assert.ok(result!.content.includes('stub article'));
    });
  });
});

// test/read/decoders/youtube.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { youtubeDecoder } from '../../../src/read/decoders/youtube.js';

let server: Server;
let baseUrl: string;
let routes: Record<string, { status: number; contentType: string; body: string }>;

function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url!;
      const route = routes[url];
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

describe('youtubeDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('matches youtube.com/watch?v= URLs', () => {
      assert.ok(youtubeDecoder.patterns.some(p => p.test('https://www.youtube.com/watch?v=dQw4w9WgXcQ')));
    });

    it('matches youtu.be/ short URLs', () => {
      assert.ok(youtubeDecoder.patterns.some(p => p.test('https://youtu.be/dQw4w9WgXcQ')));
    });

    it('does not match non-youtube URLs', () => {
      assert.ok(!youtubeDecoder.patterns.some(p => p.test('https://vimeo.com/12345')));
    });
  });

  describe('decoding', () => {
    it('decodes oembed response', async () => {
      const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const oembedData = {
        title: 'Rick Astley - Never Gonna Give You Up',
        author_name: 'Rick Astley',
        author_url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        type: 'video',
      };

      const encodedUrl = encodeURIComponent(videoUrl);
      routes[`/embed?url=${encodedUrl}`] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(oembedData),
      };

      const result = await youtubeDecoder.decode(videoUrl, {
        skipSsrf: true,
        _oembedBaseUrl: baseUrl,
      });

      assert.ok(result);
      assert.equal(result!.title, 'Rick Astley - Never Gonna Give You Up');
      assert.equal(result!.author, 'Rick Astley');
      assert.equal(result!.metadata.source, 'youtube-oembed');
      assert.equal(result!.metadata.type, 'video');
      assert.equal(result!.images.length, 1);
      assert.equal(result!.images[0].src, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
      assert.equal(result!.links.length, 1);
      assert.ok(result!.links[0].href.includes('youtube.com/channel'));
    });

    it('returns null on API error', async () => {
      const videoUrl = 'https://www.youtube.com/watch?v=invalid';
      const encodedUrl = encodeURIComponent(videoUrl);
      routes[`/embed?url=${encodedUrl}`] = {
        status: 500,
        contentType: 'text/plain',
        body: 'Internal Server Error',
      };

      const result = await youtubeDecoder.decode(videoUrl, {
        skipSsrf: true,
        _oembedBaseUrl: baseUrl,
      });

      assert.equal(result, null);
    });

    it('returns null on invalid JSON', async () => {
      const videoUrl = 'https://www.youtube.com/watch?v=broken';
      const encodedUrl = encodeURIComponent(videoUrl);
      routes[`/embed?url=${encodedUrl}`] = {
        status: 200,
        contentType: 'application/json',
        body: '<<<not json>>>',
      };

      const result = await youtubeDecoder.decode(videoUrl, {
        skipSsrf: true,
        _oembedBaseUrl: baseUrl,
      });

      assert.equal(result, null);
    });

    it('returns null when response has no title', async () => {
      const videoUrl = 'https://www.youtube.com/watch?v=notitle';
      const encodedUrl = encodeURIComponent(videoUrl);
      routes[`/embed?url=${encodedUrl}`] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not found' }),
      };

      const result = await youtubeDecoder.decode(videoUrl, {
        skipSsrf: true,
        _oembedBaseUrl: baseUrl,
      });

      assert.equal(result, null);
    });
  });
});

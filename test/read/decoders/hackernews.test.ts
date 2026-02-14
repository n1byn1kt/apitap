// test/read/decoders/hackernews.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { hackernewsDecoder } from '../../../src/read/decoders/hackernews.js';

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

describe('hackernewsDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('matches item URLs', () => {
      assert.ok(hackernewsDecoder.patterns.some(p => p.test('https://news.ycombinator.com/item?id=12345')));
    });

    it('matches front page URL', () => {
      assert.ok(hackernewsDecoder.patterns.some(p => p.test('https://news.ycombinator.com/')));
      assert.ok(hackernewsDecoder.patterns.some(p => p.test('https://news.ycombinator.com')));
    });

    it('does not match non-HN URLs', () => {
      assert.ok(!hackernewsDecoder.patterns.some(p => p.test('https://example.com/item?id=123')));
    });
  });

  describe('decoding', () => {
    it('decodes a story with comments', async () => {
      const story = {
        id: 12345,
        title: 'Show HN: ApiTap',
        by: 'testuser',
        score: 150,
        url: 'https://github.com/example/apitap',
        text: '',
        type: 'story',
        time: 1700000000,
        kids: [100, 101],
        descendants: 25,
      };

      const comment1 = {
        id: 100,
        by: 'commenter1',
        text: 'This looks amazing!',
        type: 'comment',
        time: 1700001000,
      };

      const comment2 = {
        id: 101,
        by: 'commenter2',
        text: 'How does it compare to alternatives?',
        type: 'comment',
        time: 1700002000,
      };

      routes['/v0/item/12345.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(story),
      };
      routes['/v0/item/100.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(comment1),
      };
      routes['/v0/item/101.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(comment2),
      };

      const result = await hackernewsDecoder.decode(
        'https://news.ycombinator.com/item?id=12345',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Show HN: ApiTap');
      assert.equal(result!.author, 'testuser');
      assert.ok(result!.content.includes('150'));
      assert.ok(result!.content.includes('This looks amazing!'));
      assert.ok(result!.content.includes('How does it compare'));
      assert.equal(result!.metadata.source, 'hackernews-firebase');
      assert.equal(result!.metadata.siteName, 'Hacker News');
      assert.equal(result!.links.length, 1);
      assert.equal(result!.links[0].href, 'https://github.com/example/apitap');
    });

    it('decodes front page with top stories', async () => {
      const topStories = [1001, 1002, 1003];

      const story1 = {
        id: 1001,
        title: 'Story One',
        by: 'author1',
        score: 200,
        url: 'https://example.com/1',
        type: 'story',
        descendants: 50,
      };
      const story2 = {
        id: 1002,
        title: 'Story Two',
        by: 'author2',
        score: 150,
        url: 'https://example.com/2',
        type: 'story',
        descendants: 30,
      };
      const story3 = {
        id: 1003,
        title: 'Story Three',
        by: 'author3',
        score: 100,
        type: 'story',
        descendants: 10,
      };

      routes['/v0/topstories.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(topStories),
      };
      routes['/v0/item/1001.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(story1),
      };
      routes['/v0/item/1002.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(story2),
      };
      routes['/v0/item/1003.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(story3),
      };

      const result = await hackernewsDecoder.decode(
        'https://news.ycombinator.com/',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Hacker News — Top Stories');
      assert.ok(result!.content.includes('Story One'));
      assert.ok(result!.content.includes('Story Two'));
      assert.ok(result!.content.includes('Story Three'));
      assert.equal(result!.metadata.source, 'hackernews-firebase');
      assert.equal(result!.metadata.type, 'listing');
      // story3 has no url, so only 2 links
      assert.equal(result!.links.length, 2);
    });

    it('returns null on API error for item', async () => {
      routes['/v0/item/99999.json'] = {
        status: 500,
        contentType: 'text/plain',
        body: 'Internal Server Error',
      };

      const result = await hackernewsDecoder.decode(
        'https://news.ycombinator.com/item?id=99999',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('returns null on API error for front page', async () => {
      routes['/v0/topstories.json'] = {
        status: 500,
        contentType: 'text/plain',
        body: 'Internal Server Error',
      };

      const result = await hackernewsDecoder.decode(
        'https://news.ycombinator.com/',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });
  });
});

// test/read/decoders/reddit.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { redditDecoder } from '../../../src/read/decoders/reddit.js';

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

describe('redditDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('matches post URLs', () => {
      assert.ok(redditDecoder.patterns.some(p => p.test('https://www.reddit.com/r/programming/comments/abc123/some_post/')));
    });

    it('matches subreddit URLs', () => {
      assert.ok(redditDecoder.patterns.some(p => p.test('https://www.reddit.com/r/programming')));
    });

    it('matches user URLs', () => {
      assert.ok(redditDecoder.patterns.some(p => p.test('https://www.reddit.com/user/spez')));
    });

    it('does not match non-reddit URLs', () => {
      assert.ok(!redditDecoder.patterns.some(p => p.test('https://example.com/page')));
    });
  });

  describe('decoding', () => {
    it('decodes a post page (array response)', async () => {
      const postData = [
        {
          data: {
            children: [{
              data: {
                title: 'Test Post Title',
                author: 'testuser',
                selftext: 'This is the post body',
                score: 42,
                subreddit: 'programming',
                permalink: '/r/programming/comments/abc/test_post/',
                created_utc: 1700000000,
              },
            }],
          },
        },
        {
          data: {
            children: [
              {
                kind: 't1',
                data: {
                  author: 'commenter1',
                  body: 'Great post!',
                  score: 10,
                },
              },
              {
                kind: 't1',
                data: {
                  author: 'commenter2',
                  body: 'I disagree',
                  score: 5,
                },
              },
            ],
          },
        },
      ];

      routes['/r/programming/comments/abc/test_post.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(postData),
      };

      const result = await redditDecoder.decode(
        `${baseUrl}/r/programming/comments/abc/test_post`,
        { skipSsrf: true },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Test Post Title');
      assert.equal(result!.author, 'testuser');
      assert.ok(result!.content.includes('This is the post body'));
      assert.ok(result!.content.includes('Great post!'));
      assert.equal(result!.metadata.source, 'reddit-json');
      assert.equal(result!.metadata.siteName, 'Reddit');
    });

    it('decodes a subreddit listing', async () => {
      const listingData = {
        data: {
          children: [
            { data: { title: 'Post 1', author: 'user1', score: 100, num_comments: 50, permalink: '/r/test/comments/1/', subreddit: 'test' } },
            { data: { title: 'Post 2', author: 'user2', score: 80, num_comments: 30, permalink: '/r/test/comments/2/', subreddit: 'test' } },
          ],
        },
      };

      routes['/r/test.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(listingData),
      };

      const result = await redditDecoder.decode(
        `${baseUrl}/r/test`,
        { skipSsrf: true },
      );

      assert.ok(result);
      assert.equal(result!.title, 'r/test');
      assert.ok(result!.content.includes('Post 1'));
      assert.ok(result!.content.includes('Post 2'));
      assert.equal(result!.metadata.source, 'reddit-json');
      assert.equal(result!.metadata.type, 'listing');
    });

    it('returns null on API error', async () => {
      routes['/r/nonexistent.json'] = {
        status: 500,
        contentType: 'text/plain',
        body: 'Server Error',
      };

      const result = await redditDecoder.decode(
        `${baseUrl}/r/nonexistent`,
        { skipSsrf: true },
      );

      assert.equal(result, null);
    });

    it('returns null on invalid JSON', async () => {
      routes['/r/broken.json'] = {
        status: 200,
        contentType: 'application/json',
        body: 'not valid json{{{',
      };

      const result = await redditDecoder.decode(
        `${baseUrl}/r/broken`,
        { skipSsrf: true },
      );

      assert.equal(result, null);
    });
  });
});

// test/read/decoders/twitter.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { twitterDecoder } from '../../../src/read/decoders/twitter.js';

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

// Realistic fxtwitter API response for a regular tweet
const MOCK_TWEET = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/elonmusk/status/123456789',
    id: '123456789',
    text: 'The future is here',
    raw_text: { text: 'The future is here', facets: [] },
    author: {
      id: '44196397',
      name: 'Elon Musk',
      screen_name: 'elonmusk',
      description: 'Mars & Cars, Chips & Dips',
      followers: 200000000,
      following: 800,
      likes: 50000,
      tweets: 35000,
      website: { url: 'https://tesla.com', display_url: 'tesla.com' },
    },
    replies: 5000,
    retweets: 10000,
    likes: 100000,
    bookmarks: 5000,
    views: 50000000,
    created_at: 'Thu Feb 12 09:00:00 +0000 2026',
    source: 'Twitter Web App',
  },
};

// Tweet with embedded article (X Articles / long-form)
const MOCK_ARTICLE_TWEET = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/writer/status/987654321',
    id: '987654321',
    text: '',
    raw_text: { text: 'https://t.co/abc123', facets: [] },
    author: {
      id: '999',
      name: 'Tech Writer',
      screen_name: 'writer',
      description: 'Writing about tech',
      followers: 5000,
    },
    replies: 10,
    retweets: 5,
    likes: 100,
    bookmarks: 50,
    views: 10000,
    created_at: 'Thu Feb 12 10:00:00 +0000 2026',
    article: {
      title: 'Why AI Agents Need Principles',
      preview_text: 'Most agents optimize for the wrong thing.',
      content: {
        blocks: [
          { key: '1', type: 'unstyled', text: 'Most agents optimize for the wrong thing.' },
          { key: '2', type: 'header-two', text: 'The Problem' },
          { key: '3', type: 'unstyled', text: 'They complete tasks but stand for nothing.' },
          { key: '4', type: 'unordered-list-item', text: 'No identity layer' },
          { key: '5', type: 'unordered-list-item', text: 'No decision heuristics' },
          { key: '6', type: 'blockquote', text: 'Give your agent something to believe in.' },
          { key: '7', type: 'header-one', text: 'The Solution' },
          { key: '8', type: 'unstyled', text: 'Three files: SOUL.md, PRINCIPLES.md, AGENTS.md' },
        ],
      },
      cover_media: {
        media_info: {
          original_img_url: 'https://pbs.twimg.com/media/cover.jpg',
        },
      },
    },
  },
};

// Tweet with quote tweet
const MOCK_QUOTE_TWEET = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/user1/status/111222333',
    id: '111222333',
    text: 'This is so true',
    raw_text: { text: 'This is so true', facets: [] },
    author: {
      id: '100',
      name: 'User One',
      screen_name: 'user1',
      followers: 500,
    },
    likes: 20,
    retweets: 3,
    views: 1000,
    created_at: 'Thu Feb 12 11:00:00 +0000 2026',
    quote: {
      text: 'Original thought that was quoted',
      author: {
        name: 'Original Poster',
        screen_name: 'op',
      },
    },
  },
};

// Tweet with photos
const MOCK_PHOTO_TWEET = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/photog/status/444555666',
    id: '444555666',
    text: 'Check out this view',
    raw_text: { text: 'Check out this view', facets: [] },
    author: {
      id: '200',
      name: 'Photographer',
      screen_name: 'photog',
      followers: 10000,
    },
    likes: 500,
    views: 5000,
    created_at: 'Thu Feb 12 12:00:00 +0000 2026',
    media: {
      photos: [
        { url: 'https://pbs.twimg.com/media/photo1.jpg' },
        { url: 'https://pbs.twimg.com/media/photo2.jpg' },
      ],
    },
  },
};

describe('twitterDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('matches x.com status URLs', () => {
      assert.ok(twitterDecoder.patterns.some(p => p.test('https://x.com/elonmusk/status/123456789')));
    });

    it('matches twitter.com status URLs', () => {
      assert.ok(twitterDecoder.patterns.some(p => p.test('https://twitter.com/elonmusk/status/123456789')));
    });

    it('matches x.com status URLs with query params', () => {
      assert.ok(twitterDecoder.patterns.some(p => p.test('https://x.com/user/status/123?s=12')));
    });

    it('matches profile URLs', () => {
      assert.ok(twitterDecoder.patterns.some(p => p.test('https://x.com/elonmusk')));
    });

    it('matches twitter.com profile URLs', () => {
      assert.ok(twitterDecoder.patterns.some(p => p.test('https://twitter.com/elonmusk')));
    });

    it('does not match non-twitter URLs', () => {
      assert.ok(!twitterDecoder.patterns.some(p => p.test('https://reddit.com/r/technology')));
    });

    it('does not match mastodon URLs', () => {
      assert.ok(!twitterDecoder.patterns.some(p => p.test('https://mastodon.social/@user/123')));
    });
  });

  describe('tweet decoding', () => {
    it('decodes a regular tweet with engagement metrics', async () => {
      routes['/elonmusk/status/123456789'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/elonmusk/status/123456789',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.ok(result!.content.includes('Elon Musk'));
      assert.ok(result!.content.includes('@elonmusk'));
      assert.ok(result!.content.includes('The future is here'));
      assert.ok(result!.content.includes('100,000 likes'));
      assert.ok(result!.content.includes('50,000,000 views'));
      assert.equal(result!.author, 'Elon Musk');
      assert.equal(result!.metadata.source, 'twitter-fxtwitter');
      assert.equal(result!.metadata.siteName, 'X (Twitter)');
      assert.equal(result!.links.length, 1);
      assert.equal(result!.links[0].href, 'https://tesla.com');
    });

    it('decodes a tweet with embedded article', async () => {
      routes['/writer/status/987654321'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_ARTICLE_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/writer/status/987654321',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Why AI Agents Need Principles');
      assert.equal(result!.metadata.type, 'article');
      assert.ok(result!.content.includes('Most agents optimize for the wrong thing.'));
      assert.ok(result!.content.includes('## The Problem'));
      assert.ok(result!.content.includes('# The Solution'));
      assert.ok(result!.content.includes('• No identity layer'));
      assert.ok(result!.content.includes('> Give your agent something to believe in.'));
      assert.ok(result!.content.includes('Three files: SOUL.md, PRINCIPLES.md, AGENTS.md'));
      // Cover image
      assert.equal(result!.images.length, 1);
      assert.equal(result!.images[0].src, 'https://pbs.twimg.com/media/cover.jpg');
    });

    it('decodes a tweet with quote tweet', async () => {
      routes['/user1/status/111222333'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_QUOTE_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/user1/status/111222333',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.ok(result!.content.includes('This is so true'));
      assert.ok(result!.content.includes('Quoting Original Poster (@op)'));
      assert.ok(result!.content.includes('Original thought that was quoted'));
    });

    it('decodes a tweet with photos', async () => {
      routes['/photog/status/444555666'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PHOTO_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/photog/status/444555666',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.images.length, 2);
      assert.equal(result!.images[0].src, 'https://pbs.twimg.com/media/photo1.jpg');
      assert.equal(result!.images[1].src, 'https://pbs.twimg.com/media/photo2.jpg');
    });

    it('handles twitter.com URLs (not just x.com)', async () => {
      routes['/elonmusk/status/123456789'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://twitter.com/elonmusk/status/123456789',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.ok(result!.content.includes('Elon Musk'));
    });

    it('returns null on API error', async () => {
      routes['/user/status/999'] = {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 404, message: 'Not Found' }),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/user/status/999',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('returns null on invalid JSON', async () => {
      routes['/user/status/888'] = {
        status: 200,
        contentType: 'application/json',
        body: '<<<not json>>>',
      };

      const result = await twitterDecoder.decode(
        'https://x.com/user/status/888',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('returns null when tweet object missing', async () => {
      routes['/user/status/777'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, message: 'OK' }),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/user/status/777',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('generates correct title for regular tweets', async () => {
      routes['/elonmusk/status/123456789'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/elonmusk/status/123456789',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      // Regular tweet: "Author: text preview..."
      assert.ok(result!.title!.includes('Elon Musk'));
      assert.ok(result!.title!.includes('The future is here'));
    });

    it('uses article title when available', async () => {
      routes['/writer/status/987654321'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_ARTICLE_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/writer/status/987654321',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Why AI Agents Need Principles');
    });

    it('sets type to social for regular tweets', async () => {
      routes['/elonmusk/status/123456789'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/elonmusk/status/123456789',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result!.metadata.type, 'social');
    });

    it('includes token cost estimate', async () => {
      routes['/elonmusk/status/123456789'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TWEET),
      };

      const result = await twitterDecoder.decode(
        'https://x.com/elonmusk/status/123456789',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.ok(result!.cost.tokens > 0);
      assert.ok(result!.cost.tokens < 500); // Regular tweet should be small
    });
  });

  describe('profile URLs', () => {
    it('returns null for profile URLs (not yet implemented)', async () => {
      const result = await twitterDecoder.decode(
        'https://x.com/elonmusk',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      // Profile decoding returns null, falls through to generic decoder
      assert.equal(result, null);
    });

    it('returns null for reserved paths like /home', async () => {
      const result = await twitterDecoder.decode(
        'https://x.com/home',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });
  });
});

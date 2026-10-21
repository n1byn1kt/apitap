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

    it('converts HN comment HTML to readable text (entities, <p>, links)', async () => {
      const story = {
        id: 555,
        title: 'Encoded story',
        by: 'author',
        score: 1,
        text: 'First line.<p>Second paragraph with &#x27;quotes&#x27; &amp; ampersand.',
        type: 'story',
        time: 1700000000,
        kids: [600],
        descendants: 1,
      };
      const comment = {
        id: 600,
        by: 'linker',
        text: 'See <a href="https:&#x2F;&#x2F;example.com&#x2F;page" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;pa...</a> for details. Don&#x27;t skip it.',
        type: 'comment',
        time: 1700001000,
      };
      routes['/v0/item/555.json'] = { status: 200, contentType: 'application/json', body: JSON.stringify(story) };
      routes['/v0/item/600.json'] = { status: 200, contentType: 'application/json', body: JSON.stringify(comment) };

      const result = await hackernewsDecoder.decode(
        'https://news.ycombinator.com/item?id=555',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      // Entities decoded, <p> became a paragraph break, no raw tags remain
      assert.ok(result!.content.includes("with 'quotes' & ampersand"), result!.content);
      assert.ok(result!.content.includes('First line.\n\nSecond paragraph'), result!.content);
      assert.ok(!result!.content.includes('<p>'));
      assert.ok(!result!.content.includes('&#x27;'));
      // Link href decoded and preserved
      assert.ok(result!.content.includes('https://example.com/page'), result!.content);
      assert.ok(result!.content.includes("Don't skip it."));
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

  describe('listing pages', () => {
    function serveListing(endpoint: string, ids: number[]): void {
      routes[`/v0/${endpoint}.json`] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ids),
      };
      for (const id of ids) {
        routes[`/v0/item/${id}.json`] = {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id, title: `Story ${id}`, by: 'writer', score: id, descendants: 1, type: 'story', url: `https://example.com/${id}` }),
        };
      }
    }

    const cases: Array<{ url: string; endpoint: string; title: string; canonical: string }> = [
      { url: 'https://news.ycombinator.com/best', endpoint: 'beststories', title: 'Hacker News — Best Stories', canonical: 'https://news.ycombinator.com/best' },
      { url: 'https://news.ycombinator.com/newest', endpoint: 'newstories', title: 'Hacker News — Newest Stories', canonical: 'https://news.ycombinator.com/newest' },
      { url: 'https://news.ycombinator.com/ask', endpoint: 'askstories', title: 'Hacker News — Ask HN', canonical: 'https://news.ycombinator.com/ask' },
      { url: 'https://news.ycombinator.com/show', endpoint: 'showstories', title: 'Hacker News — Show HN', canonical: 'https://news.ycombinator.com/show' },
      { url: 'https://news.ycombinator.com/jobs', endpoint: 'jobstories', title: 'Hacker News — Jobs', canonical: 'https://news.ycombinator.com/jobs' },
      { url: 'https://news.ycombinator.com/news', endpoint: 'topstories', title: 'Hacker News — Top Stories', canonical: 'https://news.ycombinator.com/' },
      { url: 'https://news.ycombinator.com/best?p=2', endpoint: 'beststories', title: 'Hacker News — Best Stories', canonical: 'https://news.ycombinator.com/best' },
    ];

    for (const c of cases) {
      it(`decodes ${c.url} via ${c.endpoint}`, async () => {
        const ids = [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012];
        serveListing(c.endpoint, ids);

        const result = await hackernewsDecoder.decode(c.url, { skipSsrf: true, _apiBaseUrl: baseUrl });

        assert.ok(result, `expected a result for ${c.url}`);
        assert.equal(result!.title, c.title);
        assert.equal(result!.metadata.canonical, c.canonical);
        assert.equal(result!.metadata.type, 'listing');
        // First 10 only, paging ignored
        assert.ok(result!.content.includes('Story 2010'));
        assert.ok(!result!.content.includes('Story 2011'));
      });
    }

    it('returns null when the listing endpoint fails', async () => {
      routes['/v0/beststories.json'] = { status: 500, contentType: 'text/plain', body: 'err' };
      const result = await hackernewsDecoder.decode('https://news.ycombinator.com/best', { skipSsrf: true, _apiBaseUrl: baseUrl });
      assert.equal(result, null);
    });

    it('matches listing URLs (with optional query)', () => {
      const match = (u: string) => hackernewsDecoder.patterns.some(p => p.test(u));
      for (const u of [
        'https://news.ycombinator.com/best',
        'https://news.ycombinator.com/newest',
        'https://news.ycombinator.com/ask',
        'https://news.ycombinator.com/show',
        'https://news.ycombinator.com/jobs',
        'https://news.ycombinator.com/news',
        'https://news.ycombinator.com/best?p=2',
        'https://news.ycombinator.com/?p=2',
      ]) {
        assert.ok(match(u), u);
      }
    });

    it('does not match other HN paths', () => {
      const match = (u: string) => hackernewsDecoder.patterns.some(p => p.test(u));
      for (const u of [
        'https://news.ycombinator.com/user?id=pg',
        'https://news.ycombinator.com/from?site=example.com',
        'https://news.ycombinator.com/newcomments',
        'https://news.ycombinator.com/item',
        'https://news.ycombinator.com/newsfoo',
        'https://news.ycombinator.com/from?site=news.ycombinator.com/best',
        'https://example.com/notes/news.ycombinator.com/ask',
      ]) {
        assert.ok(!match(u), u);
      }
    });
  });
});

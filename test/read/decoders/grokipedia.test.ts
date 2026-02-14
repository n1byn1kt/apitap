// test/read/decoders/grokipedia.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { grokipediaDecoder } from '../../../src/read/decoders/grokipedia.js';

let server: Server;
let baseUrl: string;
let routes: Record<string, { status: number; contentType: string; body: string }>;

function setupServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://127.0.0.1`);
      // Match routes by pathname + search
      const routeKey = url.pathname + url.search;
      const route = routes[routeKey] || routes[url.pathname];
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

// -- Fixtures --

const articleFixture = {
  page: {
    slug: 'SpaceX',
    title: 'SpaceX',
    content: '# SpaceX\nSpace Exploration Technologies Corp., commonly known as SpaceX.',
    description: 'SpaceX is a private American aerospace company.',
    citations: [
      { id: '1', title: 'SpaceX Official', url: 'https://www.spacex.com', description: 'Official website' },
      { id: '2', title: 'NASA Partnership', url: 'https://www.nasa.gov/spacex', description: 'NASA collaboration' },
    ],
    images: [
      { id: 'abc123', caption: 'Falcon 9 launch', url: 'https://assets.grokipedia.com/images/abc123.jpg', position: 'RIGHT', width: 1920, height: 1080 },
    ],
    metadata: {
      categories: ['Space', 'Companies'],
      lastModified: 1770533574,
      contentLength: 50000,
      version: '1.0',
      lastEditor: 'system',
      language: 'en',
      isRedirect: false,
      redirectTarget: '',
      isWithheld: false,
      creationSource: 'CREATION_SOURCE_BATCH_INGESTION',
      visibility: 'ARTICLE_VISIBILITY_PUBLIC',
    },
    stats: {
      totalViews: 1630377,
      recentViews: 1630377,
      dailyAvgViews: 54345.9,
      qualityScore: 1,
      lastViewed: 1770873675,
    },
    linkedPages: null,
    fixedIssues: [],
  },
};

const searchFixture = {
  results: [
    {
      slug: 'SpaceX',
      title: 'SpaceX',
      snippet: '<em>SpaceX</em> is a private American aerospace company.',
      relevanceScore: 3437.41,
      viewCount: '1630377',
      creationSource: 'CREATION_SOURCE_BATCH_INGESTION',
      visibility: 'ARTICLE_VISIBILITY_PUBLIC',
    },
    {
      slug: 'SpaceX_Starbase',
      title: 'SpaceX Starbase',
      snippet: '<em>SpaceX</em> Starbase is a facility in Texas.',
      relevanceScore: 2209.86,
      viewCount: '206139',
      creationSource: 'CREATION_SOURCE_BATCH_INGESTION',
      visibility: 'ARTICLE_VISIBILITY_PUBLIC',
    },
  ],
};

const statsFixture = {
  totalPages: '6092140',
  totalViews: 0,
  avgViewsPerPage: 0,
  indexSizeBytes: '208436267554',
  statsTimestamp: '1770865294',
};

const editsFixture = {
  editRequests: [
    {
      id: 'edit-1',
      slug: 'Bitcoin',
      userId: 'Grok Editor',
      status: 'EDIT_REQUEST_STATUS_IN_REVIEW',
      type: 'EDIT_REQUEST_TYPE_UPDATE_INFORMATION',
      summary: 'Update Bitcoin price info',
    },
  ],
};

// -- Tests --

describe('grokipediaDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('matches /wiki/ URLs', () => {
      assert.ok(grokipediaDecoder.patterns.some(p => p.test('https://grokipedia.com/wiki/SpaceX')));
    });

    it('matches /article/ URLs', () => {
      assert.ok(grokipediaDecoder.patterns.some(p => p.test('https://grokipedia.com/article/Bitcoin')));
    });

    it('matches /search URLs', () => {
      assert.ok(grokipediaDecoder.patterns.some(p => p.test('https://grokipedia.com/search?q=test')));
    });

    it('matches homepage', () => {
      assert.ok(grokipediaDecoder.patterns.some(p => p.test('https://grokipedia.com/')));
      assert.ok(grokipediaDecoder.patterns.some(p => p.test('https://grokipedia.com')));
    });

    it('does not match non-Grokipedia URLs', () => {
      assert.ok(!grokipediaDecoder.patterns.some(p => p.test('https://wikipedia.org/wiki/SpaceX')));
      assert.ok(!grokipediaDecoder.patterns.some(p => p.test('https://example.com/grokipedia')));
    });
  });

  describe('article decoding', () => {
    it('decodes a full article with citations', async () => {
      routes['/page?slug=SpaceX&includeContent=true'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(articleFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/wiki/SpaceX',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'SpaceX');
      assert.ok(result!.content.includes('Space Exploration Technologies'));
      assert.ok(result!.content.includes('## Sources'));
      assert.ok(result!.content.includes('SpaceX Official'));
      assert.equal(result!.metadata.source, 'grokipedia-api');
      assert.equal(result!.metadata.siteName, 'Grokipedia');
      assert.equal(result!.metadata.type, 'article');
      assert.ok(result!.metadata.publishedAt);
      assert.ok(result!.cost.tokens > 0);
    });

    it('includes images from article', async () => {
      routes['/page?slug=SpaceX&includeContent=true'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(articleFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/wiki/SpaceX',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.images.length, 1);
      assert.equal(result!.images[0].alt, 'Falcon 9 launch');
      assert.ok(result!.images[0].src.includes('abc123.jpg'));
    });

    it('includes citation links', async () => {
      routes['/page?slug=SpaceX&includeContent=true'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(articleFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/wiki/SpaceX',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      // 1 "Full article" link + 2 citation links
      assert.equal(result!.links.length, 3);
      assert.equal(result!.links[0].text, 'Full article');
      assert.ok(result!.links[1].href.includes('spacex.com'));
    });

    it('includes view stats in content', async () => {
      routes['/page?slug=SpaceX&includeContent=true'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(articleFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/wiki/SpaceX',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.ok(result!.content.includes('Views:'));
      assert.ok(result!.content.includes('1,630,377'));
    });

    it('handles /article/ URL pattern', async () => {
      routes['/page?slug=Bitcoin&includeContent=true'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          page: {
            slug: 'Bitcoin',
            title: 'Bitcoin',
            content: '# Bitcoin\nA decentralized cryptocurrency.',
            description: 'Bitcoin is a cryptocurrency.',
            citations: [],
            images: [],
            metadata: { language: 'en', lastModified: 1770533574 },
            stats: { totalViews: 500000 },
            fixedIssues: [],
          },
        }),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/article/Bitcoin',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Bitcoin');
      assert.ok(result!.content.includes('decentralized cryptocurrency'));
    });

    it('returns null on API error', async () => {
      routes['/page?slug=Nonexistent&includeContent=true'] = {
        status: 404,
        contentType: 'application/json',
        body: '{"error": "not found"}',
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/wiki/Nonexistent',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('truncates long content', async () => {
      const longContent = 'A'.repeat(30000);
      routes['/page?slug=Long_Article&includeContent=true'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          page: {
            slug: 'Long_Article',
            title: 'Long Article',
            content: longContent,
            description: 'A very long article',
            citations: [],
            images: [],
            metadata: { language: 'en' },
            stats: {},
            fixedIssues: [],
          },
        }),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/wiki/Long_Article',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.ok(result!.content.includes('[Truncated'));
      assert.ok(result!.content.length < 30000);
    });
  });

  describe('search decoding', () => {
    it('decodes search results', async () => {
      routes['/full-text-search?query=SpaceX&limit=10'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/search?q=SpaceX',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Grokipedia search: "SpaceX"');
      assert.ok(result!.content.includes('SpaceX'));
      assert.ok(result!.content.includes('1,630,377 views'));
      assert.equal(result!.metadata.type, 'search-results');
      assert.equal(result!.links.length, 2);
    });

    it('returns null for empty search results', async () => {
      routes['/full-text-search?query=xyznonexistent&limit=10'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [] }),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/search?q=xyznonexistent',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.equal(result, null);
    });

    it('strips HTML emphasis from snippets', async () => {
      routes['/full-text-search?query=SpaceX&limit=10'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/search?q=SpaceX',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      // <em>SpaceX</em> should become **SpaceX**
      assert.ok(result!.content.includes('**SpaceX**'));
      assert.ok(!result!.content.includes('<em>'));
    });
  });

  describe('homepage decoding', () => {
    it('decodes homepage with stats and recent edits', async () => {
      routes['/stats'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(statsFixture),
      };
      routes['/list-edit-requests?limit=5'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(editsFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Grokipedia');
      assert.ok(result!.content.includes('6,092,140 articles'));
      assert.ok(result!.content.includes('194.1 GB'));
      assert.ok(result!.content.includes('Bitcoin'));
      assert.ok(result!.content.includes('Grok Editor'));
      assert.equal(result!.metadata.source, 'grokipedia-api');
    });

    it('handles stats API failure gracefully', async () => {
      routes['/stats'] = {
        status: 500,
        contentType: 'application/json',
        body: '{"error": "internal"}',
      };
      routes['/list-edit-requests?limit=5'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(editsFixture),
      };

      const result = await grokipediaDecoder.decode(
        'https://grokipedia.com/',
        { skipSsrf: true, _apiBaseUrl: baseUrl },
      );

      assert.ok(result);
      assert.equal(result!.title, 'Grokipedia');
      // Should still work with 0 stats
      assert.ok(result!.content.includes('0 articles'));
    });
  });
});

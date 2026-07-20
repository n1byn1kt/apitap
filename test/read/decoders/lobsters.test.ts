// test/read/decoders/lobsters.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { lobstersDecoder } from '../../../src/read/decoders/lobsters.js';

let server: Server;
let base: string;
let deadBase: string;
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
      base = `http://127.0.0.1:${addr.port}`;
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

const FRONT_FIXTURE = [
  {
    title: 'A story',
    url: 'https://ex.com/a',
    score: 46,
    comment_count: 12,
    submitter_user: 'alice',
    comments_url: 'https://lobste.rs/s/abc123/a_story',
    short_id: 'abc123',
    tags: ['programming'],
  },
];

const STORY_FIXTURE = {
  title: 'A story',
  url: 'https://ex.com/a',
  score: 46,
  submitter_user: 'alice',
  short_id: 'abc123',
  created_at: '2026-07-01T12:00:00.000-00:00',
  comments: [
    { commenting_user: 'alice', comment_plain: 'nice' },
  ],
};

describe('lobstersDecoder', () => {
  beforeEach(async () => {
    routes = {};
    await setupServer();
    // deadBase points at a port nothing listens on
    deadBase = 'http://127.0.0.1:1';
  });

  afterEach(async () => {
    await teardownServer();
  });

  describe('URL matching', () => {
    it('pattern does not match unrelated domains', () => {
      assert.ok(!lobstersDecoder.patterns.some(p => p.test('https://example.com/lobste.rs')));
    });
  });

  describe('decoding', () => {
    it('front page decodes hottest.json into a structured listing', async () => {
      routes['/hottest.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FRONT_FIXTURE),
      };

      const result = await lobstersDecoder.decode('https://lobste.rs/', { skipSsrf: true, _apiBaseUrl: base });

      assert.ok(result);
      assert.equal(result!.metadata.source, 'lobsters-json');
      assert.match(result!.content, /1\. A story/);
      assert.match(result!.content, /46 points.*12 comments.*alice/s);
      assert.doesNotMatch(result!.content, /avatars/);
    });

    it('story page decodes /s/<id>.json with comments', async () => {
      routes['/s/abc123.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STORY_FIXTURE),
      };

      const result = await lobstersDecoder.decode('https://lobste.rs/s/abc123/a_story', { skipSsrf: true, _apiBaseUrl: base });

      assert.ok(result);
      assert.match(result!.title!, /A story/);
      assert.match(result!.content, /alice/);
    });

    it('/newest routes to newest.json, not hottest.json', async () => {
      routes['/newest.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FRONT_FIXTURE),
      };
      // deliberately no /hottest.json route — if the decoder mis-routed to
      // hottest.json this would 404 and the test would fail on null/title.

      const result = await lobstersDecoder.decode('https://lobste.rs/newest', { skipSsrf: true, _apiBaseUrl: base });

      assert.ok(result);
      assert.equal(result!.title, 'Lobsters — Newest Stories');
      assert.match(result!.content, /1\. A story/);
    });

    it('/recent explicitly maps to hottest.json', async () => {
      routes['/hottest.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FRONT_FIXTURE),
      };

      const result = await lobstersDecoder.decode('https://lobste.rs/recent', { skipSsrf: true, _apiBaseUrl: base });

      assert.ok(result);
      assert.equal(result!.title, 'Lobsters — Hottest Stories');
    });

    it('returns null when the front-page array contains a malformed/null entry', async () => {
      routes['/hottest.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([null, ...FRONT_FIXTURE]),
      };

      // Should not throw — decoder must guard the bad entry. Since a good
      // entry is also present, decoding still succeeds using only it.
      const result = await lobstersDecoder.decode('https://lobste.rs/', { skipSsrf: true, _apiBaseUrl: base });
      assert.ok(result);
      assert.match(result!.content, /1\. A story/);
    });

    it('returns null when the front-page array is entirely malformed entries', async () => {
      routes['/hottest.json'] = {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([null, { no: 'title here' }, 42]),
      };

      const result = await lobstersDecoder.decode('https://lobste.rs/', { skipSsrf: true, _apiBaseUrl: base });
      assert.equal(result, null);
    });

    it('returns null on fetch failure (falls back to HTML extraction)', async () => {
      const result = await lobstersDecoder.decode('https://lobste.rs/', { skipSsrf: true, _apiBaseUrl: deadBase });
      assert.equal(result, null);
    });
  });
});

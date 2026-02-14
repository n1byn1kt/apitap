// test/e2e/graphql-capture-replay.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SkillGenerator } from '../../src/skill/generator.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import type { CapturedExchange } from '../../src/types.js';

describe('GraphQL capture and replay E2E', () => {
  let server: Server;
  let baseUrl: string;
  let lastReceivedBody: Record<string, unknown> | null = null;

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          lastReceivedBody = JSON.parse(body);
        } catch {
          lastReceivedBody = null;
        }

        if (req.url === '/graphql' || req.url === '/svc/shreddit/graphql') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              posts: [
                { id: '1', title: 'First Post' },
                { id: '2', title: 'Second Post' },
              ],
            },
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('captures GraphQL POST and generates correct endpoint ID', () => {
    const gen = new SkillGenerator();

    const exchange: CapturedExchange = {
      request: {
        url: `${baseUrl}/svc/shreddit/graphql`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          operationName: 'GetSubredditPosts',
          query: 'query GetSubredditPosts($subreddit: String!, $limit: Int) { posts(subreddit: $subreddit, limit: $limit) { id title } }',
          variables: { subreddit: 'programming', limit: 25 },
        }),
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ data: { posts: [] } }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    };

    gen.addExchange(exchange);
    const skill = gen.toSkillFile('localhost');

    // Check endpoint ID is GraphQL-aware
    assert.equal(skill.endpoints[0].id, 'post-graphql-GetSubredditPosts');

    // Check requestBody is captured
    assert.ok(skill.endpoints[0].requestBody);
    assert.equal(skill.endpoints[0].requestBody.contentType, 'application/json');

    // Check variables are detected
    const vars = skill.endpoints[0].requestBody.variables ?? [];
    assert.ok(vars.includes('variables.limit'));
  });

  it('replays GraphQL endpoint with variable substitution', async () => {
    const gen = new SkillGenerator();

    const exchange: CapturedExchange = {
      request: {
        url: `${baseUrl}/graphql`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          operationName: 'GetPosts',
          query: 'query GetPosts($limit: Int) { posts(limit: $limit) { id } }',
          variables: { limit: 10 },
        }),
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ data: { posts: [] } }),
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    };

    gen.addExchange(exchange);
    const skill = gen.toSkillFile('localhost');

    // Replay with different limit
    const result = await replayEndpoint(skill, 'post-graphql-GetPosts', {
      params: { 'variables.limit': '50' },
      _skipSsrfCheck: true,
    });

    assert.equal(result.status, 200);
    assert.ok(result.data);

    // Verify server received substituted value
    assert.equal((lastReceivedBody as Record<string, unknown>)?.variables?.limit, '50');
  });

  it('deduplicates same GraphQL operation with different variables', () => {
    const gen = new SkillGenerator();

    // First request
    gen.addExchange({
      request: {
        url: `${baseUrl}/graphql`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          operationName: 'GetPosts',
          query: 'query GetPosts { posts { id } }',
          variables: { limit: 10 },
        }),
      },
      response: { status: 200, headers: {}, body: '{}', contentType: 'application/json' },
      timestamp: new Date().toISOString(),
    });

    // Second request - same operation, different variables
    gen.addExchange({
      request: {
        url: `${baseUrl}/graphql`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          operationName: 'GetPosts',
          query: 'query GetPosts { posts { id } }',
          variables: { limit: 20 },
        }),
      },
      response: { status: 200, headers: {}, body: '{}', contentType: 'application/json' },
      timestamp: new Date().toISOString(),
    });

    const skill = gen.toSkillFile('localhost');

    // Should have only one endpoint
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.metadata.captureCount, 2);
  });
});

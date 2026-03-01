// test/skill/generator.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillGenerator } from '../../src/skill/generator.js';
import type { CapturedExchange } from '../../src/types.js';

function mockExchange(overrides: {
  url?: string;
  method?: string;
  status?: number;
  body?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}): CapturedExchange {
  const url = overrides.url ?? 'https://api.example.com/data';
  return {
    request: {
      url,
      method: overrides.method ?? 'GET',
      headers: overrides.requestHeaders ?? { accept: 'application/json' },
    },
    response: {
      status: overrides.status ?? 200,
      headers: overrides.responseHeaders ?? {},
      body: overrides.body ?? JSON.stringify([{ id: 1, name: 'test' }]),
      contentType: 'application/json',
    },
    timestamp: '2026-02-04T12:00:00.000Z',
  };
}

describe('SkillGenerator', () => {
  it('generates a skill file from captured exchanges', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://api.example.com/api/markets?limit=10',
      body: JSON.stringify([{ id: 1, name: 'BTC', price: 50000 }]),
    }));
    gen.addExchange(mockExchange({
      url: 'https://api.example.com/api/events',
      body: JSON.stringify({ events: [{ id: 1 }] }),
    }));

    const skill = gen.toSkillFile('api.example.com');

    assert.equal(skill.version, '1.2');
    assert.equal(skill.provenance, 'unsigned');
    assert.equal(skill.domain, 'api.example.com');
    assert.equal(skill.endpoints.length, 2);
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('deduplicates endpoints by method + path', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ url: 'https://example.com/api/data?page=1' }));
    gen.addExchange(mockExchange({ url: 'https://example.com/api/data?page=2' }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('generates readable endpoint IDs', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ url: 'https://example.com/api/v1/markets' }));
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/orders',
      method: 'POST',
    }));

    const skill = gen.toSkillFile('example.com');
    const ids = skill.endpoints.map(e => e.id);
    assert.ok(ids.includes('get-api-v1-markets'));
    assert.ok(ids.includes('post-api-orders'));
  });

  it('extracts query parameters', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?q=bitcoin&limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.equal(ep.queryParams['q'].example, 'bitcoin');
    assert.equal(ep.queryParams['limit'].example, '10');
  });

  it('detects array response shape', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'a', price: 100 }]),
    }));

    const skill = gen.toSkillFile('example.com');
    const shape = skill.endpoints[0].responseShape;
    assert.equal(shape.type, 'array');
    assert.deepEqual(shape.fields, ['id', 'name', 'price']);
  });

  it('detects object response shape', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify({ total: 100, items: [] }),
    }));

    const skill = gen.toSkillFile('example.com');
    const shape = skill.endpoints[0].responseShape;
    assert.equal(shape.type, 'object');
    assert.deepEqual(shape.fields, ['total', 'items']);
  });

  it('returns new endpoint from addExchange, null for duplicates', () => {
    const gen = new SkillGenerator();
    const first = gen.addExchange(mockExchange({ url: 'https://example.com/api/data' }));
    const dupe = gen.addExchange(mockExchange({ url: 'https://example.com/api/data?v=2' }));

    assert.notEqual(first, null);
    assert.equal(dupe, null);
  });

  it('filters noisy request headers, keeps meaningful ones', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'accept': 'application/json',
        'authorization': 'Bearer tok123',
        'user-agent': 'Mozilla/5.0 ...',
        'accept-encoding': 'gzip',
        'x-api-key': 'key123',
        'cookie': 'session=abc',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], '[stored]');
    assert.equal(h['x-api-key'], '[stored]');
    assert.equal(h['user-agent'], 'Mozilla/5.0 ...'); // user-agent preserved (useful for API compat)
    assert.equal(h['accept-encoding'], undefined);     // stripped (handled by fetch)
    assert.equal(h['cookie'], undefined);               // stripped (stored separately)
  });

  it('tracks filtered count', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({}));
    gen.recordFiltered();
    gen.recordFiltered();
    gen.recordFiltered();

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.metadata.filteredCount, 3);
    assert.equal(skill.metadata.captureCount, 1);
  });

  it('replaces auth headers with [stored] placeholder', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'authorization': 'Bearer secret-token',
        'x-api-key': 'secret-key',
        'content-type': 'application/json',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], '[stored]');
    assert.equal(h['x-api-key'], '[stored]');
    assert.equal(h['content-type'], 'application/json');

    // Example headers should also be scrubbed
    const exH = skill.endpoints[0].examples.request.headers;
    assert.equal(exH['authorization'], '[stored]');
    assert.equal(exH['x-api-key'], '[stored]');
  });

  it('exposes extracted auth credentials', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'authorization': 'Bearer secret-token',
      },
    }));

    const extracted = gen.getExtractedAuth();
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].type, 'bearer');
    assert.equal(extracted[0].header, 'authorization');
    assert.equal(extracted[0].value, 'Bearer secret-token');
  });

  it('omits responsePreview by default', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'test' }]),
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].examples.responsePreview, null);
  });

  it('includes responsePreview when enablePreview is true', () => {
    const gen = new SkillGenerator({ enablePreview: true });
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'test' }]),
    }));

    const skill = gen.toSkillFile('example.com');
    assert.deepEqual(skill.endpoints[0].examples.responsePreview, [{ id: 1, name: 'test' }]);
  });

  it('scrubs PII from query param examples', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?email=john@test.com&limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    const params = skill.endpoints[0].queryParams;
    assert.equal(params['email'].example, '[email]');
    assert.equal(params['limit'].example, '10');
  });

  it('scrubs PII from example request URL', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/users/john@test.com/profile',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.ok(skill.endpoints[0].examples.request.url.includes('[email]'));
    assert.ok(!skill.endpoints[0].examples.request.url.includes('john@test.com'));
  });

  it('skips PII scrubbing when scrub is false', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?email=john@test.com',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].queryParams['email'].example, 'john@test.com');
  });

  it('generates clean IDs for Next.js _next/data routes', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/_next/data/TjugEgeSUE4oCdg-1g2I1/en/tech.json',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].id, 'get-en-tech');
  });

  it('parameterizes numeric path segments', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/markets/123',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].path, '/api/markets/:id');
    assert.equal(skill.endpoints[0].id, 'get-api-markets');
  });

  it('deduplicates parameterized path variants', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/items/42',
    }));
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/items/99',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.endpoints[0].path, '/api/items/:id');
    assert.equal(skill.metadata.captureCount, 2);
  });

  it('parameterizes slug-like segments with long numeric substrings', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/events/slug/btc-updown-15m-1770254100',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].path, '/events/slug/:slug');
    assert.equal(skill.endpoints[0].id, 'get-events-slug');
  });

  it('preserves original URL in examples after parameterization', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/items/42?limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.ok(skill.endpoints[0].examples.request.url.includes('/api/items/42'));
  });

  it('deduplicates _next/data routes with same cleaned path', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/_next/data/HASH1/en/tech.json',
    }));
    gen.addExchange(mockExchange({
      url: 'https://example.com/_next/data/HASH2/en/tech.json',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.endpoints[0].id, 'get-en-tech');
  });

  it('detects pagination in query params', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/items?offset=0&limit=20',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.deepEqual(skill.endpoints[0].pagination, {
      type: 'offset',
      paramName: 'offset',
      limitParam: 'limit',
    });
  });

  it('omits pagination when not detected', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?q=bitcoin',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].pagination, undefined);
  });

  it('preserves custom headers like Client-ID', () => {
    const gen = new SkillGenerator();
    gen.addExchange({
      request: {
        url: 'https://api.twitch.tv/helix/streams',
        method: 'GET',
        headers: {
          'client-id': 'abc123',
          'content-type': 'application/json',
          'accept': 'application/json',
        },
      },
      response: {
        status: 200,
        headers: {},
        body: '{"data":[]}',
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const skill = gen.toSkillFile('api.twitch.tv');
    const ep = skill.endpoints[0];
    assert.ok('client-id' in ep.headers, 'client-id header should be preserved');
    assert.equal(ep.headers['content-type'], 'application/json');
    assert.equal(ep.headers['accept'], 'application/json');
  });

  it('strips connection control and browser-internal headers', () => {
    const gen = new SkillGenerator();
    gen.addExchange({
      request: {
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'host': 'api.example.com',
          'connection': 'keep-alive',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-ch-ua': '"Chromium";v="120"',
          'accept-encoding': 'gzip, deflate',
          'cookie': 'session=abc123',
          'x-forwarded-for': '1.2.3.4',
        },
      },
      response: {
        status: 200,
        headers: {},
        body: '{"ok":true}',
        contentType: 'application/json',
      },
      timestamp: new Date().toISOString(),
    });

    const skill = gen.toSkillFile('api.example.com');
    const ep = skill.endpoints[0];
    assert.ok('accept' in ep.headers, 'accept should be preserved');
    assert.ok(!('host' in ep.headers), 'host should be stripped');
    assert.ok(!('connection' in ep.headers), 'connection should be stripped');
    assert.ok(!('sec-fetch-dest' in ep.headers), 'sec-fetch-dest should be stripped');
    assert.ok(!('sec-ch-ua' in ep.headers), 'sec-ch-ua should be stripped');
    assert.ok(!('accept-encoding' in ep.headers), 'accept-encoding should be stripped');
    assert.ok(!('cookie' in ep.headers), 'cookie should be stripped');
    assert.ok(!('x-forwarded-for' in ep.headers), 'x-forwarded-for should be stripped');
  });
});

describe('Request body handling', () => {
  function mockExchangeWithBody(overrides: {
    url?: string;
    method?: string;
    postData?: string;
    contentType?: string;
  }): CapturedExchange {
    return {
      request: {
        url: overrides.url ?? 'https://api.example.com/data',
        method: overrides.method ?? 'POST',
        headers: { 'content-type': overrides.contentType ?? 'application/json' },
        postData: overrides.postData,
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ success: true }),
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    };
  }

  it('captures requestBody for POST with JSON body', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchangeWithBody({
      url: 'https://example.com/api/items',
      postData: JSON.stringify({ name: 'widget', quantity: 5 }),
    }));

    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.ok(ep.requestBody);
    assert.equal(ep.requestBody.contentType, 'application/json');
    assert.deepEqual(ep.requestBody.template, { name: 'widget', quantity: 5 });
  });

  it('detects variables in JSON body', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchangeWithBody({
      url: 'https://example.com/api/items',
      postData: JSON.stringify({ itemId: 12345, action: 'update' }),
    }));

    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.ok(ep.requestBody?.variables?.includes('itemId'));
  });

  it('stores string body for non-JSON content types', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchangeWithBody({
      url: 'https://example.com/api/form',
      postData: 'name=test&value=123',
      contentType: 'application/x-www-form-urlencoded',
    }));

    const skill = gen.toSkillFile('example.com');
    const ep = skill.endpoints[0];
    assert.ok(ep.requestBody);
    assert.equal(ep.requestBody.template, 'name=test&value=123');
  });

  it('omits requestBody for GET requests', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({ method: 'GET' }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].requestBody, undefined);
  });

  it('scrubs PII from request body', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchangeWithBody({
      postData: JSON.stringify({ email: 'john@test.com', name: 'John' }),
    }));

    const skill = gen.toSkillFile('example.com');
    const body = skill.endpoints[0].requestBody?.template as Record<string, unknown>;
    assert.equal(body.email, '[email]');
    assert.equal(body.name, 'John');
  });
});

describe('SkillGenerator refreshableTokens', () => {
  function mockExchangeWithBody(overrides: {
    url?: string;
    method?: string;
    postData?: string;
    contentType?: string;
  }): CapturedExchange {
    return {
      request: {
        url: overrides.url ?? 'https://api.example.com/data',
        method: overrides.method ?? 'POST',
        headers: { 'content-type': overrides.contentType ?? 'application/json' },
        postData: overrides.postData,
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ success: true }),
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    };
  }

  it('should detect refreshableTokens in POST body', () => {
    const gen = new SkillGenerator();

    gen.addExchange(mockExchangeWithBody({
      url: 'https://example.com/api/action',
      postData: JSON.stringify({
        action: 'submit',
        csrf_token: '89f1d8b1568692c9160dee459f4ae000',
        user_id: 123,
      }),
    }));

    const skill = gen.toSkillFile('example.com');

    const endpoint = skill.endpoints[0];
    assert.ok(endpoint.requestBody, 'should have requestBody');
    assert.deepEqual(
      endpoint.requestBody?.refreshableTokens,
      ['csrf_token'],
      'should detect csrf_token as refreshable'
    );
  });

  it('should detect nested refreshableTokens', () => {
    const gen = new SkillGenerator();

    gen.addExchange(mockExchangeWithBody({
      url: 'https://example.com/graphql',
      postData: JSON.stringify({
        query: 'mutation { doThing }',
        variables: { input: { id: 1 } },
        csrf_token: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      }),
    }));

    const skill = gen.toSkillFile('example.com');

    const endpoint = skill.endpoints[0];
    assert.ok(endpoint.requestBody?.refreshableTokens?.includes('csrf_token'));
  });

  it('should NOT mark access_token as refreshable', () => {
    const gen = new SkillGenerator();

    gen.addExchange(mockExchangeWithBody({
      url: 'https://example.com/api/data',
      postData: JSON.stringify({
        access_token: '89f1d8b1568692c9160dee459f4ae000',
      }),
    }));

    const skill = gen.toSkillFile('example.com');

    const endpoint = skill.endpoints[0];
    assert.ok(
      !endpoint.requestBody?.refreshableTokens?.includes('access_token'),
      'should NOT detect access_token as refreshable'
    );
  });
});

describe('SkillGenerator captcha risk', () => {
  it('should set auth.captchaRisk when captcha detected', () => {
    const gen = new SkillGenerator();
    gen.setCaptchaRisk(true);

    const skill = gen.toSkillFile('example.com');

    assert.ok(skill.auth, 'should have auth config');
    assert.equal(skill.auth?.captchaRisk, true);
    assert.equal(skill.auth?.browserMode, 'visible');
  });

  it('should not set auth when no captcha and no refreshable tokens', () => {
    const gen = new SkillGenerator();

    const skill = gen.toSkillFile('example.com');

    assert.equal(skill.auth, undefined, 'should not have auth config');
  });

  it('should set auth.browserMode to headless when only refreshable tokens', () => {
    const gen = new SkillGenerator();
    gen.addExchange({
      request: {
        url: 'https://example.com/api/action',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ csrf_token: '89f1d8b1568692c9160dee459f4ae000' }),
      },
      response: {
        status: 200,
        headers: {},
        body: '{}',
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    });

    const skill = gen.toSkillFile('example.com');

    assert.ok(skill.auth, 'should have auth config for refreshable tokens');
    assert.equal(skill.auth?.captchaRisk, false);
    assert.equal(skill.auth?.browserMode, 'headless');
  });
});

describe('GraphQL endpoint handling', () => {
  function mockGraphQLExchange(operationName: string, query: string, variables?: Record<string, unknown>): CapturedExchange {
    return {
      request: {
        url: 'https://example.com/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ operationName, query, variables }),
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ data: {} }),
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    };
  }

  it('generates endpoint ID from operationName', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGraphQLExchange(
      'GetSubredditPosts',
      'query GetSubredditPosts { posts { id } }',
    ));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].id, 'post-graphql-GetSubredditPosts');
  });

  it('extracts operationName from query when not explicit', () => {
    const gen = new SkillGenerator();
    gen.addExchange({
      request: {
        url: 'https://example.com/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          query: 'query FetchUsers { users { id } }',
        }),
      },
      response: {
        status: 200,
        headers: {},
        body: '{}',
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    });

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].id, 'post-graphql-FetchUsers');
  });

  it('uses Anonymous for unnamed queries', () => {
    const gen = new SkillGenerator();
    gen.addExchange({
      request: {
        url: 'https://example.com/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ query: '{ posts { id } }' }),
      },
      response: {
        status: 200,
        headers: {},
        body: '{}',
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    });

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].id, 'post-graphql-Anonymous');
  });

  it('detects GraphQL variables as dynamic', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGraphQLExchange(
      'GetPosts',
      'query GetPosts($limit: Int, $after: String) { posts }',
      { limit: 10, after: 'eyJjdXJzb3IiOiIxMjM0NSJ9' },
    ));

    const skill = gen.toSkillFile('example.com');
    const vars = skill.endpoints[0].requestBody?.variables ?? [];
    assert.ok(vars.includes('variables.limit'));
    assert.ok(vars.includes('variables.after'));
  });

  it('deduplicates GraphQL operations by operationName', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGraphQLExchange('GetPosts', 'query GetPosts { posts }', { limit: 10 }));
    gen.addExchange(mockGraphQLExchange('GetPosts', 'query GetPosts { posts }', { limit: 20 }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints.length, 1);
    assert.equal(skill.metadata.captureCount, 2);
  });
});

// test/capture/monitor-body.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedExchange } from '../../src/types.js';

describe('CapturedExchange with postData', () => {
  it('should include postData for POST requests', () => {
    // This is a unit test for the type - the actual capture behavior
    // is tested via e2e tests. Here we verify the type shape.
    const exchange: CapturedExchange = {
      request: {
        url: 'https://example.com/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: '{"query":"{ posts }"}',
      },
      response: {
        status: 200,
        headers: {},
        body: '{"data":{}}',
        contentType: 'application/json',
      },
      timestamp: '2026-02-04T12:00:00Z',
    };

    assert.equal(exchange.request.postData, '{"query":"{ posts }"}');
    assert.equal(exchange.request.method, 'POST');
  });
});

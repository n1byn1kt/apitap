import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IndexFile, IndexEntry, IndexEndpoint } from '../../extension/src/types.js';

describe('IndexFile types', () => {
  it('accepts a valid IndexFile', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    };
    assert.equal(index.v, 1);
    assert.ok(Array.isArray(index.entries));
  });

  it('accepts a full IndexEntry with endpoints', () => {
    const entry: IndexEntry = {
      domain: 'discord.com',
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-07T12:00:00Z',
      totalHits: 127,
      promoted: false,
      endpoints: [{
        path: '/api/v10/channels/:id',
        methods: ['GET', 'PATCH'],
        authType: 'Bearer',
        hasBody: true,
        hits: 42,
        lastSeen: '2026-03-07T12:00:00Z',
        pagination: 'cursor',
        queryParamNames: ['limit', 'after'],
      }],
    };
    assert.equal(entry.domain, 'discord.com');
    assert.equal(entry.endpoints[0].methods.length, 2);
    assert.equal(entry.endpoints[0].type, undefined);
  });

  it('accepts optional promotion fields', () => {
    const entry: IndexEntry = {
      domain: 'github.com',
      firstSeen: '2026-03-01T00:00:00Z',
      lastSeen: '2026-03-07T12:00:00Z',
      totalHits: 43,
      promoted: true,
      lastPromoted: '2026-03-05T10:00:00Z',
      skillFileSource: 'extension',
      endpoints: [],
    };
    assert.equal(entry.promoted, true);
    assert.equal(entry.skillFileSource, 'extension');
  });

  it('accepts graphql endpoint type', () => {
    const ep: IndexEndpoint = {
      path: '/graphql',
      methods: ['POST'],
      hasBody: true,
      hits: 10,
      lastSeen: '2026-03-07T12:00:00Z',
      type: 'graphql',
    };
    assert.equal(ep.type, 'graphql');
  });
});

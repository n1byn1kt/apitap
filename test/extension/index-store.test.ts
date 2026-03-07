import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeObservation, createEmptyIndex } from '../../extension/src/index-store.js';
import type { IndexFile } from '../../extension/src/types.js';
import type { Observation } from '../../extension/src/observer.js';

describe('index-store mergeObservation', () => {
  it('adds a new domain entry', () => {
    const index = createEmptyIndex();
    const obs: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['GET'],
        authType: 'Bearer',
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };

    const updated = mergeObservation(index, obs);
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entries[0].domain, 'discord.com');
    assert.equal(updated.entries[0].endpoints.length, 1);
    assert.equal(updated.entries[0].totalHits, 1);
    assert.equal(updated.entries[0].promoted, false);
  });

  it('merges into existing domain entry', () => {
    const index = createEmptyIndex();
    const obs1: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };
    const obs2: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/guilds/:id',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:01:00Z',
      },
    };

    let updated = mergeObservation(index, obs1);
    updated = mergeObservation(updated, obs2);
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entries[0].endpoints.length, 2);
    assert.equal(updated.entries[0].totalHits, 2);
  });

  it('merges methods into existing endpoint', () => {
    const index = createEmptyIndex();
    const obs1: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };
    const obs2: Observation = {
      domain: 'discord.com',
      endpoint: {
        path: '/api/v10/channels/:id',
        methods: ['PATCH'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:01:00Z',
      },
    };

    let updated = mergeObservation(index, obs1);
    updated = mergeObservation(updated, obs2);
    assert.equal(updated.entries[0].endpoints.length, 1);
    assert.deepEqual(updated.entries[0].endpoints[0].methods, ['GET', 'PATCH']);
    assert.equal(updated.entries[0].endpoints[0].hits, 2);
  });

  it('does not duplicate methods', () => {
    const index = createEmptyIndex();
    const obs: Observation = {
      domain: 'example.com',
      endpoint: {
        path: '/api/data',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
      },
    };

    let updated = mergeObservation(index, obs);
    updated = mergeObservation(updated, obs);
    assert.deepEqual(updated.entries[0].endpoints[0].methods, ['GET']);
    assert.equal(updated.entries[0].endpoints[0].hits, 2);
  });

  it('merges queryParamNames without duplicates', () => {
    const index = createEmptyIndex();
    const obs1: Observation = {
      domain: 'example.com',
      endpoint: {
        path: '/api/search',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:00:00Z',
        queryParamNames: ['q', 'limit'],
      },
    };
    const obs2: Observation = {
      domain: 'example.com',
      endpoint: {
        path: '/api/search',
        methods: ['GET'],
        hasBody: true,
        hits: 1,
        lastSeen: '2026-03-07T12:01:00Z',
        queryParamNames: ['q', 'offset'],
      },
    };

    let updated = mergeObservation(index, obs1);
    updated = mergeObservation(updated, obs2);
    const qp = updated.entries[0].endpoints[0].queryParamNames!;
    assert.ok(qp.includes('q'));
    assert.ok(qp.includes('limit'));
    assert.ok(qp.includes('offset'));
    assert.equal(qp.length, 3);
  });

  it('updates lastSeen timestamp on domain and endpoint', () => {
    const index = createEmptyIndex();
    const early = '2026-03-07T10:00:00Z';
    const late = '2026-03-07T14:00:00Z';

    let updated = mergeObservation(index, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], hasBody: true, hits: 1, lastSeen: early },
    });
    updated = mergeObservation(updated, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], hasBody: true, hits: 1, lastSeen: late },
    });

    assert.equal(updated.entries[0].lastSeen, late);
    assert.equal(updated.entries[0].endpoints[0].lastSeen, late);
  });

  it('preserves authType once detected', () => {
    const index = createEmptyIndex();
    // First request has no auth, second has Bearer
    let updated = mergeObservation(index, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T10:00:00Z' },
    });
    updated = mergeObservation(updated, {
      domain: 'example.com',
      endpoint: { path: '/api', methods: ['GET'], authType: 'Bearer', hasBody: true, hits: 1, lastSeen: '2026-03-07T11:00:00Z' },
    });

    assert.equal(updated.entries[0].endpoints[0].authType, 'Bearer');
  });
});

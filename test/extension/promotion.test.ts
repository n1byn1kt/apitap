import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markPromoted } from '../../extension/src/promotion.js';
import { createEmptyIndex, mergeObservation } from '../../extension/src/index-store.js';

describe('promotion', () => {
  it('marks domain as promoted in index', () => {
    let index = createEmptyIndex();
    index = mergeObservation(index, {
      domain: 'discord.com',
      endpoint: { path: '/api/channels/:id', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T12:00:00Z' },
    });

    const updated = markPromoted(index, 'discord.com', 'extension');
    const entry = updated.entries.find(e => e.domain === 'discord.com')!;
    assert.equal(entry.promoted, true);
    assert.ok(entry.lastPromoted);
    assert.equal(entry.skillFileSource, 'extension');
  });

  it('is a no-op for unknown domain', () => {
    const index = createEmptyIndex();
    const updated = markPromoted(index, 'unknown.com', 'extension');
    assert.equal(updated.entries.length, 0);
  });

  it('preserves other entries when promoting one domain', () => {
    let index = createEmptyIndex();
    index = mergeObservation(index, {
      domain: 'discord.com',
      endpoint: { path: '/api/channels/:id', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T12:00:00Z' },
    });
    index = mergeObservation(index, {
      domain: 'github.com',
      endpoint: { path: '/api/repos', methods: ['GET'], hasBody: true, hits: 1, lastSeen: '2026-03-07T12:00:00Z' },
    });

    const updated = markPromoted(index, 'discord.com', 'extension');
    assert.equal(updated.entries.length, 2);
    assert.equal(updated.entries.find(e => e.domain === 'github.com')!.promoted, false);
  });
});

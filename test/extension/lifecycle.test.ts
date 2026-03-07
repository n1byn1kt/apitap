import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyLifecycle } from '../../extension/src/lifecycle.js';
import type { IndexFile } from '../../extension/src/types.js';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe('index lifecycle', () => {
  it('keeps entries with recent activity', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        domain: 'example.com',
        firstSeen: daysAgo(30),
        lastSeen: daysAgo(1),
        totalHits: 50,
        promoted: false,
        endpoints: [],
      }],
    };

    const result = applyLifecycle(index);
    assert.equal(result.index.entries.length, 1);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.stale.length, 0);
  });

  it('flags entries with 90+ days of inactivity as stale', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        domain: 'old.com',
        firstSeen: daysAgo(180),
        lastSeen: daysAgo(95),
        totalHits: 10,
        promoted: false,
        endpoints: [],
      }],
    };

    const result = applyLifecycle(index);
    assert.equal(result.stale.length, 1);
    assert.equal(result.stale[0], 'old.com');
    assert.equal(result.index.entries.length, 1); // still present
    assert.equal(result.deleted.length, 0);
  });

  it('hard deletes entries with 180+ days of inactivity', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{
        domain: 'ancient.com',
        firstSeen: daysAgo(365),
        lastSeen: daysAgo(185),
        totalHits: 5,
        promoted: false,
        endpoints: [],
      }],
    };

    const result = applyLifecycle(index);
    assert.equal(result.index.entries.length, 0);
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0], 'ancient.com');
  });

  it('warns when entry count exceeds 500', () => {
    const entries = Array.from({ length: 510 }, (_, i) => ({
      domain: 'site' + i + '.com',
      firstSeen: daysAgo(10),
      lastSeen: daysAgo(1),
      totalHits: 10,
      promoted: false,
      endpoints: [],
    }));

    const index: IndexFile = { v: 1, updatedAt: new Date().toISOString(), entries };
    const result = applyLifecycle(index);
    assert.ok(result.overCap);
    assert.equal(result.index.entries.length, 510); // never silently drop
  });

  it('does not warn when entry count is under 500', () => {
    const index: IndexFile = {
      v: 1,
      updatedAt: new Date().toISOString(),
      entries: [{ domain: 'a.com', firstSeen: daysAgo(1), lastSeen: daysAgo(0), totalHits: 1, promoted: false, endpoints: [] }],
    };
    const result = applyLifecycle(index);
    assert.ok(!result.overCap);
  });
});

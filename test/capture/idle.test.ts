// test/capture/idle.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdleTracker } from '../../src/capture/idle.js';

describe('IdleTracker', () => {
  it('reports not idle when endpoints are being discovered', () => {
    let clock = 0;
    const tracker = new IdleTracker(100, () => clock);

    tracker.recordEndpoint('GET /api/items');
    clock += 50;
    assert.equal(tracker.checkIdle(), false);

    tracker.recordEndpoint('GET /api/events');
    clock += 50;
    assert.equal(tracker.checkIdle(), false);
  });

  it('reports idle after threshold with no new endpoints', () => {
    let clock = 0;
    const tracker = new IdleTracker(100, () => clock);

    tracker.recordEndpoint('GET /api/items');
    clock += 150;
    assert.equal(tracker.checkIdle(), true);
  });

  it('fires idle only once per idle period', () => {
    let clock = 0;
    const tracker = new IdleTracker(100, () => clock);

    tracker.recordEndpoint('GET /api/items');
    clock += 150;
    assert.equal(tracker.checkIdle(), true);
    assert.equal(tracker.checkIdle(), false); // Already fired
  });

  it('resets idle after new endpoint discovery', () => {
    let clock = 0;
    const tracker = new IdleTracker(100, () => clock);

    tracker.recordEndpoint('GET /api/items');
    clock += 150;
    assert.equal(tracker.checkIdle(), true);

    // New endpoint resets the timer
    tracker.recordEndpoint('GET /api/events');
    clock += 50;
    assert.equal(tracker.checkIdle(), false);

    clock += 100;
    assert.equal(tracker.checkIdle(), true);
  });

  it('ignores duplicate endpoints', () => {
    let clock = 0;
    const tracker = new IdleTracker(100, () => clock);

    tracker.recordEndpoint('GET /api/items');
    clock += 50;
    const isNew = tracker.recordEndpoint('GET /api/items');
    assert.equal(isNew, false);

    // Timer was NOT reset by duplicate
    clock += 60;
    assert.equal(tracker.checkIdle(), true);
  });

  it('returns true from recordEndpoint for new keys', () => {
    const tracker = new IdleTracker(100, () => 0);
    assert.equal(tracker.recordEndpoint('GET /api/items'), true);
    assert.equal(tracker.recordEndpoint('GET /api/events'), true);
    assert.equal(tracker.recordEndpoint('GET /api/items'), false);
  });
});

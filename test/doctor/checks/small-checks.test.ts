// test/doctor/checks/small-checks.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { staleCapture } from '../../../src/doctor/checks/stale-capture.js';
import { unverifiedTier } from '../../../src/doctor/checks/unverified-tier.js';
import { emptySkill } from '../../../src/doctor/checks/empty-skill.js';
import { makeEndpoint, makeSkill } from '../fixtures.js';

const CTX = { now: new Date('2026-07-19T00:00:00.000Z'), staleDays: 90 };

describe('stale-capture', () => {
  it('flags captures older than staleDays', () => {
    const [f] = staleCapture.scan(makeSkill({ capturedAt: '2026-03-14T00:00:00.000Z' }), CTX);
    assert.equal(f.severity, 'warn');
    assert.equal(f.fixable, false);
    assert.match(f.message, /127 days/);
    assert.match(f.message, /upper bound/); // merged endpoints may be older
  });
  it('fresh capture → no finding; missing capturedAt → warn', () => {
    assert.deepEqual(staleCapture.scan(makeSkill({ capturedAt: '2026-07-01T00:00:00.000Z' }), CTX), []);
    const [f] = staleCapture.scan(makeSkill({ capturedAt: 'not-a-date' }), CTX);
    assert.match(f.message, /capturedAt/);
  });
  it('respects a custom staleDays', () => {
    const ctx = { ...CTX, staleDays: 10 };
    assert.equal(staleCapture.scan(makeSkill({ capturedAt: '2026-07-01T00:00:00.000Z' }), ctx).length, 1);
  });
});

describe('unverified-tier', () => {
  it('one info finding per skill counting unknown-tier endpoints (missing replayability counts)', () => {
    const skill = makeSkill({
      endpoints: [
        makeEndpoint({ replayability: { tier: 'green', verified: true, signals: [] } }),
        makeEndpoint({ id: 'e2', path: '/a', replayability: { tier: 'unknown', verified: false, signals: [] } }),
        makeEndpoint({ id: 'e3', path: '/b' }), // no replayability at all
      ],
    });
    const findings = unverifiedTier.scan(skill, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].message, /2 endpoint/);
  });
  it('all verified → none', () => {
    const skill = makeSkill({ endpoints: [makeEndpoint({ replayability: { tier: 'green', verified: true, signals: [] } })] });
    assert.deepEqual(unverifiedTier.scan(skill, CTX), []);
  });
});

describe('empty-skill', () => {
  it('zero endpoints → fixable junk, fix is quarantine', () => {
    const skill = makeSkill({ endpoints: [] });
    const [f] = emptySkill.scan(skill, CTX);
    assert.equal(f.severity, 'junk');
    assert.equal(f.fixable, true);
    assert.deepEqual(emptySkill.fix!(skill, f), { action: 'quarantine' });
  });
  it('non-empty → none', () => {
    assert.deepEqual(emptySkill.scan(makeSkill(), CTX), []);
  });
});

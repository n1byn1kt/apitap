// test/doctor/checks/beacon-endpoints.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { beaconEndpoints, isBeaconShaped } from '../../../src/doctor/checks/beacon-endpoints.js';
import { makeEndpoint, makeSkill } from '../fixtures.js';

const CTX = { now: new Date('2026-07-19T00:00:00.000Z'), staleDays: 90 };

const beacon = () => makeEndpoint({
  id: 'post-capi', method: 'POST', path: '/capi/meta',
  responseShape: { type: 'object' },          // no fields
  responseBytes: 0,
  examples: { request: { url: 'https://polymarket.com/capi/meta', headers: {} }, responsePreview: null },
});

describe('isBeaconShaped', () => {
  it('flags tracker path + contentless response', () => {
    assert.equal(isBeaconShaped(beacon()), true);
  });
  it('does NOT flag a data endpoint on a tracker-like path (has responseSchema)', () => {
    const ep = makeEndpoint({
      path: '/api/collect',
      responseSchema: { type: 'object', fields: { id: { type: 'number' } } },
    });
    assert.equal(isBeaconShaped(ep), false);
  });
  it('does NOT flag shipment tracking with real fields', () => {
    const ep = makeEndpoint({ path: '/api/track/12345', responseShape: { type: 'object', fields: ['status', 'eta'] } });
    assert.equal(isBeaconShaped(ep), false);
  });
  it('does NOT flag skeleton-provenance endpoints', () => {
    const ep = makeEndpoint({ path: '/collect', endpointProvenance: 'skeleton', responseShape: { type: 'object' } });
    assert.equal(isBeaconShaped(ep), false);
  });
  it('does not substring-match: /tracking is not the segment "track"', () => {
    const ep = makeEndpoint({ path: '/api/trackingnumbers', responseShape: { type: 'object' }, responseBytes: 0 });
    assert.equal(isBeaconShaped(ep), false);
  });
  it('flags contentless endpoint whose example URL host is blocklisted', () => {
    const ep = makeEndpoint({
      path: '/v1/events', responseShape: { type: 'object' }, responseBytes: 0,
      examples: { request: { url: 'https://api.mixpanel.com/v1/events', headers: {} }, responsePreview: null },
    });
    assert.equal(isBeaconShaped(ep), true);
  });
});

describe('beaconEndpoints check', () => {
  it('emits a fixable junk finding for beacons and a warn for path-only suspects', () => {
    const suspect = makeEndpoint({ id: 'get-collect', path: '/api/collect' }); // real fields → suspect only
    const skill = makeSkill({ endpoints: [makeEndpoint(), beacon(), suspect] });
    const findings = beaconEndpoints.scan(skill, CTX);
    const junk = findings.find(f => f.severity === 'junk')!;
    const warn = findings.find(f => f.severity === 'warn')!;
    assert.equal(junk.fixable, true);
    assert.deepEqual(junk.endpointKeys, [{ method: 'POST', path: '/capi/meta' }]);
    assert.equal(warn.fixable, false);
  });

  it('fix strips flagged endpoints and keeps the rest', () => {
    const skill = makeSkill({ endpoints: [makeEndpoint(), beacon()] });
    const [junk] = beaconEndpoints.scan(skill, CTX).filter(f => f.fixable);
    const plan = beaconEndpoints.fix!(skill, junk);
    assert.equal(plan.action, 'edit');
    if (plan.action === 'edit') {
      assert.equal(plan.skill.endpoints.length, 1);
      assert.equal(plan.skill.endpoints[0].path, '/api/items');
    }
  });

  it('fix escalates to quarantine when stripping would leave zero endpoints', () => {
    const skill = makeSkill({ endpoints: [beacon()] });
    const [junk] = beaconEndpoints.scan(skill, CTX).filter(f => f.fixable);
    assert.deepEqual(beaconEndpoints.fix!(skill, junk), { action: 'quarantine' });
  });

  it('clean skill → no findings', () => {
    assert.deepEqual(beaconEndpoints.scan(makeSkill(), CTX), []);
  });
});

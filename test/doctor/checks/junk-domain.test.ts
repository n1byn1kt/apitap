// test/doctor/checks/junk-domain.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { junkDomain } from '../../../src/doctor/checks/junk-domain.js';
import { makeEndpoint, makeSkill } from '../fixtures.js';

const CTX = { now: new Date('2026-07-19T00:00:00.000Z'), staleDays: 90 };

const beaconEp = () => makeEndpoint({
  method: 'POST', path: '/collect', responseShape: { type: 'object' }, responseBytes: 0,
  examples: { request: { url: 'https://x.example/collect', headers: {} }, responsePreview: null },
});

describe('junk-domain', () => {
  it('blocklisted domain (incl. subdomain of blocklist entry) → fixable junk', () => {
    const skill = makeSkill({ domain: 'cdn.segment.com', baseUrl: 'https://cdn.segment.com' });
    const [f] = junkDomain.scan(skill, CTX);
    assert.equal(f.severity, 'junk');
    assert.equal(f.fixable, true);
  });

  it('pattern domain with ALL endpoints beacon-shaped → fixable junk', () => {
    const skill = makeSkill({
      domain: '22af.captcha.awswaf.com', baseUrl: 'https://22af.captcha.awswaf.com',
      endpoints: [beaconEp()],
    });
    const [f] = junkDomain.scan(skill, CTX);
    assert.equal(f.severity, 'junk');
    assert.equal(f.fixable, true);
  });

  it('pattern domain with a real data endpoint → warn, report-only', () => {
    const skill = makeSkill({
      domain: 'api.adsystemtools.com', baseUrl: 'https://api.adsystemtools.com',
      endpoints: [beaconEp(), makeEndpoint()],
    });
    const [f] = junkDomain.scan(skill, CTX);
    assert.equal(f.severity, 'warn');
    assert.equal(f.fixable, false);
  });

  it('normal domain → no findings', () => {
    assert.deepEqual(junkDomain.scan(makeSkill(), CTX), []);
  });

  it('fix is quarantine', () => {
    const skill = makeSkill({ domain: 'cdn.segment.com', baseUrl: 'https://cdn.segment.com' });
    const [f] = junkDomain.scan(skill, CTX);
    assert.deepEqual(junkDomain.fix!(skill, f), { action: 'quarantine' });
  });
});

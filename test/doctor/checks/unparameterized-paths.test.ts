// test/doctor/checks/unparameterized-paths.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { unparameterizedPaths } from '../../../src/doctor/checks/unparameterized-paths.js';
import { makeEndpoint, makeSkill } from '../fixtures.js';

const CTX = { now: new Date('2026-07-19T00:00:00.000Z'), staleDays: 90 };

describe('unparameterized-paths', () => {
  it('flags >=3 siblings differing in one ID-like segment (resolved-market pattern)', () => {
    const skill = makeSkill({
      endpoints: [
        makeEndpoint({ id: 'm1', path: '/markets/btc-updown-15m-1770254100' }),
        makeEndpoint({ id: 'm2', path: '/markets/eth-updown-15m-1770254200' }),
        makeEndpoint({ id: 'm3', path: '/markets/sol-updown-15m-1770254300' }),
      ],
    });
    const findings = unparameterizedPaths.scan(skill, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].fixable, false);
    assert.match(findings[0].message, /3 sibling/);
    assert.match(findings[0].message, /GET \/markets\/\*/);
  });

  it('two siblings are not enough; already-parameterized paths never flag', () => {
    const two = makeSkill({
      endpoints: [
        makeEndpoint({ id: 'a', path: '/markets/1770254100' }),
        makeEndpoint({ id: 'b', path: '/markets/1770254200' }),
      ],
    });
    assert.deepEqual(unparameterizedPaths.scan(two, CTX), []);
    const param = makeSkill({ endpoints: [makeEndpoint({ path: '/markets/:id' })] });
    assert.deepEqual(unparameterizedPaths.scan(param, CTX), []);
  });

  it('static word segments never form a family', () => {
    const skill = makeSkill({
      endpoints: [
        makeEndpoint({ id: 'a', path: '/api/users' }),
        makeEndpoint({ id: 'b', path: '/api/teams' }),
        makeEndpoint({ id: 'c', path: '/api/orders' }),
      ],
    });
    assert.deepEqual(unparameterizedPaths.scan(skill, CTX), []);
  });
});

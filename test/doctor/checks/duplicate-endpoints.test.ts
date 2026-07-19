// test/doctor/checks/duplicate-endpoints.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { duplicateEndpoints } from '../../../src/doctor/checks/duplicate-endpoints.js';
import { makeEndpoint, makeSkill } from '../fixtures.js';

const CTX = { now: new Date('2026-07-19T00:00:00.000Z'), staleDays: 90 };

describe('duplicate-endpoints', () => {
  it('drops a strictly dominated duplicate (gamma-api pattern)', () => {
    const winner = makeEndpoint({
      id: 'get-events', path: '/events/:id',
      replayability: { tier: 'green', verified: true, signals: [] },
      responseSchema: { type: 'object', fields: { id: { type: 'number' } } },
      queryParams: { limit: { type: 'number', example: '10' } },
    });
    const loser = makeEndpoint({
      id: 'get-events-2', path: '/events/:eventId',   // same after normalizePath
      replayability: { tier: 'unknown', verified: false, signals: [] },
      queryParams: {},
    });
    const skill = makeSkill({ endpoints: [winner, loser] });
    const findings = duplicateEndpoints.scan(skill, CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fixable, true);
    assert.deepEqual(findings[0].endpointKeys, [{ method: 'GET', path: '/events/:eventId' }]);
    const plan = duplicateEndpoints.fix!(skill, findings[0]);
    assert.equal(plan.action, 'edit');
    if (plan.action === 'edit') {
      assert.equal(plan.skill.endpoints.length, 1);
      assert.equal(plan.skill.endpoints[0].path, '/events/:id');
    }
  });

  it('trailing-slash variants are the same group', () => {
    const a = makeEndpoint({ path: '/events/', replayability: { tier: 'green', verified: true, signals: [] } });
    const b = makeEndpoint({ path: '/events' });
    const findings = duplicateEndpoints.scan(makeSkill({ endpoints: [a, b] }), CTX);
    assert.equal(findings.length, 1);
  });

  it('NON-dominated duplicate (loser has a queryParam the winner lacks) → report-only', () => {
    const a = makeEndpoint({
      path: '/events/:id',
      replayability: { tier: 'green', verified: true, signals: [] },
      queryParams: {},
    });
    const b = makeEndpoint({
      path: '/events/:eventId',
      queryParams: { archived: { type: 'boolean', example: 'true' } }, // only copy of this param
    });
    const findings = duplicateEndpoints.scan(makeSkill({ endpoints: [a, b] }), CTX);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fixable, false);
  });

  it('loser with a requestBody the winner lacks → report-only', () => {
    const a = makeEndpoint({ method: 'POST', path: '/orders/:id', replayability: { tier: 'green', verified: true, signals: [] } });
    const b = makeEndpoint({
      method: 'POST', path: '/orders/:orderId',
      requestBody: { contentType: 'application/json', template: { qty: 1 } },
    });
    const findings = duplicateEndpoints.scan(makeSkill({ endpoints: [a, b] }), CTX);
    assert.equal(findings[0].fixable, false);
  });

  it('different methods are different groups; unique endpoints → no findings', () => {
    const a = makeEndpoint({ method: 'GET', path: '/events/:id' });
    const b = makeEndpoint({ method: 'POST', path: '/events/:id' });
    assert.deepEqual(duplicateEndpoints.scan(makeSkill({ endpoints: [a, b] }), CTX), []);
  });
});

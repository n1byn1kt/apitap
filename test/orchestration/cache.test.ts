import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCache } from '../../src/orchestration/cache.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(domain: string): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-07T12:00:00.000Z',
    baseUrl: `https://${domain}`,
    endpoints: [],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self',
  };
}

describe('SessionCache', () => {
  it('returns null for unknown domain', () => {
    const cache = new SessionCache();
    assert.equal(cache.get('unknown.com'), null);
    assert.equal(cache.has('unknown.com'), false);
  });

  it('stores and retrieves entries', () => {
    const cache = new SessionCache();
    const skill = makeSkill('example.com');
    cache.set('example.com', skill, 'disk');

    const entry = cache.get('example.com');
    assert.ok(entry);
    assert.equal(entry.domain, 'example.com');
    assert.equal(entry.skillFile, skill);
    assert.equal(entry.source, 'disk');
    assert.ok(entry.discoveredAt <= Date.now());
    assert.equal(cache.has('example.com'), true);
  });

  it('overwrites existing entry', () => {
    const cache = new SessionCache();
    cache.set('example.com', makeSkill('example.com'), 'disk');
    const updated = makeSkill('example.com');
    cache.set('example.com', updated, 'discovered');

    const entry = cache.get('example.com');
    assert.equal(entry!.source, 'discovered');
    assert.equal(entry!.skillFile, updated);
  });

  it('invalidates entry', () => {
    const cache = new SessionCache();
    cache.set('example.com', makeSkill('example.com'), 'disk');
    cache.invalidate('example.com');

    assert.equal(cache.get('example.com'), null);
    assert.equal(cache.has('example.com'), false);
  });

  it('invalidate on unknown domain is no-op', () => {
    const cache = new SessionCache();
    cache.invalidate('unknown.com'); // should not throw
  });

  it('lists all cached domains', () => {
    const cache = new SessionCache();
    cache.set('a.com', makeSkill('a.com'), 'disk');
    cache.set('b.com', makeSkill('b.com'), 'discovered');
    cache.set('c.com', makeSkill('c.com'), 'captured');

    const domains = cache.domains();
    assert.deepEqual(domains.sort(), ['a.com', 'b.com', 'c.com']);
  });

  it('domains returns empty array when cache is empty', () => {
    const cache = new SessionCache();
    assert.deepEqual(cache.domains(), []);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomainGeneratorMap } from '../../extension/src/multi-domain.js';

describe('multi-domain generator', () => {
  it('creates separate generators per domain', () => {
    const map = new DomainGeneratorMap();
    const g1 = map.getOrCreate('api.reddit.com');
    const g2 = map.getOrCreate('gql.reddit.com');
    assert.notStrictEqual(g1, g2);
    assert.equal(map.domains.length, 2);
  });

  it('reuses generator for same domain', () => {
    const map = new DomainGeneratorMap();
    const g1 = map.getOrCreate('api.reddit.com');
    const g2 = map.getOrCreate('api.reddit.com');
    assert.strictEqual(g1, g2);
    assert.equal(map.domains.length, 1);
  });

  it('returns all domains', () => {
    const map = new DomainGeneratorMap();
    map.getOrCreate('a.com');
    map.getOrCreate('b.com');
    map.getOrCreate('c.com');
    assert.deepEqual(map.domains, ['a.com', 'b.com', 'c.com']);
  });

  it('generates skill files for all domains', () => {
    const map = new DomainGeneratorMap();
    map.getOrCreate('a.com');
    map.getOrCreate('b.com');
    const skills = map.toSkillFiles();
    assert.equal(skills.length, 2);
    assert.equal(skills[0].domain, 'a.com');
    assert.equal(skills[1].domain, 'b.com');
  });

  it('totalEndpoints sums across all generators', () => {
    const map = new DomainGeneratorMap();
    // Just verify it returns a number (generators are empty)
    assert.equal(typeof map.totalEndpoints, 'number');
  });
});

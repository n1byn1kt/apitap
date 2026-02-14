// test/capture/parameterize.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parameterizePath, cleanFrameworkPath } from '../../src/capture/parameterize.js';

describe('parameterizePath', () => {
  it('replaces pure numeric segments with :id', () => {
    assert.equal(parameterizePath('/api/markets/123'), '/api/markets/:id');
    assert.equal(parameterizePath('/users/42/profile'), '/users/:id/profile');
    assert.equal(parameterizePath('/item/1770254100'), '/item/:id');
  });

  it('replaces UUID segments with :id', () => {
    assert.equal(
      parameterizePath('/users/550e8400-e29b-41d4-a716-446655440000/profile'),
      '/users/:id/profile',
    );
  });

  it('replaces hash-like segments (12+ alphanum with mixed letters+digits) with :hash', () => {
    assert.equal(
      parameterizePath('/_next/data/TjugEgeSUE4oCdg-1g2I1/en/tech.json'),
      '/_next/data/:hash/en/tech.json',
    );
  });

  it('replaces segments containing 8+ consecutive digits with :slug', () => {
    assert.equal(
      parameterizePath('/events/slug/btc-updown-15m-1770254100'),
      '/events/slug/:slug',
    );
    assert.equal(
      parameterizePath('/reports/report-20260204-summary'),
      '/reports/:slug',
    );
  });

  it('does not parameterize short or dictionary-like segments', () => {
    assert.equal(parameterizePath('/api/v1/markets'), '/api/v1/markets');
    assert.equal(parameterizePath('/en/tech'), '/en/tech');
    assert.equal(parameterizePath('/en/geopolitics'), '/en/geopolitics');
    assert.equal(parameterizePath('/sports/nfl/games/week'), '/sports/nfl/games/week');
  });

  it('does not parameterize short numeric segments when part of version', () => {
    // Pure numeric IS parameterized regardless of length
    assert.equal(parameterizePath('/api/v1/items/5'), '/api/v1/items/:id');
  });

  it('handles root path', () => {
    assert.equal(parameterizePath('/'), '/');
  });

  it('handles paths with no dynamic segments', () => {
    assert.equal(parameterizePath('/api/events'), '/api/events');
    assert.equal(parameterizePath('/teams'), '/teams');
  });

  it('handles multiple dynamic segments', () => {
    assert.equal(
      parameterizePath('/api/users/42/posts/99'),
      '/api/users/:id/posts/:id',
    );
  });
});

describe('cleanFrameworkPath', () => {
  it('strips _next/data/<hash>/ prefix and .json suffix', () => {
    assert.equal(
      cleanFrameworkPath('/_next/data/TjugEgeSUE4oCdg-1g2I1/en/tech.json'),
      '/en/tech',
    );
    assert.equal(
      cleanFrameworkPath('/_next/data/abc123/en/politics.json'),
      '/en/politics',
    );
  });

  it('strips .json suffix from any path', () => {
    assert.equal(cleanFrameworkPath('/api/data.json'), '/api/data');
  });

  it('does not modify non-framework paths', () => {
    assert.equal(cleanFrameworkPath('/api/markets'), '/api/markets');
    assert.equal(cleanFrameworkPath('/events/slug/foo'), '/events/slug/foo');
  });

  it('handles _next/data with deeply nested paths', () => {
    assert.equal(
      cleanFrameworkPath('/_next/data/HASH/en/sports/nfl/games/week/15.json'),
      '/en/sports/nfl/games/week/15',
    );
  });

  it('returns / for paths that are entirely framework noise', () => {
    assert.equal(cleanFrameworkPath('/_next/data/HASH/.json'), '/');
    assert.equal(cleanFrameworkPath('/.json'), '/');
  });
});

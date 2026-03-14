// test/capture/parameterize.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parameterizePath, cleanFrameworkPath } from '../../src/capture/parameterize.js';

describe('parameterizePath', () => {
  // --- Structural detection (layer 1) ---

  it('replaces pure numeric segments with :id', () => {
    assert.equal(parameterizePath('/api/markets/123'), '/api/markets/:id');
    // Large pure-numeric is still :id, not :slug (pure numeric takes priority)
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
    // "events" is a resource noun so "slug" fills its :event_id slot
    assert.equal(
      parameterizePath('/events/slug/btc-updown-15m-1770254100'),
      '/events/:event_id/:slug',
    );
    assert.equal(
      parameterizePath('/reports/report-20260204-summary'),
      '/reports/:slug',
    );
  });

  // --- Context-aware parameterization (layer 2) ---

  it('parameterizes segments after resource nouns with semantic names', () => {
    assert.equal(parameterizePath('/repos/n1byn1kt/apitap'), '/repos/:owner/:repo');
    assert.equal(parameterizePath('/users/jaromir/gists'), '/users/:username/gists');
    assert.equal(parameterizePath('/orgs/anthropic/repos'), '/orgs/:org/repos');
  });

  it('uses noun-derived names for numeric IDs after resource nouns', () => {
    assert.equal(parameterizePath('/v2/posts/42/comments'), '/v2/posts/:post_id/comments');
    assert.equal(parameterizePath('/users/42/profile'), '/users/:username/profile');
    assert.equal(parameterizePath('/api/v1/items/5'), '/api/v1/items/:item_id');
    assert.equal(parameterizePath('/comments/99/replies'), '/comments/:comment_id/replies');
  });

  it('handles multi-slot nouns (repos → :owner/:repo)', () => {
    assert.equal(
      parameterizePath('/repos/n1byn1kt/apitap/issues/42/comments'),
      '/repos/:owner/:repo/issues/:issue_number/comments',
    );
  });

  it('parameterizes non-word slugs after resource nouns', () => {
    assert.equal(parameterizePath('/v2/media/OxItOzEC'), '/v2/media/:media_id');
    assert.equal(parameterizePath('/v2/playlists/NrrarSpF'), '/v2/playlists/:playlist_id');
  });

  // --- Structural preservation ---

  it('does not parameterize structural segments', () => {
    assert.equal(parameterizePath('/api/v1/search'), '/api/v1/search');
    assert.equal(parameterizePath('/api/v9/auth/location-metadata'), '/api/v9/auth/location-metadata');
    assert.equal(parameterizePath('/health'), '/health');
    assert.equal(parameterizePath('/en/tech'), '/en/tech');
    assert.equal(parameterizePath('/en/geopolitics'), '/en/geopolitics');
    assert.equal(parameterizePath('/sports/nfl/games/week'), '/sports/nfl/games/week');
  });

  it('preserves version-like segments that contain dots', () => {
    assert.equal(parameterizePath('/2.3/questions'), '/2.3/questions');
  });

  // --- Edge cases ---

  it('handles root path', () => {
    assert.equal(parameterizePath('/'), '/');
  });

  it('handles paths with no dynamic segments', () => {
    assert.equal(parameterizePath('/api/events'), '/api/events');
    assert.equal(parameterizePath('/teams'), '/teams');
  });

  it('handles multiple resource nouns in one path', () => {
    assert.equal(
      parameterizePath('/api/users/42/posts/99'),
      '/api/users/:username/posts/:post_id',
    );
  });

  it('resets noun slots when a structural segment interrupts', () => {
    // "search" is structural, so it resets any queued slots from "repos"
    assert.equal(
      parameterizePath('/repos/search'),
      '/repos/search',
    );
  });

  it('falls back to :id for non-word segments after structural prefixes', () => {
    assert.equal(
      parameterizePath('/api/v1/ABC-123'),
      '/api/v1/:id',
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

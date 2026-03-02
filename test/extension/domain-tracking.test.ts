import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the domain extraction logic (pure function, no Chrome APIs)
import { extractDomain, pickPrimaryDomain } from '../../extension/src/domain-utils.js';

describe('extension domain tracking', () => {
  it('extracts domain from URL', () => {
    assert.equal(extractDomain('https://api.reddit.com/api/v1/me'), 'api.reddit.com');
  });

  it('returns null for invalid URLs', () => {
    assert.equal(extractDomain('not-a-url'), null);
    assert.equal(extractDomain(''), null);
  });

  it('picks the most frequent API domain', () => {
    const domains = ['gql.reddit.com', 'gql.reddit.com', 'oauth.reddit.com', 's.reddit.com'];
    assert.equal(pickPrimaryDomain(domains), 'gql.reddit.com');
  });

  it('picks first seen domain when tied', () => {
    const domains = ['api.a.com', 'api.b.com'];
    assert.equal(pickPrimaryDomain(domains), 'api.a.com');
  });

  it('returns null for empty list', () => {
    assert.equal(pickPrimaryDomain([]), null);
  });
});

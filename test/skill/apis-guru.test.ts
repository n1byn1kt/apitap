// test/skill/apis-guru.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseApisGuruList, filterEntries } from '../../src/skill/apis-guru.js';
import type { ApisGuruEntry } from '../../src/skill/apis-guru.js';

describe('parseApisGuruList', () => {
  it('parses raw list into entries', () => {
    const raw = {
      'stripe.com': {
        preferred: '2023-10-16',
        versions: {
          '2023-10-16': {
            info: { title: 'Stripe API', 'x-providerName': 'stripe.com' },
            swaggerUrl: 'https://x/stripe.json',
            openapiVer: '3.0.0',
            updated: '2024-01-01',
          },
        },
      },
    };
    const result = parseApisGuruList(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].apiId, 'stripe.com');
    assert.strictEqual(result[0].providerName, 'stripe.com');
    assert.strictEqual(result[0].title, 'Stripe API');
    assert.strictEqual(result[0].specUrl, 'https://x/stripe.json');
    assert.strictEqual(result[0].openapiVer, '3.0.0');
    assert.strictEqual(result[0].updated, '2024-01-01');
  });

  it('skips entries without swaggerUrl', () => {
    const raw = {
      'bad.com': {
        preferred: '1.0',
        versions: { '1.0': { info: { title: 'Bad' } } },
      },
    };
    assert.strictEqual(parseApisGuruList(raw).length, 0);
  });

  it('handles multi-service apiId (provider:service)', () => {
    const raw = {
      'twilio.com:api': {
        preferred: '1.0',
        versions: {
          '1.0': {
            info: { title: 'Twilio API', 'x-providerName': 'twilio.com' },
            swaggerUrl: 'https://x/twilio.json',
            openapiVer: '3.0.0',
            updated: '2024-01-02',
          },
        },
      },
    };
    const result = parseApisGuruList(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].apiId, 'twilio.com:api');
    assert.strictEqual(result[0].providerName, 'twilio.com');
  });

  it('falls back to apiId split for providerName when x-providerName absent', () => {
    const raw = {
      'example.com:v1': {
        preferred: '1.0',
        versions: {
          '1.0': {
            info: { title: 'Example API' },
            swaggerUrl: 'https://x/example.json',
            openapiVer: '2.0',
            updated: '2024-01-03',
          },
        },
      },
    };
    const result = parseApisGuruList(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].providerName, 'example.com');
  });

  it('falls back to apiId as providerName when no colon', () => {
    const raw = {
      'example.com': {
        preferred: '1.0',
        versions: {
          '1.0': {
            info: { title: 'Example API' },
            swaggerUrl: 'https://x/example.json',
            openapiVer: '2.0',
            updated: '2024-01-03',
          },
        },
      },
    };
    const result = parseApisGuruList(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].providerName, 'example.com');
  });

  it('skips entries where preferred version is missing from versions', () => {
    const raw = {
      'missing.com': {
        preferred: 'v99',
        versions: {
          'v1': {
            info: { title: 'Missing' },
            swaggerUrl: 'https://x/missing.json',
            openapiVer: '2.0',
            updated: '2024-01-01',
          },
        },
      },
    };
    assert.strictEqual(parseApisGuruList(raw).length, 0);
  });

  it('handles empty raw object', () => {
    assert.strictEqual(parseApisGuruList({}).length, 0);
  });

  it('parses multiple entries', () => {
    const raw = {
      'alpha.com': {
        preferred: '1',
        versions: {
          '1': {
            info: { title: 'Alpha', 'x-providerName': 'alpha.com' },
            swaggerUrl: 'https://x/alpha.json',
            openapiVer: '3.0.0',
            updated: '2024-03-01',
          },
        },
      },
      'beta.com': {
        preferred: '2',
        versions: {
          '2': {
            info: { title: 'Beta', 'x-providerName': 'beta.com' },
            swaggerUrl: 'https://x/beta.json',
            openapiVer: '2.0',
            updated: '2024-02-01',
          },
        },
      },
    };
    const result = parseApisGuruList(raw);
    assert.strictEqual(result.length, 2);
  });
});

describe('filterEntries', () => {
  const entries: ApisGuruEntry[] = [
    {
      apiId: 'stripe.com',
      providerName: 'stripe.com',
      title: 'Stripe API',
      specUrl: 'https://x/stripe.json',
      openapiVer: '3.0.0',
      updated: '2024-03-01',
    },
    {
      apiId: 'twilio.com:api',
      providerName: 'twilio.com',
      title: 'Twilio API',
      specUrl: 'https://x/twilio.json',
      openapiVer: '3.0.1',
      updated: '2024-01-01',
    },
    {
      apiId: 'petstore.swagger.io',
      providerName: 'petstore.swagger.io',
      title: 'Petstore',
      specUrl: 'https://x/petstore.json',
      openapiVer: '2.0',
      updated: '2023-06-01',
    },
    {
      apiId: 'github.com',
      providerName: 'github.com',
      title: 'GitHub v3 REST API',
      specUrl: 'https://x/github.json',
      openapiVer: '3.0.3',
      updated: '2024-02-15',
    },
  ];

  it('returns all entries when no options', () => {
    const result = filterEntries(entries, {});
    assert.strictEqual(result.length, 4);
  });

  it('filters by search substring on providerName', () => {
    const result = filterEntries(entries, { search: 'twilio' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].apiId, 'twilio.com:api');
  });

  it('filters by search substring on title', () => {
    const result = filterEntries(entries, { search: 'Petstore' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].apiId, 'petstore.swagger.io');
  });

  it('search is case-insensitive', () => {
    const result = filterEntries(entries, { search: 'STRIPE' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].providerName, 'stripe.com');
  });

  it('applies limit', () => {
    const result = filterEntries(entries, { limit: 2 });
    assert.strictEqual(result.length, 2);
  });

  it('returns empty array when search matches nothing', () => {
    const result = filterEntries(entries, { search: 'nonexistent-xyz' });
    assert.strictEqual(result.length, 0);
  });

  it('sorts OpenAPI 3.x entries before 2.x when preferOpenapi3 is true', () => {
    const result = filterEntries(entries, { preferOpenapi3: true });
    const versions = result.map(e => e.openapiVer);
    const firstNon3Index = versions.findIndex(v => !v.startsWith('3'));
    const last3Index = versions.map((v, i) => v.startsWith('3') ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
    // All 3.x entries must come before any 2.x entries
    assert.ok(firstNon3Index === -1 || last3Index < firstNon3Index,
      `3.x entries should precede 2.x entries. Got versions: ${versions.join(', ')}`);
  });

  it('within same openapi version group sorts by recency (updated desc)', () => {
    const result = filterEntries(entries, { preferOpenapi3: true });
    // All 3.x entries: stripe (2024-03-01), github (2024-02-15), twilio (2024-01-01)
    const threeX = result.filter(e => e.openapiVer.startsWith('3'));
    const dates = threeX.map(e => e.updated);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(dates, sorted);
  });

  it('sorts by recency when preferOpenapi3 is false', () => {
    const result = filterEntries(entries, { preferOpenapi3: false });
    const dates = result.map(e => e.updated);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(dates, sorted);
  });

  it('applies limit after sorting', () => {
    const result = filterEntries(entries, { preferOpenapi3: true, limit: 2 });
    assert.strictEqual(result.length, 2);
    // Both should be 3.x
    assert.ok(result.every(e => e.openapiVer.startsWith('3')));
  });

  it('combines search and limit', () => {
    // 'API' matches stripe, twilio, github (not petstore title 'Petstore')
    const result = filterEntries(entries, { search: 'API', limit: 2 });
    assert.strictEqual(result.length, 2);
  });
});

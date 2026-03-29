import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnownSpecs, type KnownSpec } from '../../src/known-specs-loader.js';

describe('known-specs.json', () => {
  let specs: KnownSpec[];

  it('loads known-specs.json without error', () => {
    specs = loadKnownSpecs();
    assert.ok(Array.isArray(specs));
  });

  it('contains at least 25 entries', () => {
    specs = loadKnownSpecs();
    assert.ok(specs.length >= 25, `expected >= 25 entries, got ${specs.length}`);
  });

  it('every entry has required fields', () => {
    specs = loadKnownSpecs();
    for (const spec of specs) {
      assert.ok(typeof spec.provider === 'string' && spec.provider.length > 0, `missing provider: ${JSON.stringify(spec)}`);
      assert.ok(typeof spec.specUrl === 'string' && spec.specUrl.length > 0, `missing specUrl for ${spec.provider}`);
      assert.ok(typeof spec.notes === 'string' && spec.notes.length > 0, `missing notes for ${spec.provider}`);
      assert.ok(typeof spec.repo === 'string', `missing repo for ${spec.provider}`);
      assert.ok(typeof spec.specPath === 'string', `missing specPath for ${spec.provider}`);
    }
  });

  it('every specUrl uses https', () => {
    specs = loadKnownSpecs();
    for (const spec of specs) {
      assert.ok(spec.specUrl.startsWith('https://'), `specUrl for ${spec.provider} must use https: ${spec.specUrl}`);
    }
  });

  it('no duplicate providers', () => {
    specs = loadKnownSpecs();
    const providers = specs.map(s => s.provider.toLowerCase());
    const unique = new Set(providers);
    assert.strictEqual(unique.size, providers.length, `duplicate providers found`);
  });

  it('contains the 7 providers from issue #43', () => {
    specs = loadKnownSpecs();
    const providers = new Set(specs.map(s => s.provider.toLowerCase()));
    for (const required of ['cloudflare', 'discord', 'figma', 'pagerduty', 'sentry', 'datadog', 'okta']) {
      assert.ok(providers.has(required), `missing required provider: ${required}`);
    }
  });

  it('query filtering works case-insensitively', () => {
    specs = loadKnownSpecs();
    const filtered = specs.filter(s => s.provider.toLowerCase().includes('stripe'));
    assert.ok(filtered.length >= 1, 'expected at least 1 match for "stripe"');
    assert.strictEqual(filtered[0].provider, 'Stripe');
  });

  it('query filtering returns empty for non-existent provider', () => {
    specs = loadKnownSpecs();
    const filtered = specs.filter(s => s.provider.toLowerCase().includes('nonexistentprovider999'));
    assert.strictEqual(filtered.length, 0);
  });
});

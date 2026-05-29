// test/security/ipv6-literal-ssrf.test.ts
// IPv6 literal hosts must be validated against reserved ranges by BOTH the
// sync check and the DNS-resolving check (which previously short-circuited
// any bracketed host to "safe").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, resolveAndValidateUrl } from '../../src/skill/ssrf.js';

const BLOCKED = [
  ['http://[::]/', 'unspecified (::)'],
  ['http://[::1]/', 'loopback (::1)'],
  ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
  ['http://[fe80::1]/', 'link-local'],
  ['http://[fd00::1]/', 'unique-local'],
  ['http://[64:ff9b::7f00:1]/', 'NAT64 embedding 127.0.0.1'],
  ['http://[fec0::1]/', 'deprecated site-local'],
] as const;

const ALLOWED = [
  'http://[2606:4700:4700::1111]/', // Cloudflare public DNS
  'http://[2001:4860:4860::8888]/', // Google public DNS
] as const;

describe('IPv6 literal SSRF — sync validateUrl', () => {
  for (const [url, label] of BLOCKED) {
    it(`blocks ${label}: ${url}`, () => {
      assert.equal(validateUrl(url).safe, false, `${url} must be blocked`);
    });
  }

  for (const url of ALLOWED) {
    it(`allows public IPv6 literal ${url}`, () => {
      assert.equal(validateUrl(url).safe, true, `${url} must be allowed`);
    });
  }
});

describe('IPv6 literal SSRF — resolveAndValidateUrl (no short-circuit)', () => {
  for (const [url, label] of BLOCKED) {
    it(`blocks ${label}: ${url}`, async () => {
      const result = await resolveAndValidateUrl(url);
      assert.equal(result.safe, false, `${url} must be blocked by the resolving check too`);
    });
  }

  for (const url of ALLOWED) {
    it(`allows public IPv6 literal ${url}`, async () => {
      const result = await resolveAndValidateUrl(url);
      assert.equal(result.safe, true, `${url} must be allowed`);
    });
  }
});

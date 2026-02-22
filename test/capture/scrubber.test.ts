// test/capture/scrubber.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubPII } from '../../src/capture/scrubber.js';

describe('scrubPII', () => {
  it('redacts email addresses', () => {
    assert.equal(scrubPII('contact john@example.com today'), 'contact [email] today');
    assert.equal(scrubPII('user+tag@sub.domain.co.uk'), '[email]');
  });

  it('redacts international phone numbers with + prefix', () => {
    assert.equal(scrubPII('call +14155551234'), 'call [phone]');
    assert.equal(scrubPII('fax +442071234567'), 'fax [phone]');
  });

  it('redacts US phone numbers with separators', () => {
    assert.equal(scrubPII('call (415) 555-1234'), 'call [phone]');
    assert.equal(scrubPII('call 415-555-1234'), 'call [phone]');
    assert.equal(scrubPII('call 415.555.1234'), 'call [phone]');
  });

  it('does NOT redact bare digit sequences (avoids false positives)', () => {
    assert.equal(scrubPII('order 12345678'), 'order 12345678');
    assert.equal(scrubPII('timestamp 1706000000000'), 'timestamp 1706000000000');
    assert.equal(scrubPII('product SKU-99887766'), 'product SKU-99887766');
  });

  it('redacts IPv4 addresses with valid octets', () => {
    assert.equal(scrubPII('server at 192.168.1.1'), 'server at [ip]');
    assert.equal(scrubPII('from 10.0.0.1 to 172.16.0.1'), 'from [ip] to [ip]');
  });

  it('does NOT redact version-like strings with octets > 255', () => {
    assert.equal(scrubPII('version 1.2.3.4'), 'version [ip]');
    assert.equal(scrubPII('build 999.999.999.999'), 'build 999.999.999.999');
  });

  it('redacts credit card numbers', () => {
    assert.equal(scrubPII('card 4111-1111-1111-1111'), 'card [card]');
    assert.equal(scrubPII('card 4111 1111 1111 1111'), 'card [card]');
    assert.equal(scrubPII('card 4111111111111111'), 'card [card]');
  });

  it('redacts US SSNs', () => {
    assert.equal(scrubPII('ssn 123-45-6789'), 'ssn [ssn]');
  });

  it('handles multiple PII types in one string', () => {
    const input = 'user john@test.com from 192.168.1.1 card 4111111111111111';
    const result = scrubPII(input);
    assert.equal(result, 'user [email] from [ip] card [card]');
  });

  it('returns strings without PII unchanged', () => {
    assert.equal(scrubPII('/api/v1/markets'), '/api/v1/markets');
    assert.equal(scrubPII('limit=10&offset=20'), 'limit=10&offset=20');
    assert.equal(scrubPII(''), '');
  });

  it('redacts bearer and JWT tokens', () => {
    assert.equal(scrubPII('Authorization: Bearer abc.def.ghi'), 'Authorization: [token]');
    assert.equal(scrubPII('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123'), 'token=[token]');
  });
});

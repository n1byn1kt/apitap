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

  it('redacts provider-prefixed API keys and tokens', () => {
    // Tokens are assembled at runtime (prefix + body) so these synthetic
    // fixtures don't trip GitHub push-protection secret scanning while still
    // exercising the scrubber patterns.
    const stripeSk = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
    const stripePk = 'pk_' + 'live_' + 'abcDEF123456ghiJKL789012';
    const ghp = 'ghp_' + '16C7e42F292c6912E7710c838347Ae178B4a';
    const gho = 'gho_' + '16C7e42F292c6912E7710c838347Ae178B4a';
    const slack = 'xoxb-' + '2345678901-2345678901234-AbCdEfGhIjKlMnOpQr';
    const gitlab = 'glpat-' + 'AbCdEf12345678901234';
    assert.equal(scrubPII('key ' + stripeSk), 'key [token]');
    assert.equal(scrubPII('pub ' + stripePk), 'pub [token]');
    assert.equal(scrubPII('gh ' + ghp), 'gh [token]');
    assert.equal(scrubPII('gh ' + gho), 'gh [token]');
    assert.equal(scrubPII('slack ' + slack), 'slack [token]');
    assert.equal(scrubPII('gl ' + gitlab), 'gl [token]');
  });

  it('redacts IBANs', () => {
    assert.equal(scrubPII('iban DE89370400440532013000 ok'), 'iban [iban] ok');
    assert.equal(scrubPII('GB29NWBK60161331926819'), '[iban]');
  });

  it('redacts IPv6 addresses', () => {
    assert.equal(scrubPII('host 2001:db8::1 here'), 'host [ip] here');
    assert.equal(scrubPII('fe80::1ff:fe23:4567:890a'), '[ip]');
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

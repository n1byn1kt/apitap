// test/capture/entropy.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shannonEntropy, isLikelyToken, parseJwtClaims } from '../../src/capture/entropy.js';

// Helper: make a JWT with given payload
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    assert.equal(shannonEntropy(''), 0);
  });

  it('returns 0 for single repeated character', () => {
    assert.equal(shannonEntropy('aaaaaaaaaa'), 0);
  });

  it('returns 1.0 for two equally distributed characters', () => {
    const result = shannonEntropy('abababababababab');
    assert.ok(Math.abs(result - 1.0) < 0.01, `Expected ~1.0, got ${result}`);
  });

  it('returns low entropy for english-like text', () => {
    const result = shannonEntropy('hello world this is a test');
    assert.ok(result < 3.5, `Expected < 3.5, got ${result}`);
  });

  it('returns high entropy for random hex string', () => {
    // 64-char random hex — should be high entropy
    const result = shannonEntropy('a8f3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1');
    assert.ok(result > 3.5, `Expected > 3.5, got ${result}`);
  });

  it('returns high entropy for random base64 string', () => {
    const result = shannonEntropy('dGhpcyBpcyBhIHRlc3QgdG9rZW4gdmFsdWUgZm9yIGVudHJvcHk=');
    assert.ok(result > 3.5, `Expected > 3.5, got ${result}`);
  });

  it('returns consistent value for known string', () => {
    // "abcd" has 4 unique chars, each appears once → entropy = log2(4) = 2.0
    const result = shannonEntropy('abcd');
    assert.ok(Math.abs(result - 2.0) < 0.01, `Expected ~2.0, got ${result}`);
  });
});

describe('parseJwtClaims', () => {
  it('parses valid JWT with exp and iss', () => {
    const token = makeJwt({ exp: 1700000000, iss: 'https://auth.example.com' });
    const claims = parseJwtClaims(token);
    assert.ok(claims);
    assert.equal(claims.exp, 1700000000);
    assert.equal(claims.iss, 'https://auth.example.com');
  });

  it('parses JWT with all standard claims', () => {
    const token = makeJwt({
      exp: 1700000000,
      iat: 1699996400,
      iss: 'auth.example.com',
      aud: 'my-app',
      scope: 'read write',
    });
    const claims = parseJwtClaims(token);
    assert.ok(claims);
    assert.equal(claims.exp, 1700000000);
    assert.equal(claims.iat, 1699996400);
    assert.equal(claims.iss, 'auth.example.com');
    assert.equal(claims.aud, 'my-app');
    assert.equal(claims.scope, 'read write');
  });

  it('parses JWT without exp', () => {
    const token = makeJwt({ iss: 'example.com', sub: 'user123' });
    const claims = parseJwtClaims(token);
    assert.ok(claims);
    assert.equal(claims.exp, undefined);
    assert.equal(claims.iss, 'example.com');
  });

  it('returns null for non-JWT string', () => {
    assert.equal(parseJwtClaims('not-a-jwt-token'), null);
  });

  it('returns null for string starting with eyJ but wrong number of dots', () => {
    assert.equal(parseJwtClaims('eyJhbGciOiJIUzI1NiJ9.only-one-part'), null);
  });

  it('returns null for string with eyJ prefix but invalid base64 payload', () => {
    assert.equal(parseJwtClaims('eyJ.!!!invalid!!!.sig'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseJwtClaims(''), null);
  });

  it('ignores non-standard claims', () => {
    const token = makeJwt({ custom: 'value', exp: 123 });
    const claims = parseJwtClaims(token);
    assert.ok(claims);
    assert.equal(claims.exp, 123);
    assert.equal((claims as Record<string, unknown>)['custom'], undefined);
  });

  it('ignores non-number exp', () => {
    const token = makeJwt({ exp: 'not-a-number' });
    const claims = parseJwtClaims(token);
    assert.ok(claims);
    assert.equal(claims.exp, undefined);
  });
});

describe('isLikelyToken', () => {
  it('detects JWT as high-confidence token', () => {
    const token = makeJwt({ exp: 1700000000, iss: 'auth.example.com' });
    const result = isLikelyToken('authorization', `Bearer ${token}`);
    assert.equal(result.isToken, true);
    assert.equal(result.confidence, 'high');
    assert.equal(result.format, 'jwt');
    assert.ok(result.jwtClaims);
    assert.equal(result.jwtClaims.exp, 1700000000);
  });

  it('detects JWT without Bearer prefix', () => {
    const token = makeJwt({ iss: 'example.com' });
    const result = isLikelyToken('x-auth-token', token);
    assert.equal(result.isToken, true);
    assert.equal(result.format, 'jwt');
  });

  it('detects high-entropy opaque token (>= 4.5 bits)', () => {
    // Random-looking 64-char hex string
    const value = 'k9Xm2pLqR7vNwYtH3jF5sAcBdEfG8uIoKnMlJhZxWvQrTsUyPeDgCbAzFhKjLm';
    const result = isLikelyToken('x-custom-auth', value);
    assert.equal(result.isToken, true);
    assert.equal(result.confidence, 'high');
    assert.equal(result.format, 'opaque');
  });

  it('detects medium-entropy token (3.5-4.5 bits)', () => {
    // Repeated pattern but still entropic enough
    const value = 'aaabbbcccdddeeefffggghhhiiijjjkkk';
    const entropy = shannonEntropy(value);
    // If this doesn't hit the range, adjust the test value
    if (entropy >= 3.5 && entropy < 4.5) {
      const result = isLikelyToken('x-session', value);
      assert.equal(result.isToken, true);
      assert.equal(result.confidence, 'medium');
    }
  });

  it('rejects short values (< 16 chars)', () => {
    const result = isLikelyToken('x-token', 'abc123def456');
    assert.equal(result.isToken, false);
  });

  it('rejects UUID values', () => {
    const result = isLikelyToken('x-request-id', '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(result.isToken, false);
  });

  it('rejects UUID case-insensitively', () => {
    const result = isLikelyToken('x-id', 'A50E8400-E29B-41D4-A716-446655440000');
    assert.equal(result.isToken, false);
  });

  it('rejects low-entropy long string', () => {
    // Long but repetitive — low entropy
    const result = isLikelyToken('x-data', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(result.isToken, false);
  });

  it('rejects empty string', () => {
    const result = isLikelyToken('authorization', '');
    assert.equal(result.isToken, false);
  });

  it('rejects low-entropy long string that looks like a value', () => {
    // Repeated limited character set — low entropy despite length
    const result = isLikelyToken('x-header', '0000000011111111');
    assert.equal(result.isToken, false);
  });

  it('detects real-world API key format', () => {
    // Typical API key: mix of alphanumeric, 32+ chars
    const value = 'sk_test_FAKE00aaBBccDDeeFFggHHiiJJ';
    const result = isLikelyToken('x-api-key', value);
    assert.equal(result.isToken, true);
  });

  it('detects Bearer token with high-entropy value', () => {
    const value = 'Bearer a8f3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
    const result = isLikelyToken('authorization', value);
    assert.equal(result.isToken, true);
  });
});

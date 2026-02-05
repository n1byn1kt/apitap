// test/auth/crypto.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, deriveKey, hmacSign, hmacVerify } from '../../src/auth/crypto.js';

describe('crypto', () => {
  describe('encrypt/decrypt roundtrip', () => {
    it('encrypts and decrypts data', () => {
      const key = deriveKey('test-machine-id');
      const plaintext = JSON.stringify({ authorization: 'Bearer tok123' });
      const encrypted = encrypt(plaintext, key);

      assert.ok(encrypted.iv, 'should have IV');
      assert.ok(encrypted.ciphertext, 'should have ciphertext');
      assert.ok(encrypted.tag, 'should have auth tag');
      assert.ok(encrypted.salt, 'should have salt');

      const decrypted = decrypt(encrypted, key);
      assert.equal(decrypted, plaintext);
    });

    it('produces different ciphertext for same input (random IV)', () => {
      const key = deriveKey('test-machine-id');
      const plaintext = 'same data';
      const a = encrypt(plaintext, key);
      const b = encrypt(plaintext, key);
      assert.notEqual(a.ciphertext, b.ciphertext);
    });

    it('fails to decrypt with wrong key', () => {
      const key1 = deriveKey('machine-1');
      const key2 = deriveKey('machine-2');
      const encrypted = encrypt('secret', key1);

      assert.throws(() => decrypt(encrypted, key2));
    });
  });

  describe('deriveKey', () => {
    it('produces deterministic keys from same input', () => {
      const a = deriveKey('test-id');
      const b = deriveKey('test-id');
      assert.deepEqual(a, b);
    });

    it('produces different keys from different input', () => {
      const a = deriveKey('id-1');
      const b = deriveKey('id-2');
      assert.notDeepEqual(a, b);
    });
  });

  describe('HMAC signing', () => {
    it('signs and verifies data', () => {
      const key = deriveKey('test-id');
      const data = '{"domain":"example.com"}';
      const sig = hmacSign(data, key);

      assert.ok(sig.startsWith('hmac-sha256:'));
      assert.equal(hmacVerify(data, sig, key), true);
    });

    it('rejects tampered data', () => {
      const key = deriveKey('test-id');
      const sig = hmacSign('original', key);
      assert.equal(hmacVerify('tampered', sig, key), false);
    });

    it('rejects wrong key', () => {
      const key1 = deriveKey('id-1');
      const key2 = deriveKey('id-2');
      const sig = hmacSign('data', key1);
      assert.equal(hmacVerify('data', sig, key2), false);
    });
  });
});

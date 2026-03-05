// test/auth/key-separation.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveKey, deriveEncryptionKey, deriveSigningKey, encrypt, decrypt } from '../../src/auth/crypto.js';

let testDir: string;
let saltFile: string;

describe('Key separation', () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-keysep-'));
    saltFile = join(testDir, 'install-salt');
    await writeFile(saltFile, 'test-salt-value', { mode: 0o600 });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('deriveEncryptionKey and deriveSigningKey exist and return Buffers', () => {
    const encKey = deriveEncryptionKey('test-machine', saltFile);
    const sigKey = deriveSigningKey('test-machine', saltFile);
    assert.ok(Buffer.isBuffer(encKey));
    assert.ok(Buffer.isBuffer(sigKey));
  });

  it('encryption and signing keys differ from each other', () => {
    const encKey = deriveEncryptionKey('test-machine', saltFile);
    const sigKey = deriveSigningKey('test-machine', saltFile);
    assert.ok(!encKey.equals(sigKey), 'Encryption and signing keys must differ');
  });

  it('derived keys differ from the master key', () => {
    const master = deriveKey('test-machine', saltFile);
    const encKey = deriveEncryptionKey('test-machine', saltFile);
    const sigKey = deriveSigningKey('test-machine', saltFile);
    assert.ok(!master.equals(encKey), 'Encryption key must differ from master');
    assert.ok(!master.equals(sigKey), 'Signing key must differ from master');
  });

  it('derived keys are deterministic', () => {
    const enc1 = deriveEncryptionKey('test-machine', saltFile);
    const enc2 = deriveEncryptionKey('test-machine', saltFile);
    const sig1 = deriveSigningKey('test-machine', saltFile);
    const sig2 = deriveSigningKey('test-machine', saltFile);
    assert.ok(enc1.equals(enc2));
    assert.ok(sig1.equals(sig2));
  });

  it('derived keys are 32 bytes', () => {
    const encKey = deriveEncryptionKey('test-machine', saltFile);
    const sigKey = deriveSigningKey('test-machine', saltFile);
    assert.equal(encKey.length, 32);
    assert.equal(sigKey.length, 32);
  });

  it('data encrypted with old deriveKey can be decrypted with deriveKey (backward compat)', () => {
    const oldKey = deriveKey('test-machine', saltFile);
    const encrypted = encrypt('secret-data', oldKey);
    const decrypted = decrypt(encrypted, oldKey);
    assert.equal(decrypted, 'secret-data');
  });

  it('data encrypted with deriveEncryptionKey works', () => {
    const encKey = deriveEncryptionKey('test-machine', saltFile);
    const encrypted = encrypt('secret-data', encKey);
    const decrypted = decrypt(encrypted, encKey);
    assert.equal(decrypted, 'secret-data');
  });
});

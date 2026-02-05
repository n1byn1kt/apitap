// test/auth/manager.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../../src/auth/manager.js';
import type { StoredAuth } from '../../src/types.js';

describe('AuthManager', () => {
  let testDir: string;
  let manager: AuthManager;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth-'));
    manager = new AuthManager(testDir, 'test-machine-id');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('stores and retrieves auth for a domain', async () => {
    const auth: StoredAuth = {
      type: 'bearer',
      header: 'authorization',
      value: 'Bearer tok123',
    };
    await manager.store('api.example.com', auth);
    const retrieved = await manager.retrieve('api.example.com');
    assert.deepEqual(retrieved, auth);
  });

  it('returns null for unknown domain', async () => {
    const result = await manager.retrieve('unknown.com');
    assert.equal(result, null);
  });

  it('overwrites auth for same domain', async () => {
    await manager.store('example.com', {
      type: 'bearer',
      header: 'authorization',
      value: 'Bearer old',
    });
    await manager.store('example.com', {
      type: 'api-key',
      header: 'x-api-key',
      value: 'new-key',
    });

    const retrieved = await manager.retrieve('example.com');
    assert.equal(retrieved!.value, 'new-key');
  });

  it('stores auth for multiple domains', async () => {
    await manager.store('a.com', { type: 'bearer', header: 'authorization', value: 'a' });
    await manager.store('b.com', { type: 'api-key', header: 'x-api-key', value: 'b' });

    assert.equal((await manager.retrieve('a.com'))!.value, 'a');
    assert.equal((await manager.retrieve('b.com'))!.value, 'b');
  });

  it('creates auth file with restrictive permissions', async () => {
    await manager.store('example.com', { type: 'bearer', header: 'authorization', value: 'x' });
    const authPath = join(testDir, 'auth.enc');
    const stats = await stat(authPath);
    // 0o600 = owner read/write only (octal 33216 = 0o100600 includes file type bits)
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('encrypted file is not readable as JSON', async () => {
    await manager.store('example.com', { type: 'bearer', header: 'authorization', value: 'secret' });
    const content = await readFile(join(testDir, 'auth.enc'), 'utf-8');
    const parsed = JSON.parse(content);
    // Should have encrypted structure, not plaintext auth
    assert.ok(parsed.iv, 'should have iv');
    assert.ok(parsed.ciphertext, 'should have ciphertext');
    assert.equal(parsed['example.com'], undefined, 'should NOT have plaintext domain key');
  });

  it('cannot decrypt with different machine ID', async () => {
    await manager.store('example.com', { type: 'bearer', header: 'authorization', value: 'secret' });

    const otherManager = new AuthManager(testDir, 'different-machine-id');
    const result = await otherManager.retrieve('example.com');
    assert.equal(result, null);
  });
});

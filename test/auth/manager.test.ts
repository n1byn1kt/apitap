// test/auth/manager.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager, getParentDomains } from '../../src/auth/manager.js';
import { randomBytes } from 'node:crypto';
import type { StoredAuth, StoredToken, StoredSession } from '../../src/types.js';

describe('AuthManager', () => {
  let testDir: string;
  let saltFile: string;
  let manager: AuthManager;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth-'));
    saltFile = join(testDir, 'install-salt');
    manager = new AuthManager(testDir, 'test-machine-id', saltFile);
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

describe('AuthManager token storage', () => {
  let testDir: string;
  let manager: AuthManager;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth-'));
    manager = new AuthManager(testDir, 'test-machine-id');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should store and retrieve tokens separately from header auth', async () => {
    await manager.storeTokens('example.com', {
      csrf_token: {
        value: 'abc123',
        refreshedAt: '2026-02-04T00:00:00Z',
      },
    });

    const tokens = await manager.retrieveTokens('example.com');
    assert.equal(tokens?.csrf_token.value, 'abc123');
  });

  it('should store and retrieve session', async () => {
    await manager.storeSession('example.com', {
      cookies: [{ name: 'session', value: 'xyz', domain: 'example.com', path: '/' }],
      savedAt: '2026-02-04T00:00:00Z',
    });

    const session = await manager.retrieveSession('example.com');
    assert.equal(session?.cookies[0].value, 'xyz');
  });

  it('should update tokens without overwriting session', async () => {
    await manager.storeSession('example.com', {
      cookies: [{ name: 'session', value: 'xyz', domain: 'example.com', path: '/' }],
      savedAt: '2026-02-04T00:00:00Z',
    });

    await manager.storeTokens('example.com', {
      csrf_token: { value: 'new-token', refreshedAt: '2026-02-04T01:00:00Z' },
    });

    const session = await manager.retrieveSession('example.com');
    const tokens = await manager.retrieveTokens('example.com');

    assert.equal(session?.cookies[0].value, 'xyz', 'session should be preserved');
    assert.equal(tokens?.csrf_token.value, 'new-token', 'tokens should be updated');
  });

  it('should list domains with auth', async () => {
    await manager.store('example.com', { type: 'bearer', header: 'authorization', value: 'xyz' });
    await manager.storeTokens('other.com', { csrf: { value: 'abc', refreshedAt: '' } });

    const domains = await manager.listDomains();
    assert.ok(domains.includes('example.com'));
    assert.ok(domains.includes('other.com'));
  });

  it('should clear auth for a domain', async () => {
    await manager.store('example.com', { type: 'bearer', header: 'authorization', value: 'xyz' });
    await manager.storeTokens('example.com', { csrf: { value: 'abc', refreshedAt: '' } });

    await manager.clear('example.com');

    assert.equal(await manager.retrieve('example.com'), null);
    assert.equal(await manager.retrieveTokens('example.com'), null);
  });

  it('should return null for tokens on unknown domain', async () => {
    const tokens = await manager.retrieveTokens('unknown.com');
    assert.equal(tokens, null);
  });

  it('should return null for session on unknown domain', async () => {
    const session = await manager.retrieveSession('unknown.com');
    assert.equal(session, null);
  });
});

describe('getParentDomains', () => {
  it('returns parent for single subdomain', () => {
    assert.deepEqual(getParentDomains('dashboard.twitch.tv'), ['twitch.tv']);
  });

  it('returns multiple parents for deep subdomain', () => {
    assert.deepEqual(getParentDomains('a.b.example.com'), ['b.example.com', 'example.com']);
  });

  it('returns empty array for base domain (2 labels)', () => {
    assert.deepEqual(getParentDomains('twitch.tv'), []);
  });

  it('returns empty array for single label', () => {
    assert.deepEqual(getParentDomains('localhost'), []);
  });
});

describe('AuthManager retrieveSessionWithFallback', () => {
  let testDir: string;
  let manager: AuthManager;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth-'));
    manager = new AuthManager(testDir, 'test-machine-id');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns exact match first', async () => {
    await manager.storeSession('dashboard.twitch.tv', {
      cookies: [{ name: 'exact', value: 'yes', domain: 'dashboard.twitch.tv', path: '/' }],
      savedAt: new Date().toISOString(),
    });
    await manager.storeSession('twitch.tv', {
      cookies: [{ name: 'parent', value: 'no', domain: 'twitch.tv', path: '/' }],
      savedAt: new Date().toISOString(),
    });

    const session = await manager.retrieveSessionWithFallback('dashboard.twitch.tv');
    assert.equal(session?.cookies[0].value, 'yes');
  });

  it('falls back to parent domain', async () => {
    await manager.storeSession('twitch.tv', {
      cookies: [{ name: 'parent', value: 'found', domain: 'twitch.tv', path: '/' }],
      savedAt: new Date().toISOString(),
    });

    const session = await manager.retrieveSessionWithFallback('dashboard.twitch.tv');
    assert.equal(session?.cookies[0].value, 'found');
  });

  it('returns null when no parent match', async () => {
    const session = await manager.retrieveSessionWithFallback('dashboard.twitch.tv');
    assert.equal(session, null);
  });

  it('handles deep subdomains', async () => {
    await manager.storeSession('example.com', {
      cookies: [{ name: 'deep', value: 'found', domain: 'example.com', path: '/' }],
      savedAt: new Date().toISOString(),
    });

    const session = await manager.retrieveSessionWithFallback('a.b.example.com');
    assert.equal(session?.cookies[0].value, 'found');
  });
});

describe('AuthManager retrieveWithFallback', () => {
  let testDir: string;
  let manager: AuthManager;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-auth-'));
    manager = new AuthManager(testDir, 'test-machine-id');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns exact match first', async () => {
    await manager.store('api.spotify.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer exact-token',
    });
    await manager.store('spotify.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer parent-token',
    });

    const auth = await manager.retrieveWithFallback('api.spotify.com');
    assert.equal(auth?.value, 'Bearer exact-token');
  });

  it('falls back to parent domain', async () => {
    await manager.store('spotify.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer parent-token',
    });

    const auth = await manager.retrieveWithFallback('spclient.wg.spotify.com');
    assert.equal(auth?.value, 'Bearer parent-token');
  });

  it('returns null when no parent match', async () => {
    const auth = await manager.retrieveWithFallback('unknown.example.com');
    assert.equal(auth, null);
  });

  it('handles deep subdomains', async () => {
    await manager.store('example.com', {
      type: 'bearer', header: 'authorization', value: 'Bearer deep-token',
    });

    const auth = await manager.retrieveWithFallback('a.b.c.example.com');
    assert.equal(auth?.value, 'Bearer deep-token');
  });
});

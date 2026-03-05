import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock chrome.storage.local for Node.js tests
const mockStorage: Record<string, any> = {};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (result: any) => void) => {
        const result: Record<string, any> = {};
        for (const k of keys) {
          if (k in mockStorage) result[k] = mockStorage[k];
        }
        cb(result);
      },
      set: (items: Record<string, any>, cb?: () => void) => {
        Object.assign(mockStorage, items);
        cb?.();
      },
    },
  },
};

// Import after mock is set up
const { isApproved, addApprovedDomain, removeApprovedDomain, getApprovedDomains } = await import('../../extension/src/consent.js');

describe('consent management', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  });

  it('returns false for unapproved domain', async () => {
    assert.equal(await isApproved('discord.com'), false);
  });

  it('returns true after domain is approved', async () => {
    await addApprovedDomain('discord.com');
    assert.equal(await isApproved('discord.com'), true);
  });

  it('returns empty list initially', async () => {
    const domains = await getApprovedDomains();
    assert.deepEqual(domains, []);
  });

  it('removes a domain', async () => {
    await addApprovedDomain('discord.com');
    await removeApprovedDomain('discord.com');
    assert.equal(await isApproved('discord.com'), false);
  });

  it('does not duplicate domains', async () => {
    await addApprovedDomain('discord.com');
    await addApprovedDomain('discord.com');
    const domains = await getApprovedDomains();
    assert.equal(domains.length, 1);
  });
});

# ApiTap v0.2 — Privacy & Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden ApiTap so that skill files contain no secrets, captured data is scrubbed of PII, and imported skill files are validated against SSRF and tampering attacks.

**Architecture:** Seven security features layered onto v0.1: (1) domain-only capture at the Playwright listener level, (2) auth credentials extracted from skill files into AES-256-GCM encrypted storage, (3) response previews off by default, (4) PII regex scrubbing on all stored strings, (5) import validation with SSRF checks, (6) auto-generated .gitignore, (7) HMAC-SHA256 skill file signing with three-state provenance tracking.

**Tech Stack:** TypeScript (ESM), Node 22 (built-in test runner, `crypto` module for AES-256-GCM + PBKDF2 + HMAC), Playwright (capture), `tsx` (dev runner). No new dependencies.

**Dependencies:** None new — everything uses Node stdlib `crypto`.

**Test command:** `node --import tsx --test 'test/**/*.test.ts'`

**Dev run:** `npx tsx src/cli.ts`

**Rule: Run full test suite (`npm test`) after every task commit, not just the new tests. Catches regressions before they compound. If any existing test breaks, fix it before moving to the next task.**

**Design doc:** `docs/plans/2026-02-04-v02-security-design.md`

---

### Task 1: Schema Updates — Types, Version Bump, Provenance

**Files:**
- Modify: `src/types.ts`
- Modify: `src/skill/generator.ts:122-135` (toolVersion)

**Step 1: Update SkillFile type with new fields**

Add `signature`, `provenance`, and bump version to `1.1` in `src/types.ts`:

```typescript
// src/types.ts

/** A captured HTTP request/response pair from the browser */
export interface CapturedExchange {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    contentType: string;
  };
  timestamp: string;
}

/** Stored auth credentials for a domain */
export interface StoredAuth {
  type: 'bearer' | 'api-key' | 'cookie' | 'custom';
  header: string;
  value: string;
}

/** A single API endpoint in a skill file */
export interface SkillEndpoint {
  id: string;
  method: string;
  path: string;
  queryParams: Record<string, { type: string; example: string }>;
  headers: Record<string, string>;
  responseShape: { type: string; fields?: string[] };
  examples: {
    request: { url: string; headers: Record<string, string> };
    responsePreview: unknown;
  };
}

/** The full skill file written to disk */
export interface SkillFile {
  version: string;
  domain: string;
  capturedAt: string;
  baseUrl: string;
  endpoints: SkillEndpoint[];
  metadata: {
    captureCount: number;
    filteredCount: number;
    toolVersion: string;
  };
  provenance: 'self' | 'imported' | 'unsigned';
  signature?: string;
}

/** Summary returned by `apitap list` */
export interface SkillSummary {
  domain: string;
  skillFile: string;
  endpointCount: number;
  capturedAt: string;
  provenance: 'self' | 'imported' | 'unsigned';
}
```

**Step 2: Update generator toolVersion**

In `src/skill/generator.ts`, change `toSkillFile()` to use version `1.1`, toolVersion `0.2.0`, and add `provenance: 'unsigned'` (signing adds `'self'` later):

Replace the `toSkillFile` method return statement (lines 123-135):

```typescript
  /** Generate the complete skill file for a domain. */
  toSkillFile(domain: string): SkillFile {
    return {
      version: '1.1',
      domain,
      capturedAt: new Date().toISOString(),
      baseUrl: this.baseUrl ?? `https://${domain}`,
      endpoints: Array.from(this.endpoints.values()),
      metadata: {
        captureCount: this.captureCount,
        filteredCount: this.filteredCount,
        toolVersion: '0.2.0',
      },
      provenance: 'unsigned',
    };
  }
```

**Step 3: Update store to include provenance in summaries**

In `src/skill/store.ts`, update the `listSkillFiles` function to include `provenance` in the summary (line 51-55):

```typescript
      summaries.push({
        domain: skill.domain,
        skillFile: join(skillsDir, file),
        endpointCount: skill.endpoints.length,
        capturedAt: skill.capturedAt,
        provenance: skill.provenance ?? 'unsigned',
      });
```

**Step 4: Fix existing tests**

The generator test at `test/skill/generator.test.ts` line 48 checks `skill.version`. Update:
- Change `assert.equal(skill.version, '1.0')` to `assert.equal(skill.version, '1.1')`

The store test at `test/skill/store.test.ts` creates mock skill files without `provenance`. Update `makeSkill()` to include `provenance: 'unsigned'` in the returned object. Also update the list test to check `summaries[0].provenance` if desired, or at minimum ensure the mock skill has the field so `listSkillFiles` doesn't break.

In `test/skill/store.test.ts`, update the `makeSkill` helper:

```typescript
const makeSkill = (domain: string): SkillFile => ({
  version: '1.1',
  domain,
  capturedAt: '2026-02-04T12:00:00.000Z',
  baseUrl: `https://${domain}`,
  endpoints: [
    {
      id: 'get-api-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array', fields: ['id', 'name'] },
      examples: {
        request: { url: `https://${domain}/api/data`, headers: {} },
        responsePreview: [{ id: 1, name: 'test' }],
      },
    },
  ],
  metadata: { captureCount: 10, filteredCount: 8, toolVersion: '0.2.0' },
  provenance: 'unsigned',
});
```

In `test/replay/engine.test.ts`, update the `makeSkill` helper similarly — add `provenance: 'unsigned'`.

**Step 5: Run all tests**

Run: `npm test`
Expected: All 29 tests PASS (existing behavior unchanged, new fields are additive)

**Step 6: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 7: Commit**

```bash
git add src/types.ts src/skill/generator.ts src/skill/store.ts test/skill/generator.test.ts test/skill/store.test.ts test/replay/engine.test.ts
git commit -m "feat: schema v1.1 — add provenance, signature fields, StoredAuth type"
```

---

### Task 2: PII Scrubber

**Files:**
- Create: `test/capture/scrubber.test.ts`
- Create: `src/capture/scrubber.ts`

**Step 1: Write the failing test**

```typescript
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
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/scrubber.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/capture/scrubber.ts

// Email: standard pattern
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone (international): requires + prefix
const PHONE_INTL_RE = /\+[1-9]\d{7,14}/g;

// Phone (US): requires separators — (123) 456-7890 or 123-456-7890 or 123.456.7890
const PHONE_US_RE = /\(?\d{3}\)[-.\s]\d{3}[-.\s]\d{4}/g;

// IPv4: four octets, each 0-255, validated programmatically
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

// Credit card: 16 digits with optional dashes or spaces every 4
const CARD_RE = /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g;

// US SSN: 123-45-6789
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Scrub PII from a string. Returns the string with PII replaced by placeholders.
 * Order matters: SSN before phone (SSN is more specific).
 */
export function scrubPII(input: string): string {
  let result = input;

  // Email first (most distinctive pattern)
  result = result.replace(EMAIL_RE, '[email]');

  // SSN before phone (SSN pattern 123-45-6789 could be confused)
  result = result.replace(SSN_RE, '[ssn]');

  // Credit cards
  result = result.replace(CARD_RE, '[card]');

  // IPv4 with octet validation
  result = result.replace(IPV4_RE, (_match, o1, o2, o3, o4) => {
    const octets = [o1, o2, o3, o4].map(Number);
    if (octets.every(o => o <= 255)) return '[ip]';
    return _match;
  });

  // Phone (international, then US)
  result = result.replace(PHONE_INTL_RE, '[phone]');
  result = result.replace(PHONE_US_RE, '[phone]');

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/capture/scrubber.test.ts`
Expected: All 10 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/capture/scrubber.ts test/capture/scrubber.test.ts
git commit -m "feat: PII scrubber — regex detection for emails, phones, IPs, cards, SSNs"
```

---

### Task 3: Domain Matching Utility

**Files:**
- Create: `test/capture/domain.test.ts`
- Create: `src/capture/domain.ts`

**Step 1: Write the failing test**

```typescript
// test/capture/domain.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDomainMatch } from '../../src/capture/domain.js';

describe('isDomainMatch', () => {
  it('matches exact domain', () => {
    assert.equal(isDomainMatch('example.com', 'example.com'), true);
    assert.equal(isDomainMatch('api.example.com', 'api.example.com'), true);
  });

  it('matches subdomains of target', () => {
    assert.equal(isDomainMatch('api.example.com', 'example.com'), true);
    assert.equal(isDomainMatch('v2.api.example.com', 'example.com'), true);
  });

  it('does NOT match unrelated domains with same suffix', () => {
    assert.equal(isDomainMatch('evil-example.com', 'example.com'), false);
    assert.equal(isDomainMatch('notexample.com', 'example.com'), false);
  });

  it('does NOT match parent domains', () => {
    assert.equal(isDomainMatch('example.com', 'api.example.com'), false);
  });

  it('handles domains with many subdomains', () => {
    assert.equal(isDomainMatch('a.b.c.example.com', 'example.com'), true);
    assert.equal(isDomainMatch('a.b.c.example.com', 'c.example.com'), true);
    assert.equal(isDomainMatch('a.b.c.example.com', 'b.c.example.com'), true);
  });

  it('extracts target domain from URL', () => {
    assert.equal(isDomainMatch('api.example.com', 'https://example.com/path'), true);
    assert.equal(isDomainMatch('api.example.com', 'https://www.example.com'), true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/domain.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/capture/domain.ts

/**
 * Check if a hostname matches the target domain.
 * Uses dot-prefix matching to prevent evil-example.com matching example.com.
 *
 * @param hostname - The hostname to check (e.g. "api.example.com")
 * @param target - The target domain or URL (e.g. "example.com" or "https://example.com/path")
 */
export function isDomainMatch(hostname: string, target: string): boolean {
  // Extract hostname from URL if target looks like a URL
  let targetHost: string;
  try {
    if (target.includes('://')) {
      targetHost = new URL(target).hostname;
    } else {
      targetHost = target;
    }
  } catch {
    targetHost = target;
  }

  // Exact match
  if (hostname === targetHost) return true;

  // Dot-prefix suffix match: hostname must end with ".targetHost"
  // This prevents evil-example.com from matching example.com
  return hostname.endsWith('.' + targetHost);
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/capture/domain.test.ts`
Expected: All 6 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/capture/domain.ts test/capture/domain.test.ts
git commit -m "feat: domain matching — dot-prefix suffix matching for capture filtering"
```

---

### Task 4: Crypto Module — Key Derivation and AES-256-GCM

**Files:**
- Create: `test/auth/crypto.test.ts`
- Create: `src/auth/crypto.ts`

**Step 1: Write the failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth/crypto.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/auth/crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = 'apitap-v0.2-key-derivation';

export interface EncryptedData {
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

/**
 * Derive a 256-bit key from a machine identifier using PBKDF2.
 * Uses a fixed application salt — the entropy comes from the machine ID
 * being stretched through 100K iterations.
 */
export function deriveKey(machineId: string): Buffer {
  return pbkdf2Sync(machineId, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Each call generates a random IV for semantic security.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    salt: PBKDF2_SALT,
    iv: iv.toString('hex'),
    ciphertext,
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * Throws if key is wrong or data was tampered with.
 */
export function decrypt(data: EncryptedData, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(data.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));

  let plaintext = decipher.update(data.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

/**
 * Create an HMAC-SHA256 signature.
 * Returns a prefixed string: "hmac-sha256:<hex>"
 */
export function hmacSign(data: string, key: Buffer): string {
  const hmac = createHmac('sha256', key);
  hmac.update(data);
  return `hmac-sha256:${hmac.digest('hex')}`;
}

/**
 * Verify an HMAC-SHA256 signature using timing-safe comparison.
 */
export function hmacVerify(data: string, signature: string, key: Buffer): boolean {
  if (!signature.startsWith('hmac-sha256:')) return false;

  const expected = hmacSign(data, key);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth/crypto.test.ts`
Expected: All 7 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/auth/crypto.ts test/auth/crypto.test.ts
git commit -m "feat: crypto module — AES-256-GCM encryption, PBKDF2 key derivation, HMAC signing"
```

---

### Task 5: Auth Manager — Encrypted Credential Storage

**Files:**
- Create: `test/auth/manager.test.ts`
- Create: `src/auth/manager.ts`

**Step 1: Write the failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth/manager.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/auth/manager.ts
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt, deriveKey, type EncryptedData } from './crypto.js';
import type { StoredAuth } from '../types.js';

const AUTH_FILENAME = 'auth.enc';

/**
 * Manages encrypted auth credential storage.
 * All credentials stored in a single encrypted file keyed by domain.
 */
export class AuthManager {
  private key: Buffer;
  private authPath: string;

  constructor(baseDir: string, machineId: string) {
    this.key = deriveKey(machineId);
    this.authPath = join(baseDir, AUTH_FILENAME);
  }

  /** Store auth credentials for a domain (overwrites existing). */
  async store(domain: string, auth: StoredAuth): Promise<void> {
    const allAuth = await this.loadAll();
    allAuth[domain] = auth;
    await this.saveAll(allAuth);
  }

  /** Retrieve auth credentials for a domain. Returns null if not found or decryption fails. */
  async retrieve(domain: string): Promise<StoredAuth | null> {
    const allAuth = await this.loadAll();
    return allAuth[domain] ?? null;
  }

  /** Check if auth exists for a domain without loading the value. */
  async has(domain: string): Promise<boolean> {
    const allAuth = await this.loadAll();
    return domain in allAuth;
  }

  private async loadAll(): Promise<Record<string, StoredAuth>> {
    try {
      const content = await readFile(this.authPath, 'utf-8');
      const encrypted: EncryptedData = JSON.parse(content);
      const plaintext = decrypt(encrypted, this.key);
      return JSON.parse(plaintext);
    } catch {
      return {};
    }
  }

  private async saveAll(data: Record<string, StoredAuth>): Promise<void> {
    const dir = join(this.authPath, '..');
    await mkdir(dir, { recursive: true });

    const plaintext = JSON.stringify(data);
    const encrypted = encrypt(plaintext, this.key);

    await writeFile(this.authPath, JSON.stringify(encrypted, null, 2) + '\n', { mode: 0o600 });
    // Ensure permissions even if file existed with different perms
    await chmod(this.authPath, 0o600);
  }
}

/**
 * Get the machine ID for key derivation.
 * Linux: /etc/machine-id
 * Fallback: hostname + homedir (less secure but portable)
 */
export async function getMachineId(): Promise<string> {
  try {
    const id = await readFile('/etc/machine-id', 'utf-8');
    return id.trim();
  } catch {
    // Fallback for non-Linux systems
    const { hostname } = await import('node:os');
    const { homedir } = await import('node:os');
    return `${hostname()}-${homedir()}`;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth/manager.test.ts`
Expected: All 7 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/auth/manager.ts test/auth/manager.test.ts
git commit -m "feat: auth manager — encrypted credential storage with AES-256-GCM"
```

---

### Task 6: Auth Extraction in Generator — Strip Secrets, Add Placeholders

**Files:**
- Modify: `src/skill/generator.ts`
- Modify: `test/skill/generator.test.ts`

This task modifies the `SkillGenerator` to extract auth headers and replace them with `[stored]` placeholders. The generator gains an `enablePreview` option and a `scrub` option, and exposes extracted auth for the capture pipeline to store.

**Step 1: Write new failing tests**

Add these tests to `test/skill/generator.test.ts`:

```typescript
  it('replaces auth headers with [stored] placeholder', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'authorization': 'Bearer secret-token',
        'x-api-key': 'secret-key',
        'content-type': 'application/json',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], '[stored]');
    assert.equal(h['x-api-key'], '[stored]');
    assert.equal(h['content-type'], 'application/json');

    // Example headers should also be scrubbed
    const exH = skill.endpoints[0].examples.request.headers;
    assert.equal(exH['authorization'], '[stored]');
    assert.equal(exH['x-api-key'], '[stored]');
  });

  it('exposes extracted auth credentials', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'authorization': 'Bearer secret-token',
      },
    }));

    const extracted = gen.getExtractedAuth();
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].type, 'bearer');
    assert.equal(extracted[0].header, 'authorization');
    assert.equal(extracted[0].value, 'Bearer secret-token');
  });

  it('omits responsePreview by default', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'test' }]),
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].examples.responsePreview, null);
  });

  it('includes responsePreview when enablePreview is true', () => {
    const gen = new SkillGenerator({ enablePreview: true });
    gen.addExchange(mockExchange({
      body: JSON.stringify([{ id: 1, name: 'test' }]),
    }));

    const skill = gen.toSkillFile('example.com');
    assert.deepEqual(skill.endpoints[0].examples.responsePreview, [{ id: 1, name: 'test' }]);
  });

  it('scrubs PII from query param examples', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?email=john@test.com&limit=10',
    }));

    const skill = gen.toSkillFile('example.com');
    const params = skill.endpoints[0].queryParams;
    assert.equal(params['email'].example, '[email]');
    assert.equal(params['limit'].example, '10');
  });

  it('scrubs PII from example request URL', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/users/john@test.com/profile',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.ok(skill.endpoints[0].examples.request.url.includes('[email]'));
    assert.ok(!skill.endpoints[0].examples.request.url.includes('john@test.com'));
  });

  it('skips PII scrubbing when scrub is false', () => {
    const gen = new SkillGenerator({ scrub: false });
    gen.addExchange(mockExchange({
      url: 'https://example.com/api/search?email=john@test.com',
    }));

    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].queryParams['email'].example, 'john@test.com');
  });
```

**Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/skill/generator.test.ts`
Expected: FAIL — new tests fail (SkillGenerator constructor doesn't accept options, no `getExtractedAuth`, auth not stripped)

**Step 3: Update the implementation**

Rewrite `src/skill/generator.ts`:

```typescript
// src/skill/generator.ts
import type { CapturedExchange, SkillEndpoint, SkillFile, StoredAuth } from '../types.js';
import { scrubPII } from '../capture/scrubber.js';

const KEEP_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'x-api-key',
  'x-csrf-token',
  'x-requested-with',
]);

const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
]);

export interface GeneratorOptions {
  enablePreview?: boolean;
  scrub?: boolean;
}

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (KEEP_HEADERS.has(lower) || (lower.startsWith('x-') && !lower.startsWith('x-forwarded'))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function stripAuth(headers: Record<string, string>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (AUTH_HEADERS.has(lower)) {
      stripped[key] = '[stored]';
    } else {
      stripped[key] = value;
    }
  }
  return stripped;
}

function extractAuth(headers: Record<string, string>): StoredAuth[] {
  const auth: StoredAuth[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' && value) {
      auth.push({
        type: value.toLowerCase().startsWith('bearer') ? 'bearer' : 'custom',
        header: lower,
        value,
      });
    } else if (lower === 'x-api-key' && value) {
      auth.push({ type: 'api-key', header: lower, value });
    }
  }
  return auth;
}

function generateEndpointId(method: string, path: string): string {
  const slug = path
    .replace(/^\//, '')
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
  return `${method.toLowerCase()}-${slug || 'root'}`;
}

function detectResponseShape(body: string): { type: string; fields?: string[] } {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      return {
        type: 'array',
        fields: first && typeof first === 'object' && first !== null
          ? Object.keys(first)
          : undefined,
      };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return { type: 'object', fields: Object.keys(parsed) };
    }
    return { type: typeof parsed };
  } catch {
    return { type: 'unknown' };
  }
}

function truncatePreview(body: string, maxItems = 2): unknown {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed.slice(0, maxItems);
    }
    return parsed;
  } catch {
    return body.slice(0, 500);
  }
}

function extractQueryParams(url: URL): Record<string, { type: string; example: string }> {
  const params: Record<string, { type: string; example: string }> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = { type: 'string', example: value };
  }
  return params;
}

function scrubQueryParams(
  params: Record<string, { type: string; example: string }>,
): Record<string, { type: string; example: string }> {
  const scrubbed: Record<string, { type: string; example: string }> = {};
  for (const [key, val] of Object.entries(params)) {
    scrubbed[key] = { type: val.type, example: scrubPII(val.example) };
  }
  return scrubbed;
}

export class SkillGenerator {
  private endpoints = new Map<string, SkillEndpoint>();
  private captureCount = 0;
  private filteredCount = 0;
  private baseUrl: string | null = null;
  private extractedAuthList: StoredAuth[] = [];
  private options: Required<GeneratorOptions>;

  constructor(options: GeneratorOptions = {}) {
    this.options = {
      enablePreview: options.enablePreview ?? false,
      scrub: options.scrub ?? true,
    };
  }

  /** Add a captured exchange. Returns the new endpoint if first seen, null if duplicate. */
  addExchange(exchange: CapturedExchange): SkillEndpoint | null {
    this.captureCount++;

    const url = new URL(exchange.request.url);

    // Track baseUrl from the first captured exchange
    if (!this.baseUrl) {
      this.baseUrl = url.origin;
    }
    const key = `${exchange.request.method} ${url.pathname}`;

    if (this.endpoints.has(key)) {
      return null;
    }

    // Extract auth before filtering headers
    const auth = extractAuth(exchange.request.headers);
    this.extractedAuthList.push(...auth);

    // Filter headers, then strip auth values
    const filtered = filterHeaders(exchange.request.headers);
    const safeHeaders = stripAuth(filtered);

    // Build query params, optionally scrub PII
    let queryParams = extractQueryParams(url);
    if (this.options.scrub) {
      queryParams = scrubQueryParams(queryParams);
    }

    // Build example URL, optionally scrub PII
    let exampleUrl = exchange.request.url;
    if (this.options.scrub) {
      exampleUrl = scrubPII(exampleUrl);
    }

    // Response preview: null by default, populated with --preview
    let responsePreview: unknown = null;
    if (this.options.enablePreview) {
      const preview = truncatePreview(exchange.response.body);
      responsePreview = this.options.scrub && typeof preview === 'string'
        ? scrubPII(preview)
        : preview;
    }

    const endpoint: SkillEndpoint = {
      id: generateEndpointId(exchange.request.method, url.pathname),
      method: exchange.request.method,
      path: url.pathname,
      queryParams,
      headers: safeHeaders,
      responseShape: detectResponseShape(exchange.response.body),
      examples: {
        request: {
          url: exampleUrl,
          headers: stripAuth(filterHeaders(exchange.request.headers)),
        },
        responsePreview,
      },
    };

    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  /** Record a filtered-out request (for metadata tracking). */
  recordFiltered(): void {
    this.filteredCount++;
  }

  /** Get auth credentials extracted during capture. */
  getExtractedAuth(): StoredAuth[] {
    return this.extractedAuthList;
  }

  /** Generate the complete skill file for a domain. */
  toSkillFile(domain: string): SkillFile {
    return {
      version: '1.1',
      domain,
      capturedAt: new Date().toISOString(),
      baseUrl: this.baseUrl ?? `https://${domain}`,
      endpoints: Array.from(this.endpoints.values()),
      metadata: {
        captureCount: this.captureCount,
        filteredCount: this.filteredCount,
        toolVersion: '0.2.0',
      },
      provenance: 'unsigned',
    };
  }
}
```

**Step 4: Update existing test expectations**

In `test/skill/generator.test.ts`, the test `'filters noisy request headers, keeps meaningful ones'` now expects auth headers to be `[stored]` instead of their actual values. Update:

```typescript
  it('filters noisy request headers, keeps meaningful ones', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockExchange({
      requestHeaders: {
        'accept': 'application/json',
        'authorization': 'Bearer tok123',
        'user-agent': 'Mozilla/5.0 ...',
        'accept-encoding': 'gzip',
        'x-api-key': 'key123',
        'cookie': 'session=abc',
      },
    }));

    const skill = gen.toSkillFile('example.com');
    const h = skill.endpoints[0].headers;
    assert.equal(h['authorization'], '[stored]');
    assert.equal(h['x-api-key'], '[stored]');
    assert.equal(h['user-agent'], undefined);
    assert.equal(h['accept-encoding'], undefined);
  });
```

Also update the test `'generates a skill file from captured exchanges'` to check `version: '1.1'` and add `provenance` check:

```typescript
    assert.equal(skill.version, '1.1');
    assert.equal(skill.provenance, 'unsigned');
```

**Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/skill/generator.test.ts`
Expected: All tests PASS (old + new)

**Step 6: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/skill/generator.ts test/skill/generator.test.ts
git commit -m "feat: auth extraction — strip secrets from skill files, PII scrubbing, preview toggle"
```

---

### Task 7: Skill File Signing

**Files:**
- Create: `test/skill/signing.test.ts`
- Create: `src/skill/signing.ts`

**Step 1: Write the failing test**

```typescript
// test/skill/signing.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signSkillFile, verifySignature, canonicalize } from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(): SkillFile {
  return {
    version: '1.1',
    domain: 'example.com',
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: 'https://example.com',
    endpoints: [{
      id: 'get-api-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: { 'authorization': '[stored]' },
      responseShape: { type: 'array', fields: ['id'] },
      examples: {
        request: { url: 'https://example.com/api/data', headers: {} },
        responsePreview: null,
      },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
    provenance: 'unsigned',
  };
}

describe('skill file signing', () => {
  const key = deriveKey('test-machine-id');

  it('signs a skill file and sets provenance to self', () => {
    const skill = makeSkill();
    const signed = signSkillFile(skill, key);

    assert.equal(signed.provenance, 'self');
    assert.ok(signed.signature?.startsWith('hmac-sha256:'));
  });

  it('verifies a valid signature', () => {
    const signed = signSkillFile(makeSkill(), key);
    assert.equal(verifySignature(signed, key), true);
  });

  it('rejects a tampered skill file', () => {
    const signed = signSkillFile(makeSkill(), key);
    signed.domain = 'evil.com';
    assert.equal(verifySignature(signed, key), false);
  });

  it('rejects a file signed with different key', () => {
    const signed = signSkillFile(makeSkill(), key);
    const otherKey = deriveKey('other-machine');
    assert.equal(verifySignature(signed, otherKey), false);
  });

  it('returns false for unsigned files', () => {
    const skill = makeSkill();
    assert.equal(verifySignature(skill, key), false);
  });

  it('canonicalize excludes signature and provenance', () => {
    const a = makeSkill();
    const b = { ...makeSkill(), signature: 'hmac-sha256:abc', provenance: 'self' as const };
    assert.equal(canonicalize(a), canonicalize(b));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/skill/signing.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/skill/signing.ts
import { hmacSign, hmacVerify } from '../auth/crypto.js';
import type { SkillFile } from '../types.js';

/**
 * Create a canonical JSON string from a skill file,
 * excluding `signature` and `provenance` fields.
 * This is the payload that gets signed.
 */
export function canonicalize(skill: SkillFile): string {
  const { signature: _sig, provenance: _prov, ...rest } = skill;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Sign a skill file. Returns a new object with signature and provenance: 'self'.
 */
export function signSkillFile(skill: SkillFile, key: Buffer): SkillFile {
  const payload = canonicalize(skill);
  const signature = hmacSign(payload, key);
  return {
    ...skill,
    provenance: 'self',
    signature,
  };
}

/**
 * Verify a skill file's signature.
 * Returns true if the signature is valid for the given key.
 */
export function verifySignature(skill: SkillFile, key: Buffer): boolean {
  if (!skill.signature) return false;
  const payload = canonicalize(skill);
  return hmacVerify(payload, skill.signature, key);
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/skill/signing.test.ts`
Expected: All 6 tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/skill/signing.ts test/skill/signing.test.ts
git commit -m "feat: skill file signing — HMAC-SHA256 with tamper detection"
```

---

### Task 8: SSRF Validator

**Files:**
- Create: `test/skill/ssrf.test.ts`
- Create: `src/skill/ssrf.ts`

**Step 1: Write the failing test**

```typescript
// test/skill/ssrf.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, validateSkillFileUrls } from '../../src/skill/ssrf.js';
import type { SkillFile } from '../../src/types.js';

describe('SSRF validation', () => {
  describe('validateUrl', () => {
    it('allows public HTTPS URLs', () => {
      assert.equal(validateUrl('https://api.example.com/data').safe, true);
      assert.equal(validateUrl('https://polymarket.com').safe, true);
    });

    it('allows public HTTP URLs', () => {
      assert.equal(validateUrl('http://api.example.com').safe, true);
    });

    it('rejects localhost', () => {
      const r = validateUrl('http://localhost/admin');
      assert.equal(r.safe, false);
      assert.ok(r.reason!.includes('internal'));
    });

    it('rejects 127.0.0.1', () => {
      assert.equal(validateUrl('http://127.0.0.1:8080/api').safe, false);
    });

    it('rejects private IP ranges', () => {
      assert.equal(validateUrl('http://10.0.0.1/data').safe, false);
      assert.equal(validateUrl('http://172.16.0.1/data').safe, false);
      assert.equal(validateUrl('http://172.31.255.255/data').safe, false);
      assert.equal(validateUrl('http://192.168.1.1/data').safe, false);
    });

    it('rejects link-local addresses', () => {
      assert.equal(validateUrl('http://169.254.0.1/data').safe, false);
    });

    it('rejects IPv6 loopback', () => {
      assert.equal(validateUrl('http://[::1]/data').safe, false);
    });

    it('rejects .local and .internal domains', () => {
      assert.equal(validateUrl('http://myapp.local/api').safe, false);
      assert.equal(validateUrl('http://db.internal/query').safe, false);
    });

    it('rejects non-HTTP schemes', () => {
      assert.equal(validateUrl('file:///etc/passwd').safe, false);
      assert.equal(validateUrl('ftp://files.internal/data').safe, false);
      assert.equal(validateUrl('gopher://evil.com/attack').safe, false);
    });

    it('allows 172.x IPs outside private range', () => {
      assert.equal(validateUrl('http://172.32.0.1/data').safe, true);
      assert.equal(validateUrl('http://172.15.0.1/data').safe, true);
    });

    it('rejects invalid URLs', () => {
      assert.equal(validateUrl('not-a-url').safe, false);
    });
  });

  describe('validateSkillFileUrls', () => {
    function makeSkill(baseUrl: string, endpointUrls: string[] = []): SkillFile {
      return {
        version: '1.1',
        domain: 'example.com',
        capturedAt: '2026-02-04T12:00:00.000Z',
        baseUrl,
        endpoints: endpointUrls.map((url, i) => ({
          id: `ep-${i}`,
          method: 'GET',
          path: new URL(url).pathname,
          queryParams: {},
          headers: {},
          responseShape: { type: 'object' },
          examples: { request: { url, headers: {} }, responsePreview: null },
        })),
        metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
        provenance: 'unsigned',
      };
    }

    it('passes for safe skill file', () => {
      const result = validateSkillFileUrls(makeSkill('https://api.example.com', [
        'https://api.example.com/data',
      ]));
      assert.equal(result.safe, true);
    });

    it('fails for SSRF in baseUrl', () => {
      const result = validateSkillFileUrls(makeSkill('http://localhost:8080'));
      assert.equal(result.safe, false);
    });

    it('fails for SSRF in endpoint example URL', () => {
      const result = validateSkillFileUrls(makeSkill('https://safe.com', [
        'http://192.168.1.1/admin',
      ]));
      assert.equal(result.safe, false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/skill/ssrf.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/skill/ssrf.ts
import type { SkillFile } from '../types.js';

export interface ValidationResult {
  safe: boolean;
  reason?: string;
}

const INTERNAL_HOSTNAMES = ['localhost'];
const INTERNAL_SUFFIXES = ['.local', '.internal'];

/**
 * Check if a URL is safe to replay (not targeting internal infrastructure).
 */
export function validateUrl(urlString: string): ValidationResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Scheme check
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: `Non-HTTP scheme: ${url.protocol}` };
  }

  const hostname = url.hostname;

  // Exact internal hostnames
  if (INTERNAL_HOSTNAMES.includes(hostname)) {
    return { safe: false, reason: `URL targets internal hostname: ${hostname}` };
  }

  // Internal domain suffixes
  for (const suffix of INTERNAL_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { safe: false, reason: `URL targets internal domain: ${hostname}` };
    }
  }

  // IPv6 loopback
  if (hostname === '[::1]' || hostname === '::1') {
    return { safe: false, reason: 'URL targets IPv6 loopback' };
  }

  // IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    const first = Number(a);
    const second = Number(b);

    // 127.x.x.x — loopback
    if (first === 127) {
      return { safe: false, reason: `URL targets loopback address: ${hostname}` };
    }
    // 10.x.x.x — private
    if (first === 10) {
      return { safe: false, reason: `URL targets private IP: ${hostname}` };
    }
    // 172.16-31.x.x — private
    if (first === 172 && second >= 16 && second <= 31) {
      return { safe: false, reason: `URL targets private IP: ${hostname}` };
    }
    // 192.168.x.x — private
    if (first === 192 && second === 168) {
      return { safe: false, reason: `URL targets private IP: ${hostname}` };
    }
    // 169.254.x.x — link-local
    if (first === 169 && second === 254) {
      return { safe: false, reason: `URL targets link-local address: ${hostname}` };
    }
  }

  return { safe: true };
}

/**
 * Validate all URLs in a skill file.
 * Checks baseUrl and all endpoint example URLs.
 */
export function validateSkillFileUrls(skill: SkillFile): ValidationResult {
  // Check baseUrl
  const baseResult = validateUrl(skill.baseUrl);
  if (!baseResult.safe) {
    return { safe: false, reason: `baseUrl: ${baseResult.reason}` };
  }

  // Check endpoint example URLs
  for (const ep of skill.endpoints) {
    const exUrl = ep.examples?.request?.url;
    if (exUrl) {
      const result = validateUrl(exUrl);
      if (!result.safe) {
        return { safe: false, reason: `endpoint ${ep.id}: ${result.reason}` };
      }
    }
  }

  return { safe: true };
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/skill/ssrf.test.ts`
Expected: All tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/skill/ssrf.ts test/skill/ssrf.test.ts
git commit -m "feat: SSRF validator — reject private IPs, internal hostnames, non-HTTP schemes"
```

---

### Task 9: Auto-Generated .gitignore

**Files:**
- Modify: `src/skill/store.ts`
- Modify: `test/skill/store.test.ts`

**Step 1: Write new failing tests**

Add to `test/skill/store.test.ts`:

```typescript
  it('creates .gitignore in base dir on first write', async () => {
    const baseDir = join(testDir, '.apitap');
    const skillsDir = join(baseDir, 'skills');
    await writeSkillFile(makeSkill('example.com'), skillsDir);

    const { readFile } = await import('node:fs/promises');
    const gitignore = await readFile(join(baseDir, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('auth.enc'));
  });

  it('does not overwrite existing .gitignore', async () => {
    const baseDir = join(testDir, '.apitap');
    const skillsDir = join(baseDir, 'skills');
    const { writeFile: wf, mkdir: mk, readFile: rf } = await import('node:fs/promises');
    await mk(baseDir, { recursive: true });
    await wf(join(baseDir, '.gitignore'), 'custom content\n');

    await writeSkillFile(makeSkill('example.com'), skillsDir);

    const gitignore = await rf(join(baseDir, '.gitignore'), 'utf-8');
    assert.equal(gitignore, 'custom content\n');
  });
```

**Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: FAIL — .gitignore not created

**Step 3: Update the implementation**

Add `ensureGitignore` to `src/skill/store.ts`:

```typescript
// src/skill/store.ts
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SkillFile, SkillSummary } from '../types.js';

const DEFAULT_SKILLS_DIR = join(homedir(), '.apitap', 'skills');

const BASE_GITIGNORE = `# ApiTap — prevent accidental credential commits
auth.enc
*.key
`;

function skillPath(domain: string, skillsDir: string): string {
  return join(skillsDir, `${domain}.json`);
}

async function ensureGitignore(skillsDir: string): Promise<void> {
  const baseDir = dirname(skillsDir);
  const gitignorePath = join(baseDir, '.gitignore');

  try {
    await access(gitignorePath);
    // File exists, don't overwrite
  } catch {
    // File doesn't exist, create it
    await mkdir(baseDir, { recursive: true });
    await writeFile(gitignorePath, BASE_GITIGNORE);
  }
}

export async function writeSkillFile(
  skill: SkillFile,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<string> {
  await mkdir(skillsDir, { recursive: true });
  await ensureGitignore(skillsDir);
  const filePath = skillPath(skill.domain, skillsDir);
  await writeFile(filePath, JSON.stringify(skill, null, 2) + '\n');
  return filePath;
}

export async function readSkillFile(
  domain: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<SkillFile | null> {
  try {
    const content = await readFile(skillPath(domain, skillsDir), 'utf-8');
    return JSON.parse(content) as SkillFile;
  } catch {
    return null;
  }
}

export async function listSkillFiles(
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<SkillSummary[]> {
  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    return [];
  }

  const summaries: SkillSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const domain = file.replace(/\.json$/, '');
    const skill = await readSkillFile(domain, skillsDir);
    if (skill) {
      summaries.push({
        domain: skill.domain,
        skillFile: join(skillsDir, file),
        endpointCount: skill.endpoints.length,
        capturedAt: skill.capturedAt,
        provenance: skill.provenance ?? 'unsigned',
      });
    }
  }

  return summaries;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: All tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/skill/store.ts test/skill/store.test.ts
git commit -m "feat: auto-generated .gitignore — protect auth.enc from accidental commits"
```

---

### Task 10: Import Command — Validation + Trust Boundary

**Files:**
- Create: `test/skill/importer.test.ts`
- Create: `src/skill/importer.ts`

**Step 1: Write the failing test**

```typescript
// test/skill/importer.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateImport, importSkillFile } from '../../src/skill/importer.js';
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';
import type { SkillFile } from '../../src/types.js';

function makeSkill(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    version: '1.1',
    domain: 'api.example.com',
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: 'https://api.example.com',
    endpoints: [{
      id: 'get-data',
      method: 'GET',
      path: '/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: {
        request: { url: 'https://api.example.com/data', headers: {} },
        responsePreview: null,
      },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
    provenance: 'unsigned',
    ...overrides,
  };
}

describe('skill file import', () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-import-'));
    skillsDir = join(testDir, 'skills');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validateImport', () => {
    it('accepts a valid unsigned skill file', () => {
      const result = validateImport(makeSkill());
      assert.equal(result.valid, true);
      assert.equal(result.signatureStatus, 'unsigned');
    });

    it('accepts a valid signed skill file with correct key', () => {
      const key = deriveKey('test-id');
      const signed = signSkillFile(makeSkill(), key);
      const result = validateImport(signed, key);
      assert.equal(result.valid, true);
      assert.equal(result.signatureStatus, 'valid');
    });

    it('rejects a tampered signed skill file', () => {
      const key = deriveKey('test-id');
      const signed = signSkillFile(makeSkill(), key);
      signed.domain = 'evil.com';
      const result = validateImport(signed, key);
      assert.equal(result.valid, false);
      assert.equal(result.signatureStatus, 'invalid');
    });

    it('rejects skill file with SSRF URLs', () => {
      const skill = makeSkill({ baseUrl: 'http://localhost:8080' });
      const result = validateImport(skill);
      assert.equal(result.valid, false);
      assert.ok(result.reason!.includes('SSRF'));
    });

    it('rejects skill file with SSRF in endpoint URLs', () => {
      const skill = makeSkill();
      skill.endpoints[0].examples.request.url = 'http://192.168.1.1/admin';
      const result = validateImport(skill);
      assert.equal(result.valid, false);
    });

    it('rejects invalid JSON structure', () => {
      const result = validateImport({} as SkillFile);
      assert.equal(result.valid, false);
    });
  });

  describe('importSkillFile', () => {
    it('copies skill file with provenance set to imported', async () => {
      const filePath = join(testDir, 'import.json');
      await writeFile(filePath, JSON.stringify(makeSkill()));

      const result = await importSkillFile(filePath, skillsDir);
      assert.equal(result.success, true);

      const { readSkillFile } = await import('../../src/skill/store.js');
      const loaded = await readSkillFile('api.example.com', skillsDir);
      assert.equal(loaded!.provenance, 'imported');
      assert.equal(loaded!.signature, undefined);
    });

    it('rejects file with SSRF URLs', async () => {
      const skill = makeSkill({ baseUrl: 'http://localhost:8080' });
      const filePath = join(testDir, 'bad.json');
      await writeFile(filePath, JSON.stringify(skill));

      const result = await importSkillFile(filePath, skillsDir);
      assert.equal(result.success, false);
      assert.ok(result.reason!.includes('SSRF'));
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/skill/importer.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/skill/importer.ts
import { readFile } from 'node:fs/promises';
import { verifySignature } from './signing.js';
import { validateSkillFileUrls } from './ssrf.js';
import { writeSkillFile } from './store.js';
import type { SkillFile } from '../types.js';

export interface ImportValidation {
  valid: boolean;
  reason?: string;
  signatureStatus: 'valid' | 'invalid' | 'unsigned';
  summary?: {
    domain: string;
    endpointCount: number;
    baseUrl: string;
  };
}

export interface ImportResult {
  success: boolean;
  reason?: string;
  skillFile?: string;
}

/**
 * Validate a skill file for import.
 * Checks structure, SSRF safety, and signature integrity.
 */
export function validateImport(skill: SkillFile, localKey?: Buffer): ImportValidation {
  // Basic structure validation
  if (!skill.domain || !skill.baseUrl || !Array.isArray(skill.endpoints)) {
    return { valid: false, reason: 'Invalid skill file structure', signatureStatus: 'unsigned' };
  }

  // Signature check
  let signatureStatus: ImportValidation['signatureStatus'] = 'unsigned';
  if (skill.signature) {
    if (localKey && verifySignature(skill, localKey)) {
      signatureStatus = 'valid';
    } else {
      return {
        valid: false,
        reason: 'Skill file signature is invalid — file was tampered with or signed by a different instance',
        signatureStatus: 'invalid',
      };
    }
  }

  // SSRF validation
  const ssrfResult = validateSkillFileUrls(skill);
  if (!ssrfResult.safe) {
    return {
      valid: false,
      reason: `SSRF risk: ${ssrfResult.reason}`,
      signatureStatus,
    };
  }

  return {
    valid: true,
    signatureStatus,
    summary: {
      domain: skill.domain,
      endpointCount: skill.endpoints.length,
      baseUrl: skill.baseUrl,
    },
  };
}

/**
 * Import a skill file from disk.
 * Validates, strips foreign signatures, sets provenance to 'imported'.
 */
export async function importSkillFile(
  filePath: string,
  skillsDir?: string,
  localKey?: Buffer,
): Promise<ImportResult> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    return { success: false, reason: `Cannot read file: ${(err as Error).message}` };
  }

  let skill: SkillFile;
  try {
    skill = JSON.parse(content);
  } catch {
    return { success: false, reason: 'File is not valid JSON' };
  }

  const validation = validateImport(skill, localKey);
  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  // Strip foreign signature, set provenance
  const importedSkill: SkillFile = {
    ...skill,
    provenance: 'imported',
    signature: undefined,
  };

  const writtenPath = await writeSkillFile(importedSkill, skillsDir);
  return { success: true, skillFile: writtenPath };
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/skill/importer.test.ts`
Expected: All tests PASS

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/skill/importer.ts test/skill/importer.test.ts
git commit -m "feat: import command — validation pipeline with SSRF checks and provenance tracking"
```

---

### Task 11: Domain-Only Capture in Monitor

**Files:**
- Modify: `src/capture/monitor.ts`

This modifies the capture monitor to filter by target domain at the Playwright listener level. No dedicated unit test — the e2e test in Task 13 covers this.

**Step 1: Update the implementation**

```typescript
// src/capture/monitor.ts
import { chromium, type Browser, type Page } from 'playwright';
import { shouldCapture } from './filter.js';
import { isDomainMatch } from './domain.js';
import { SkillGenerator, type GeneratorOptions } from '../skill/generator.js';
import type { CapturedExchange } from '../types.js';

export interface CaptureOptions {
  url: string;
  port?: number;
  launch?: boolean;
  attach?: boolean;
  duration?: number;
  allDomains?: boolean;
  enablePreview?: boolean;
  scrub?: boolean;
  onEndpoint?: (endpoint: { id: string; method: string; path: string }) => void;
  onFiltered?: () => void;
}

export interface CaptureResult {
  generators: Map<string, SkillGenerator>;
  totalRequests: number;
  filteredRequests: number;
}

const DEFAULT_CDP_PORTS = [18792, 18800, 9222];

async function connectToBrowser(options: CaptureOptions): Promise<{ browser: Browser; launched: boolean }> {
  if (!options.launch) {
    const ports = options.port ? [options.port] : DEFAULT_CDP_PORTS;
    for (const port of ports) {
      try {
        const browser = await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 3000 });
        return { browser, launched: false };
      } catch {
        continue;
      }
    }
  }

  if (options.attach) {
    const ports = options.port ? [options.port] : DEFAULT_CDP_PORTS;
    throw new Error(`No browser found on CDP ports: ${ports.join(', ')}. Is a Chromium browser running with remote debugging?`);
  }

  const browser = await chromium.launch({ headless: false });
  return { browser, launched: true };
}

export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { browser, launched } = await connectToBrowser(options);
  const generators = new Map<string, SkillGenerator>();
  let totalRequests = 0;
  let filteredRequests = 0;

  // Extract target domain for domain-only filtering
  const targetUrl = options.url;

  const generatorOptions: GeneratorOptions = {
    enablePreview: options.enablePreview ?? false,
    scrub: options.scrub ?? true,
  };

  let page: Page;
  if (launched) {
    const context = await browser.newContext();
    page = await context.newPage();
  } else {
    const contexts = browser.contexts();
    if (contexts.length > 0 && contexts[0].pages().length > 0) {
      page = contexts[0].pages()[0];
    } else {
      const context = contexts[0] ?? await browser.newContext();
      page = await context.newPage();
    }
  }

  page.on('response', async (response) => {
    totalRequests++;

    const url = response.url();
    const status = response.status();
    const contentType = response.headers()['content-type'] ?? '';

    // Domain-only filtering (before any other processing)
    if (!options.allDomains) {
      const hostname = safeHostname(url);
      if (hostname && !isDomainMatch(hostname, targetUrl)) {
        filteredRequests++;
        options.onFiltered?.();
        return;
      }
    }

    if (!shouldCapture({ url, status, contentType })) {
      filteredRequests++;
      const hostname = safeHostname(url);
      if (hostname) {
        const gen = generators.get(hostname);
        if (gen) gen.recordFiltered();
      }
      options.onFiltered?.();
      return;
    }

    try {
      const body = await response.text();
      const hostname = new URL(url).hostname;

      if (!generators.has(hostname)) {
        generators.set(hostname, new SkillGenerator(generatorOptions));
      }
      const gen = generators.get(hostname)!;

      const exchange: CapturedExchange = {
        request: {
          url,
          method: response.request().method(),
          headers: response.request().headers(),
        },
        response: {
          status,
          headers: response.headers(),
          body,
          contentType,
        },
        timestamp: new Date().toISOString(),
      };

      const endpoint = gen.addExchange(exchange);
      if (endpoint) {
        options.onEndpoint?.({ id: endpoint.id, method: endpoint.method, path: endpoint.path });
      }
    } catch {
      // Response body may not be available (e.g. redirects); skip silently
    }
  });

  await page.goto(options.url, { waitUntil: 'domcontentloaded' });

  // Wait for duration or until interrupted
  if (options.duration) {
    await new Promise(resolve => setTimeout(resolve, options.duration! * 1000));
  } else {
    // Wait indefinitely — caller handles SIGINT
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
    });
  }

  if (launched) {
    await browser.close();
  }

  return { generators, totalRequests, filteredRequests };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/capture/monitor.ts
git commit -m "feat: domain-only capture — filter at Playwright listener level with --all-domains opt-out"
```

---

### Task 12: CLI Updates — New Flags, Import Command, Signing Integration

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/index.ts`

**Step 1: Update CLI with new flags and import command**

```typescript
// src/cli.ts
import { capture } from './capture/monitor.js';
import { writeSkillFile, readSkillFile, listSkillFiles } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';
import { AuthManager, getMachineId } from './auth/manager.js';
import { deriveKey } from './auth/crypto.js';
import { signSkillFile } from './skill/signing.js';
import { importSkillFile } from './skill/importer.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(rest[i]);
    }
  }

  return { command, positional, flags };
}

function printUsage(): void {
  console.log(`
  apitap — API interception for AI agents

  Usage:
    apitap capture <url>       Capture API traffic from a website
    apitap list                List available skill files
    apitap show <domain>       Show endpoints for a domain
    apitap replay <domain> <endpoint-id> [key=value...]
                               Replay an API endpoint
    apitap import <file>       Import a skill file with safety validation

  Capture options:
    --json                     Output machine-readable JSON
    --duration <seconds>       Stop capture after N seconds
    --port <port>              Connect to specific CDP port
    --launch                   Always launch a new browser
    --attach                   Only attach to existing browser
    --all-domains              Capture traffic from all domains (default: target only)
    --preview                  Include response data previews in skill files
    --no-scrub                 Disable PII scrubbing

  Import options:
    --yes                      Skip confirmation prompt
  `.trim());
}

const APITAP_DIR = join(homedir(), '.apitap');

async function handleCapture(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap capture <url>');
    process.exit(1);
  }

  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const json = flags.json === true;
  const duration = typeof flags.duration === 'string' ? parseInt(flags.duration, 10) : undefined;
  const port = typeof flags.port === 'string' ? parseInt(flags.port, 10) : undefined;

  if (!json) {
    const domainOnly = flags['all-domains'] !== true;
    console.log(`\n  🔍 Capturing ${url}...${duration ? ` (${duration}s)` : ' (Ctrl+C to stop)'}${domainOnly ? ' [domain-only]' : ' [all domains]'}\n`);
  }

  let endpointCount = 0;
  let filteredCount = 0;

  const result = await capture({
    url: fullUrl,
    duration,
    port,
    launch: flags.launch === true,
    attach: flags.attach === true,
    allDomains: flags['all-domains'] === true,
    enablePreview: flags.preview === true,
    scrub: flags['no-scrub'] !== true,
    onEndpoint: (ep) => {
      endpointCount++;
      if (!json) {
        console.log(`  ✓ ${ep.method.padEnd(6)} ${ep.path}`);
      }
    },
    onFiltered: () => {
      filteredCount++;
    },
  });

  // Get machine ID for signing and auth storage
  const machineId = await getMachineId();
  const key = deriveKey(machineId);
  const authManager = new AuthManager(APITAP_DIR, machineId);

  // Write skill files for each domain
  const written: string[] = [];
  for (const [domain, generator] of result.generators) {
    let skill = generator.toSkillFile(domain);
    if (skill.endpoints.length > 0) {
      // Store extracted auth
      const extractedAuth = generator.getExtractedAuth();
      if (extractedAuth.length > 0) {
        await authManager.store(domain, extractedAuth[0]);
      }

      // Sign the skill file
      skill = signSkillFile(skill, key);

      const path = await writeSkillFile(skill);
      written.push(path);
    }
  }

  if (json) {
    const output = {
      domains: Array.from(result.generators.entries()).map(([domain, gen]) => ({
        domain,
        endpoints: gen.toSkillFile(domain).endpoints.length,
      })),
      totalRequests: result.totalRequests,
      filtered: result.filteredRequests,
      skillFiles: written,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n  📋 Capture complete\n`);
    console.log(`  Endpoints:  ${endpointCount} discovered`);
    console.log(`  Requests:   ${result.totalRequests} total, ${result.filteredRequests} filtered`);
    for (const path of written) {
      console.log(`  Skill file: ${path}`);
    }
    console.log();
  }
}

async function handleList(flags: Record<string, string | boolean>): Promise<void> {
  const summaries = await listSkillFiles();
  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (summaries.length === 0) {
    console.log('\n  No skill files found. Run `apitap capture <url>` first.\n');
    return;
  }

  console.log();
  for (const s of summaries) {
    const ago = timeAgo(s.capturedAt);
    const prov = s.provenance === 'self' ? '✓' : s.provenance === 'imported' ? '⬇' : '?';
    console.log(`  ${prov} ${s.domain.padEnd(28)} ${String(s.endpointCount).padStart(3)} endpoints   ${ago}`);
  }
  console.log();
}

async function handleShow(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap show <domain>');
    process.exit(1);
  }

  const skill = await readSkillFile(domain);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}". Run \`apitap capture\` first.`);
    process.exit(1);
  }

  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  const provLabel = skill.provenance === 'self' ? 'signed ✓' : skill.provenance === 'imported' ? 'imported ⬇' : 'unsigned';
  console.log(`\n  ${skill.domain} — ${skill.endpoints.length} endpoints (captured ${timeAgo(skill.capturedAt)}) [${provLabel}]\n`);
  for (const ep of skill.endpoints) {
    const shape = ep.responseShape.type;
    const fields = ep.responseShape.fields?.length ?? 0;
    const hasAuth = Object.values(ep.headers).some(v => v === '[stored]');
    const authBadge = hasAuth ? ' 🔑' : '';
    console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(35)} ${shape}${fields ? ` (${fields} fields)` : ''}${authBadge}`);
  }
  console.log(`\n  Replay: apitap replay ${skill.domain} <endpoint-id>\n`);
}

async function handleReplay(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [domain, endpointId, ...paramArgs] = positional;
  if (!domain || !endpointId) {
    console.error('Error: Domain and endpoint required. Usage: apitap replay <domain> <endpoint-id> [key=value...]');
    process.exit(1);
  }

  const skill = await readSkillFile(domain);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}".`);
    process.exit(1);
  }

  // Parse key=value params
  const params: Record<string, string> = {};
  for (const arg of paramArgs) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      params[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }

  // Merge stored auth into endpoint headers for replay
  const machineId = await getMachineId();
  const authManager = new AuthManager(APITAP_DIR, machineId);
  const storedAuth = await authManager.retrieve(domain);

  // Check for [stored] placeholders and warn if auth missing
  const endpoint = skill.endpoints.find(e => e.id === endpointId);
  if (endpoint) {
    const hasStoredPlaceholder = Object.values(endpoint.headers).some(v => v === '[stored]');
    if (hasStoredPlaceholder && !storedAuth) {
      console.error(`Warning: Endpoint requires auth but no stored credentials found for "${domain}".`);
      console.error(`  Run \`apitap capture ${domain}\` to capture fresh credentials.\n`);
    }

    // Inject stored auth into a copy of the skill for replay
    if (storedAuth) {
      endpoint.headers[storedAuth.header] = storedAuth.value;
    }
  }

  const result = await replayEndpoint(skill, endpointId, Object.keys(params).length > 0 ? params : undefined);
  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify({ status: result.status, data: result.data }, null, 2));
  } else {
    console.log(`\n  Status: ${result.status}\n`);
    console.log(JSON.stringify(result.data, null, 2));
    console.log();
  }
}

async function handleImport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const filePath = positional[0];
  if (!filePath) {
    console.error('Error: File path required. Usage: apitap import <file>');
    process.exit(1);
  }

  const json = flags.json === true;
  const yes = flags.yes === true;

  // Get local key for signature verification
  const machineId = await getMachineId();
  const key = deriveKey(machineId);

  const result = await importSkillFile(filePath, undefined, key);

  if (!result.success) {
    if (json) {
      console.log(JSON.stringify({ success: false, reason: result.reason }));
    } else {
      console.error(`Error: ${result.reason}`);
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({ success: true, skillFile: result.skillFile }));
  } else {
    console.log(`\n  ✓ Imported skill file: ${result.skillFile}\n`);
  }
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'capture':
      await handleCapture(positional, flags);
      break;
    case 'list':
      await handleList(flags);
      break;
    case 'show':
      await handleShow(positional, flags);
      break;
    case 'replay':
      await handleReplay(positional, flags);
      break;
    case 'import':
      await handleImport(positional, flags);
      break;
    default:
      printUsage();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

**Step 2: Update index.ts exports**

```typescript
// src/index.ts
export { capture, type CaptureOptions, type CaptureResult } from './capture/monitor.js';
export { shouldCapture } from './capture/filter.js';
export { isBlocklisted } from './capture/blocklist.js';
export { isDomainMatch } from './capture/domain.js';
export { scrubPII } from './capture/scrubber.js';
export { SkillGenerator } from './skill/generator.js';
export { writeSkillFile, readSkillFile, listSkillFiles } from './skill/store.js';
export { signSkillFile, verifySignature } from './skill/signing.js';
export { validateImport, importSkillFile } from './skill/importer.js';
export { validateUrl, validateSkillFileUrls } from './skill/ssrf.js';
export { replayEndpoint, type ReplayResult } from './replay/engine.js';
export { AuthManager, getMachineId } from './auth/manager.js';
export type { SkillFile, SkillEndpoint, SkillSummary, CapturedExchange, StoredAuth } from './types.js';
```

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 5: Test CLI help output**

Run: `npx tsx src/cli.ts`
Expected: Updated usage text with new flags and import command

**Step 6: Commit**

```bash
git add src/cli.ts src/index.ts
git commit -m "feat: CLI v0.2 — import command, domain-only flag, preview toggle, auth integration"
```

---

### Task 13: End-to-End Verification and Final Polish

**Files:**
- Modify: `test/e2e/capture-replay.test.ts`
- Modify: `CLAUDE.md`

**Step 1: Update e2e test for v0.2 features**

Update `test/e2e/capture-replay.test.ts` to verify:
- Skill files have `provenance: 'self'` (signed)
- Auth headers are `[stored]` placeholders
- `responsePreview` is `null` by default

```typescript
// test/e2e/capture-replay.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../../src/capture/monitor.js';
import { writeSkillFile, readSkillFile } from '../../src/skill/store.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import { signSkillFile } from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';

describe('end-to-end: capture → skill file → replay', () => {
  let server: Server;
  let serverUrl: string;
  let testDir: string;

  before(async () => {
    // Start a simple JSON API server
    server = createServer((req, res) => {
      if (req.url === '/api/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Beta' },
        ]));
      } else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
      } else {
        // Serve a minimal HTML page that fetches from the API
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body><h1>Test Page</h1>
          <script>
            fetch('/api/items').then(r => r.json()).then(console.log);
            fetch('/api/status').then(r => r.json()).then(console.log);
          </script>
          </body></html>
        `);
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://localhost:${port}`;

    testDir = await mkdtemp(join(tmpdir(), 'apitap-e2e-'));
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(testDir, { recursive: true, force: true });
  });

  it('captures API traffic, generates skill file, and replays', async () => {
    // 1. Capture traffic (launch browser, navigate, wait 3s for fetches)
    const result = await capture({
      url: serverUrl,
      duration: 3,
      launch: true,
      allDomains: true,  // localhost would be filtered by domain-only mode
      onEndpoint: () => {},
      onFiltered: () => {},
    });

    // 2. Verify we captured endpoints
    assert.ok(result.generators.size > 0, 'Should have at least one domain');
    const domain = Array.from(result.generators.keys())[0];
    const gen = result.generators.get(domain)!;
    let skill = gen.toSkillFile(domain);

    assert.ok(skill.endpoints.length >= 2, `Expected >= 2 endpoints, got ${skill.endpoints.length}`);

    // 3. Verify v0.2 features
    assert.equal(skill.version, '1.1');
    assert.equal(skill.provenance, 'unsigned');  // Before signing

    // Sign the skill file
    const key = deriveKey('test-machine-id');
    skill = signSkillFile(skill, key);
    assert.equal(skill.provenance, 'self');
    assert.ok(skill.signature?.startsWith('hmac-sha256:'));

    // Verify response previews are null by default
    for (const ep of skill.endpoints) {
      assert.equal(ep.examples.responsePreview, null, `Preview should be null for ${ep.id}`);
    }

    // 4. Write and re-read skill file
    await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile(domain, testDir);
    assert.ok(loaded, 'Skill file should be readable');
    assert.equal(loaded!.endpoints.length, skill.endpoints.length);
    assert.equal(loaded!.provenance, 'self');

    // 5. Replay an endpoint
    const itemsEndpoint = skill.endpoints.find(e => e.path === '/api/items');
    assert.ok(itemsEndpoint, 'Should have /api/items endpoint');

    const replayResult = await replayEndpoint(loaded!, itemsEndpoint!.id);
    assert.equal(replayResult.status, 200);
    assert.deepEqual(replayResult.data, [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]);
  });
});
```

**Step 2: Run e2e test**

Run: `node --import tsx --test test/e2e/capture-replay.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 4: Update CLAUDE.md**

Add v0.2 security features to the CLAUDE.md documentation. Update the project status to v0.2 and add the new CLI flags.

Add to the **Architecture** section after "Core Components":

```markdown
### Security (v0.2)

- `capture/scrubber.ts` — PII detection and redaction (emails, phones, IPs, cards, SSNs).
- `capture/domain.ts` — Dot-prefix domain matching for capture filtering.
- `auth/crypto.ts` — AES-256-GCM encryption, PBKDF2 key derivation, HMAC-SHA256 signing.
- `auth/manager.ts` — Encrypted credential storage at `~/.apitap/auth.enc`.
- `skill/signing.ts` — HMAC-SHA256 skill file signing with three-state provenance (self/imported/unsigned).
- `skill/ssrf.ts` — URL validation against private IPs, internal hostnames, non-HTTP schemes.
- `skill/importer.ts` — Import validation pipeline: signature check → SSRF scan → confirmation.
```

Update the **Usage** section to include new flags:

```markdown
**Usage:**
- `npx tsx src/cli.ts capture <url>` — capture API traffic (domain-only by default)
- `npx tsx src/cli.ts capture <url> --all-domains` — capture all domains
- `npx tsx src/cli.ts capture <url> --preview` — include response data previews
- `npx tsx src/cli.ts capture <url> --no-scrub` — disable PII scrubbing
- `npx tsx src/cli.ts list` — list skill files (shows provenance)
- `npx tsx src/cli.ts show <domain>` — show endpoints (shows auth badges)
- `npx tsx src/cli.ts replay <domain> <endpoint-id>` — replay with stored auth
- `npx tsx src/cli.ts import <file>` — import skill file with safety validation
```

**Step 5: Bump version in package.json**

Change `"version": "0.1.0"` to `"version": "0.2.0"` in `package.json`.

**Step 6: Run all tests final time**

Run: `npm test`
Expected: All tests PASS

**Step 7: Verify type check**

Run: `npm run typecheck`
Expected: No errors

**Step 8: Commit and tag**

```bash
git add test/e2e/capture-replay.test.ts CLAUDE.md package.json package-lock.json
git commit -m "feat: v0.2 — privacy and security hardening complete"
git tag v0.2.0
```

---

## Task Dependency Graph

```
Task 1 (Schema) ──┬── Task 2 (PII Scrubber)
                   ├── Task 3 (Domain Matching)
                   ├── Task 4 (Crypto) ──── Task 5 (Auth Manager)
                   │                   └── Task 7 (Signing)
                   │
                   └── Task 6 (Generator Update) ← depends on Task 2, Task 4
                       │
                       ├── Task 8 (SSRF) ──── Task 10 (Importer) ← depends on Task 7, Task 8
                       ├── Task 9 (.gitignore)
                       ├── Task 11 (Monitor Update) ← depends on Task 3, Task 6
                       └── Task 12 (CLI) ← depends on all above
                           │
                           └── Task 13 (E2E + Polish) ← depends on Task 12
```

**Parallelizable groups:**
- Tasks 2, 3, 4 can run in parallel (no deps on each other, only on Task 1)
- Tasks 7, 8, 9 can run in parallel (after Task 4)
- Tasks 5, 6 can run after Task 4
- Task 10 needs Tasks 7 + 8
- Task 11 needs Tasks 3 + 6
- Task 12 needs everything
- Task 13 is final

# MCP Bugfixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 confirmed bugs: contractWarnings missing from batch replay, [stored] header resolution duplicated across transport layers, and misleading fromCache field.

**Architecture:** All three fixes are independent and can be committed separately. Fix 2 is the most impactful — it moves [stored] header resolution from 3 transport layers into the replay engine, eliminating a class of "forgot to update caller X" bugs.

**Tech Stack:** TypeScript, Node built-in test runner, `node:test` + `tsx`

---

### Task 1: Add contractWarnings to batch replay

**Files:**
- Modify: `src/replay/engine.ts:509-577`
- Test: `test/replay/batch.test.ts`

**Step 1: Write the failing test**

Add to `test/replay/batch.test.ts`, inside the existing `describe('replayMultiple')` block. Needs a new server that returns schema-drifted data.

```typescript
it('includes contractWarnings when schema drifts', async () => {
  // Create a server that returns drifted data (extra field, missing field)
  const driftServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Missing 'name' field, added 'email', id changed type
    res.end(JSON.stringify({ id: 'string-now', email: 'test@example.com' }));
  });
  await new Promise<void>(r => driftServer.listen(0, r));
  const driftUrl = `http://localhost:${(driftServer.address() as AddressInfo).port}`;

  // Write skill file with responseSchema
  const driftSkill: SkillFile = {
    ...makeSkill('drift.example.com', driftUrl, [{ id: 'get-user', method: 'GET', path: '/user' }]),
  };
  driftSkill.endpoints[0].responseSchema = {
    type: 'object',
    fields: {
      id: { type: 'number' },
      name: { type: 'string' },
    },
  };
  await writeSkillFile(driftSkill, testDir);

  const requests: BatchReplayRequest[] = [
    { domain: 'drift.example.com', endpointId: 'get-user' },
  ];
  const results = await replayMultiple(requests, { skillsDir: testDir, _skipSsrfCheck: true });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 200);
  assert.ok(results[0].contractWarnings, 'batch result should include contractWarnings');
  assert.ok(results[0].contractWarnings!.length > 0);

  const errors = results[0].contractWarnings!.filter(w => w.severity === 'error');
  assert.ok(errors.some(w => w.path === 'name'), 'should detect missing name field');

  await new Promise<void>(r => driftServer.close(() => r()));
});
```

Note: `createServer` is already imported in this test file. The `ContractWarning` type needs importing:
```typescript
import type { ContractWarning } from '../../src/contract/diff.js';
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/replay/batch.test.ts`
Expected: FAIL — `results[0].contractWarnings` is `undefined` because `BatchReplayResult` doesn't include it and `replayMultiple()` doesn't spread it.

**Step 3: Fix BatchReplayResult type and replayMultiple**

In `src/replay/engine.ts`:

1. Add import at top (line 10): `ContractWarning` is already imported via `diffSchema`.

2. Add `contractWarnings` to `BatchReplayResult` (after line 517):
```typescript
export interface BatchReplayResult {
  domain: string;
  endpointId: string;
  status: number;
  data: unknown;
  error?: string;
  tier?: string;
  capturedAt?: string;
  truncated?: boolean;
  contractWarnings?: ContractWarning[];  // <-- ADD THIS
}
```

3. Spread `contractWarnings` in the success path of `replayMultiple()` (line 576, after the truncated spread):
```typescript
        return {
          domain: req.domain,
          endpointId: req.endpointId,
          status: result.status,
          data: result.data,
          tier,
          capturedAt: skill.capturedAt,
          ...(result.truncated ? { truncated: true } : {}),
          ...(result.contractWarnings?.length ? { contractWarnings: result.contractWarnings } : {}),  // <-- ADD THIS
        };
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/replay/batch.test.ts`
Expected: All tests PASS, including the new contractWarnings test.

**Step 5: Commit**

```bash
git add src/replay/engine.ts test/replay/batch.test.ts
git commit -m "fix: include contractWarnings in batch replay results"
```

---

### Task 2: Move [stored] header resolution into replay engine

**Files:**
- Modify: `src/replay/engine.ts:223-241`
- Modify: `src/mcp.ts:170-181` (remove)
- Modify: `src/plugin.ts:98-118` (remove, pass authManager)
- Modify: `src/serve.ts:138-151` (remove)
- Test: `test/replay/engine.test.ts`

**Step 1: Write failing tests**

Add a new `describe` block at the end of `test/replay/engine.test.ts`:

```typescript
describe('replayEndpoint [stored] header resolution', () => {
  let storedServer: Server;
  let storedBaseUrl: string;
  let receivedHeaders: Record<string, string | undefined> = {};
  let testDir: string;
  let authManager: AuthManager;

  before(async () => {
    storedServer = createServer((req, res) => {
      receivedHeaders = {
        'x-client-id': req.headers['x-client-id'] as string | undefined,
        'authorization': req.headers['authorization'] as string | undefined,
        'x-api-key': req.headers['x-api-key'] as string | undefined,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => storedServer.listen(0, resolve));
    const port = (storedServer.address() as AddressInfo).port;
    storedBaseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => storedServer.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-stored-'));
    authManager = new AuthManager(testDir, 'test-machine-id');
    receivedHeaders = {};
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('resolves [stored] header when auth exists', async () => {
    await authManager.store('localhost', {
      type: 'custom', header: 'x-client-id', value: 'my-client-123',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(receivedHeaders['x-client-id'], 'my-client-123');
  });

  it('deletes unresolved [stored] headers instead of sending literal', async () => {
    // No auth stored — [stored] should be deleted, not sent
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'localhost', _skipSsrfCheck: true,
    });

    assert.equal(receivedHeaders['x-client-id'], undefined, 'should not send literal [stored]');
  });

  it('deletes unresolved [stored] headers when no authManager', async () => {
    const skill: SkillFile = {
      version: '1.2', domain: 'localhost', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    // No authManager provided at all
    await replayEndpoint(skill, 'get-data', { _skipSsrfCheck: true });

    assert.equal(receivedHeaders['x-client-id'], undefined, 'should not send literal [stored]');
  });

  it('uses cross-subdomain fallback for [stored] headers', async () => {
    // Store auth on parent domain
    await authManager.store('example.com', {
      type: 'custom', header: 'x-client-id', value: 'parent-domain-client',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'api.example.com', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'api.example.com', _skipSsrfCheck: true,
    });

    assert.equal(receivedHeaders['x-client-id'], 'parent-domain-client');
  });

  it('respects isolatedAuth flag — no fallback', async () => {
    await authManager.store('example.com', {
      type: 'custom', header: 'x-client-id', value: 'parent-value',
    });

    const skill: SkillFile = {
      version: '1.2', domain: 'api.example.com', capturedAt: new Date().toISOString(),
      baseUrl: storedBaseUrl, endpoints: [{
        id: 'get-data', method: 'GET', path: '/data',
        queryParams: {}, headers: { 'x-client-id': '[stored]' },
        responseShape: { type: 'object' },
        examples: { request: { url: `${storedBaseUrl}/data`, headers: {} }, responsePreview: null },
        isolatedAuth: true,
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self',
    };

    await replayEndpoint(skill, 'get-data', {
      authManager, domain: 'api.example.com', _skipSsrfCheck: true,
    });

    // Parent auth should NOT be found because isolatedAuth prevents fallback
    assert.equal(receivedHeaders['x-client-id'], undefined, 'should not fallback with isolatedAuth');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: The new [stored] tests FAIL — engine doesn't resolve [stored] headers yet, and literal `"[stored]"` gets sent.

**Step 3: Implement [stored] resolution in engine.ts**

In `src/replay/engine.ts`, after the existing bearer auth injection block (lines 233-241), add:

```typescript
  // Resolve [stored] placeholders in headers
  const storedHeaders = Object.entries(headers).filter(([_, v]) => v === '[stored]');
  if (storedHeaders.length > 0) {
    if (authManager && domain) {
      const auth = endpoint.isolatedAuth
        ? await authManager.retrieve(domain)
        : await authManager.retrieveWithFallback(domain);
      if (auth) {
        for (const [key] of storedHeaders) {
          if (key.toLowerCase() === auth.header.toLowerCase()) {
            headers[key] = auth.value;
          }
        }
      }
    }
    // Delete any remaining unresolved [stored] — literal "[stored]" causes server errors
    for (const [key] of Object.entries(headers)) {
      if (headers[key] === '[stored]') {
        delete headers[key];
      }
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: All tests PASS, including the new [stored] tests.

**Step 5: Remove [stored] resolution from mcp.ts**

In `src/mcp.ts`, delete lines 170-181 (the `hasStoredPlaceholder` block). The engine now handles this.

**Step 6: Remove [stored] resolution from plugin.ts**

In `src/plugin.ts`, delete lines 106-118 (the `hasStoredPlaceholder` block).

Also, make plugin pass `authManager` and `domain` to `replayEndpoint`. Change the replay call (lines 120-124) to:

```typescript
      try {
        const machineId = await getMachineId();
        const authManager = new AuthManager(APITAP_DIR, machineId);
        const result = await replayEndpoint(skill, endpointId, {
          params,
          authManager,
          domain,
          _skipSsrfCheck: options._skipSsrfCheck,
        });
        return { status: result.status, data: result.data };
```

Note: `getMachineId` and `AuthManager` imports may already exist — check before adding duplicates. The machineId/authManager creation can be hoisted if already present elsewhere in the function.

**Step 7: Remove [stored] resolution from serve.ts**

In `src/serve.ts`, delete the `hasStoredPlaceholder` block (lines 138-151). The engine already receives `authManager` and `domain` in the `replayEndpoint()` call (line 159-163), so it will handle [stored] resolution automatically.

**Step 8: Run full test suite**

Run: `npm test`
Expected: All tests PASS. No regressions.

**Step 9: Commit**

```bash
git add src/replay/engine.ts src/mcp.ts src/plugin.ts src/serve.ts test/replay/engine.test.ts
git commit -m "fix: move [stored] header resolution into replay engine

Eliminates duplicated [stored] resolution from mcp.ts, plugin.ts,
and serve.ts. The engine now handles cross-subdomain fallback and
deletes unresolved [stored] headers rather than sending literal
strings."
```

---

### Task 3: Rename fromCache to skillSource

**Files:**
- Modify: `src/orchestration/browse.ts:18-29, 116, 152, 187, 210`
- Modify: `src/mcp.ts:193, 201`
- Modify: `test/mcp/mcp.test.ts:275`
- Modify: `test/mcp/browse.test.ts:97`
- Modify: `test/orchestration/browse.test.ts:84`

**Step 1: Update the BrowseSuccess type**

In `src/orchestration/browse.ts`, change line 25:
```typescript
// OLD:
  fromCache: boolean;
// NEW:
  skillSource: 'disk' | 'discovered' | 'captured';
```

**Step 2: Update all fromCache assignments in browse.ts**

Line 116 (text-mode read path):
```typescript
// OLD:
  fromCache: false,
// NEW:
  skillSource: 'discovered',
```

Line 152 (second text-mode read):
```typescript
// OLD:
  fromCache: false,
// NEW:
  skillSource: 'discovered',
```

Line 187:
```typescript
// OLD:
  const fromCache = source === 'disk';
// NEW:
  const skillSource = source;
```

Line 210:
```typescript
// OLD:
  fromCache,
// NEW:
  skillSource,
```

**Step 3: Update mcp.ts**

Line 193:
```typescript
// OLD:
  const fromCache = !cached || cached.source === 'disk';
// NEW:
  const skillSource = cached?.source ?? 'disk';
```

Line 201:
```typescript
// OLD:
  fromCache,
// NEW:
  skillSource,
```

**Step 4: Update tests**

`test/mcp/mcp.test.ts:275`:
```typescript
// OLD:
  assert.equal(typeof data.fromCache, 'boolean');
// NEW:
  assert.ok(['disk', 'discovered', 'captured'].includes(data.skillSource));
```

`test/mcp/browse.test.ts:97`:
```typescript
// OLD:
  assert.equal(data.fromCache, true);
// NEW:
  assert.equal(data.skillSource, 'disk');
```

`test/orchestration/browse.test.ts:84`:
```typescript
// OLD:
  assert.equal(result.success && result.fromCache, true);
// NEW:
  assert.equal(result.success && result.skillSource, 'disk');
```

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS. TypeScript will catch any remaining `fromCache` references via `npm run typecheck`.

**Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: No errors. If any files still reference `fromCache`, the type change in `BrowseSuccess` will cause compile errors.

**Step 7: Commit**

```bash
git add src/orchestration/browse.ts src/mcp.ts test/mcp/mcp.test.ts test/mcp/browse.test.ts test/orchestration/browse.test.ts
git commit -m "fix: rename fromCache to skillSource with enum values

Replace misleading boolean (always true for replay) with
'disk' | 'discovered' | 'captured' enum that communicates
actual skill file provenance."
```

---

### Task 4: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS, no regressions.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Clean — no type errors.

**Step 3: Verify no remaining fromCache or [stored] resolution in transport layers**

Search for leftover references:
```bash
grep -rn 'fromCache' src/
grep -rn '\[stored\]' src/mcp.ts src/plugin.ts src/serve.ts
```

Expected: `fromCache` only in comments/docs (if any). `[stored]` not in mcp/plugin/serve transport layers.

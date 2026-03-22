# Usenet API Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add skill file tags, an `apitap stamp` command, `--allow-local` SSRF bypass, and Newznab/SABnzbd OpenAPI specs so AI agents can orchestrate the Usenet "search, grab, push, monitor" workflow.

**Architecture:** Four features layered bottom-up: (1) `tags` field on SkillFile with validation, index, and search support, (2) `allowLocal` metadata flag with replay engine SSRF bypass, (3) `apitap stamp` command that imports a spec onto a specific domain with auth and tags pre-wired, (4) Newznab and SABnzbd OpenAPI specs sourced from the community or written minimally.

**Tech Stack:** TypeScript (ESM, NodeNext), Node built-in test runner (`node:test`), Zod (MCP schemas), existing APITAP import/signing/store pipeline.

**Spec:** `docs/superpowers/specs/2026-03-21-usenet-api-support-design.md`

---

### Task 1: Add `tags` to SkillFile Type and IndexDomain Type

**Files:**
- Modify: `src/types.ts:142-170` (SkillFile interface)
- Modify: `src/skill/index.ts:16-21` (IndexDomain interface)

- [ ] **Step 1: Add `tags` field to `SkillFile`**

In `src/types.ts`, add after the `auth` field (line ~169) inside the `SkillFile` interface:

```typescript
tags?: string[];
```

- [ ] **Step 2: Add `allowLocal` field to `SkillFile.metadata`**

In `src/types.ts`, inside the `metadata` object of `SkillFile` (around line 166), add:

```typescript
allowLocal?: boolean;
```

- [ ] **Step 3: Add `tags` field to `IndexDomain`**

In `src/skill/index.ts`, add to the `IndexDomain` interface (after `capturedAt`, line ~19):

```typescript
tags?: string[];
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (all new fields are optional, no consumers break)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/skill/index.ts
git commit -m "feat: add tags and allowLocal to SkillFile and IndexDomain types"
```

---

### Task 2: Tag Validation in `writeSkillFile()`

**Files:**
- Modify: `src/skill/store.ts:39-74`
- Test: `test/skill/store.test.ts`

**Context:** `writeSkillFile()` at line 44 calls `validateSkillFile(skill)`. Tag validation should happen alongside this. The index update at lines 54-71 calls `updateIndex()` — extend it to pass tags.

- [ ] **Step 1: Write failing tests for tag validation**

Add to `test/skill/store.test.ts`:

```typescript
describe('tag validation', () => {
  it('accepts valid tags', async () => {
    const skill = makeSkill('tagged.example.com');
    skill.tags = ['newznab', 'usenet-indexer'];
    const path = await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile('tagged.example.com', testDir, { trustUnsigned: true });
    assert.deepStrictEqual(loaded.tags, ['newznab', 'usenet-indexer']);
  });

  it('rejects tags with uppercase', async () => {
    const skill = makeSkill('bad.example.com');
    skill.tags = ['Newznab'];
    await assert.rejects(() => writeSkillFile(skill, testDir), /invalid tag/i);
  });

  it('rejects tags with special characters', async () => {
    const skill = makeSkill('bad2.example.com');
    skill.tags = ['new_znab'];
    await assert.rejects(() => writeSkillFile(skill, testDir), /invalid tag/i);
  });

  it('rejects tags exceeding 32 characters', async () => {
    const skill = makeSkill('bad3.example.com');
    skill.tags = ['a'.repeat(33)];
    await assert.rejects(() => writeSkillFile(skill, testDir), /invalid tag/i);
  });

  it('rejects more than 16 tags', async () => {
    const skill = makeSkill('bad4.example.com');
    skill.tags = Array.from({ length: 17 }, (_, i) => `tag-${i}`);
    await assert.rejects(() => writeSkillFile(skill, testDir), /too many tags/i);
  });

  it('accepts skill files without tags (backward-compatible)', async () => {
    const skill = makeSkill('notags.example.com');
    const path = await writeSkillFile(skill, testDir);
    const loaded = await readSkillFile('notags.example.com', testDir, { trustUnsigned: true });
    assert.strictEqual(loaded.tags, undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: FAIL — validation not implemented yet (accepts invalid tags)

- [ ] **Step 3: Implement tag validation**

In `src/skill/store.ts`, add a `validateTags()` function before `writeSkillFile()`:

```typescript
const TAG_REGEX = /^[a-z0-9-]+$/;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 16;

function validateTags(tags: string[] | undefined): void {
  if (!tags) return;
  if (tags.length > MAX_TAGS) {
    throw new Error(`Too many tags: ${tags.length} (max ${MAX_TAGS})`);
  }
  for (const tag of tags) {
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(`Invalid tag "${tag}": exceeds ${MAX_TAG_LENGTH} characters`);
    }
    if (!TAG_REGEX.test(tag)) {
      throw new Error(`Invalid tag "${tag}": must match ${TAG_REGEX}`);
    }
  }
}
```

In `writeSkillFile()`, add after `validateSkillFile(skill)` (line ~44):

```typescript
validateTags(skill.tags);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skill/store.ts test/skill/store.test.ts
git commit -m "feat: add tag validation to writeSkillFile (regex, length, count)"
```

---

### Task 3: Pass Tags Through to Search Index

**Files:**
- Modify: `src/skill/store.ts:54-71` (index update call)
- Modify: `src/skill/index.ts:153-183` (updateIndex function)
- Test: `test/skill/store.test.ts`

**Context:** `writeSkillFile()` calls `updateIndex()` with individual params. Add `tags` as an optional parameter.

- [ ] **Step 1: Write failing test for tags in index**

Add to `test/skill/store.test.ts`:

```typescript
it('includes tags in search index', async () => {
  const skill = makeSkill('indexed.example.com');
  skill.tags = ['newznab'];
  await writeSkillFile(skill, testDir);

  const indexPath = join(testDir, '..', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf-8'));
  assert.deepStrictEqual(index.domains['indexed.example.com'].tags, ['newznab']);
});
```

Note: Adjust `indexPath` to match where `updateIndex()` writes the index relative to `skillsDir`. Check `src/skill/index.ts` line 36 for `indexPath()` — it resolves to `path.resolve(skillsDir, '..', 'index.json')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: FAIL — tags not passed to index

- [ ] **Step 3: Add tags parameter to `updateIndex()`**

In `src/skill/index.ts`, modify `updateIndex()` signature (line ~153) to accept optional tags:

```typescript
export async function updateIndex(
  domain: string,
  endpoints: IndexEndpoint[],
  provenance: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
  capturedAt: string = '',
  tags?: string[],
): Promise<void>
```

In the domain entry assignment (line ~170-175), add tags:

```typescript
index.domains[domain] = {
  endpointCount: endpoints.length,
  provenance: provenance as IndexDomain['provenance'],
  capturedAt,
  endpoints,
  ...(tags && tags.length > 0 ? { tags } : {}),
};
```

- [ ] **Step 4: Pass tags from `writeSkillFile()` to `updateIndex()`**

In `src/skill/store.ts`, modify the `updateIndex()` call (line ~54-71) to pass tags:

```typescript
await updateIndex(
  skill.domain,
  skill.endpoints.map(ep => ({
    id: ep.id,
    method: ep.method,
    path: ep.path,
    ...(ep.replayability?.tier ? { tier: ep.replayability.tier } : {}),
    ...(ep.replayability?.verified ? { verified: true } : {}),
  })),
  skill.provenance ?? 'unsigned',
  skillsDir,
  skill.capturedAt,
  skill.tags,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/skill/store.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS — no existing tests broken by optional parameter addition

- [ ] **Step 7: Commit**

```bash
git add src/skill/store.ts src/skill/index.ts test/skill/store.test.ts
git commit -m "feat: pass tags through writeSkillFile to search index"
```

---

### Task 4: Tag Filtering in `searchSkills()`

**Files:**
- Modify: `src/skill/search.ts:41-95`
- Test: `test/skill/search.test.ts`

**Context:** `searchSkills(query, skillsDir)` iterates `index.domains`, matches terms against domain/endpoint/path/method. Add `tags` parameter with AND filtering before text matching.

- [ ] **Step 1: Write failing tests for tag filtering**

Add to `test/skill/search.test.ts`. First update the `makeSkill` helper to support tags:

```typescript
function makeSkill(domain: string, endpoints: Array<{id: string; method: string; path: string}>, tags?: string[]): SkillFile {
  return {
    version: '1.2',
    domain,
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: `https://${domain}`,
    endpoints: endpoints.map(ep => ({
      id: ep.id,
      method: ep.method,
      path: ep.path,
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' as const },
      examples: { request: { url: `https://${domain}${ep.path}`, headers: {} }, responsePreview: {} },
    })),
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.4.0' },
    provenance: 'self' as const,
    ...(tags ? { tags } : {}),
  };
}
```

Then add the tests:

```typescript
describe('tag filtering', () => {
  it('filters results to matching tags (AND semantics)', async () => {
    await writeSkillFile(makeSkill('nzbgeek.com', [{ id: 'get-search', method: 'GET', path: '/api' }], ['newznab', 'usenet-indexer']), testDir);
    await writeSkillFile(makeSkill('other.com', [{ id: 'get-search', method: 'GET', path: '/api' }]), testDir);

    const result = await searchSkills('search', testDir, ['newznab']);
    assert.ok(result.found);
    assert.strictEqual(result.results!.length, 1);
    assert.strictEqual(result.results![0].domain, 'nzbgeek.com');
  });

  it('AND semantics: requires all tags', async () => {
    await writeSkillFile(makeSkill('partial.com', [{ id: 'get-search', method: 'GET', path: '/api' }], ['newznab']), testDir);

    const result = await searchSkills('search', testDir, ['newznab', 'usenet-indexer']);
    assert.ok(!result.found);
  });

  it('returns all results when no tags filter specified', async () => {
    await writeSkillFile(makeSkill('a.com', [{ id: 'get-x', method: 'GET', path: '/x' }], ['tagged']), testDir);
    await writeSkillFile(makeSkill('b.com', [{ id: 'get-x', method: 'GET', path: '/x' }]), testDir);

    const result = await searchSkills('x', testDir);
    assert.ok(result.found);
    assert.strictEqual(result.results!.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/skill/search.test.ts`
Expected: FAIL — `searchSkills()` doesn't accept `tags` parameter

- [ ] **Step 3: Add tags parameter and filtering logic**

In `src/skill/search.ts`, modify `searchSkills()` signature (line ~41):

```typescript
export async function searchSkills(
  query: string,
  skillsDir?: string,
  tags?: string[],
): Promise<SearchResponse>
```

Inside the domain iteration loop (line ~62), add tag filtering before text matching:

```typescript
for (const [domain, entry] of Object.entries(index.domains)) {
  // Tag filter (cheap, runs first)
  if (tags && tags.length > 0) {
    const domainTags = entry.tags ?? [];
    if (!tags.every(t => domainTags.includes(t))) continue;
  }

  // Existing text matching logic follows...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/skill/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skill/search.ts test/skill/search.test.ts
git commit -m "feat: add tag filtering to searchSkills (AND semantics)"
```

---

### Task 5: CLI `--tag` Flag on Search

**Files:**
- Modify: `src/cli.ts:336-363` (handleSearch)
- Test: Manual CLI test (no automated test — CLI is integration-tested via e2e)

**Context:** `handleSearch()` reads `positional` and `flags`, calls `searchSkills(query, SKILLS_DIR)`. Add `--tag` extraction and pass to `searchSkills()`.

- [ ] **Step 1: Extract `--tag` flag in `handleSearch()`**

In `src/cli.ts`, inside `handleSearch()` (around line 343), add after the `json` flag extraction:

```typescript
const tagFlag = flags.tag as string | undefined;
const tags = tagFlag ? tagFlag.split(',').map(t => t.trim()).filter(Boolean) : undefined;
```

- [ ] **Step 2: Pass tags to `searchSkills()`**

Change the `searchSkills()` call (line ~344):

```typescript
const result = await searchSkills(query, SKILLS_DIR, tags);
```

- [ ] **Step 3: Add tags to search output**

In the text output section of `handleSearch()`, if any results have tags, include them. Find the output formatting (around lines 350-362) and add tag display:

```typescript
// After existing fields in the result display loop:
if (r.tags && r.tags.length > 0) {
  console.log(`    tags: ${r.tags.join(', ')}`);
}
```

Note: This requires `SearchResult` to include tags. Add `tags?: string[]` to the `SearchResult` interface in `src/skill/search.ts` (line ~4-11), and populate it from the index entry during search.

- [ ] **Step 4: Update help text**

Find the usage/help section in `src/cli.ts` (around lines 82-170) and add `--tag` to the search command help:

```
apitap search <query> [--tag <name>] [--json]
```

- [ ] **Step 5: Test manually**

Run: `npx tsx src/cli.ts search api --tag nonexistent`
Expected: No results (or empty output)

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/skill/search.ts
git commit -m "feat: add --tag flag to apitap search CLI command"
```

---

### Task 6: MCP `apitap_search` Tags Parameter

**Files:**
- Modify: `src/mcp.ts:93-112`
- Test: `test/mcp/mcp.test.ts` (existing MCP test file)

**Context:** The MCP tool `apitap_search` uses Zod for input schema. Add optional `tags` array.

- [ ] **Step 1: Write failing test**

Add to `test/mcp/mcp.test.ts` (find the existing `apitap_search` test section):

```typescript
it('apitap_search accepts tags parameter', async () => {
  // Call the MCP tool with tags parameter
  const result = await callTool('apitap_search', { query: 'test', tags: ['newznab'] });
  // Should not error — just verify the parameter is accepted
  assert.ok(result);
});
```

Note: Adapt to the existing test pattern in `test/mcp/mcp.test.ts`. The exact helper (`callTool` or similar) depends on how MCP tests are structured.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/mcp/mcp.test.ts`
Expected: FAIL — Zod rejects unknown `tags` parameter

- [ ] **Step 3: Add tags to Zod schema and handler**

In `src/mcp.ts`, modify the `apitap_search` tool registration (line ~93-112):

```typescript
server.registerTool(
  'apitap_search',
  {
    description: '...existing description...',
    inputSchema: z.object({
      query: z.string().describe('Search query for finding skill files by domain, endpoint, or path'),
      tags: z.array(z.string()).optional().describe('Filter results to domains matching all specified tags'),
    }),
    annotations: { readOnlyHint: true, /* ... */ },
  },
  async ({ query, tags }) => {
    const result = await searchSkills(query, skillsDir, tags);
    return wrapExternalContent(result, 'apitap_search');
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/mcp/mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts test/mcp/mcp.test.ts
git commit -m "feat: add tags parameter to apitap_search MCP tool"
```

---

### Task 7: `allowLocal` SSRF Bypass in Replay Engine

**Files:**
- Modify: `src/replay/engine.ts:57-70` (ReplayOptions), `src/replay/engine.ts:302-312` (SSRF check)
- Test: `test/replay/engine.test.ts`

**Context:** The replay engine checks SSRF at three points (pre-fetch line 302, post-fetch line 487, redirect line 498). The `allowLocal` flag should bypass the private-IP check at all three points. The existing `_skipSsrfCheck` flag skips ALL SSRF checks (test-only). `allowLocal` is narrower — it only skips private-IP range validation.

- [ ] **Step 1: Write failing tests**

Add to `test/replay/engine.test.ts` (find existing SSRF test section):

```typescript
describe('allowLocal SSRF bypass', () => {
  it('allows replay to private IP when allowLocal is true', async () => {
    // Create a skill file with metadata.allowLocal = true
    // and baseUrl pointing to a private IP
    const skill: SkillFile = {
      version: '1.2',
      domain: '192.168.1.50:8080',
      baseUrl: 'http://192.168.1.50:8080',
      capturedAt: new Date().toISOString(),
      endpoints: [{
        id: 'get-api-status',
        method: 'GET',
        path: '/api',
        queryParams: { mode: { type: 'string', example: 'status' } },
        headers: {},
        responseShape: { type: 'object' },
        examples: { request: { url: 'http://192.168.1.50:8080/api?mode=status', headers: {} }, responsePreview: {} },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.9.3', allowLocal: true },
      provenance: 'imported-signed',
    };
    // Replay should NOT throw SSRF error
    // Note: will fail with connection refused (no server), but should NOT fail with SSRF blocked
    try {
      await replayEndpoint(skill, skill.endpoints[0], { allowLocal: true });
    } catch (e: any) {
      assert.ok(!e.message.includes('SSRF'), `Should not throw SSRF error, got: ${e.message}`);
    }
  });

  it('blocks replay to private IP when allowLocal is false', async () => {
    const skill: SkillFile = {
      version: '1.2',
      domain: '192.168.1.50:8080',
      baseUrl: 'http://192.168.1.50:8080',
      capturedAt: new Date().toISOString(),
      endpoints: [{
        id: 'get-api-status',
        method: 'GET',
        path: '/api',
        queryParams: { mode: { type: 'string', example: 'status' } },
        headers: {},
        responseShape: { type: 'object' },
        examples: { request: { url: 'http://192.168.1.50:8080/api?mode=status', headers: {} }, responsePreview: {} },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.9.3' },
      provenance: 'imported-signed',
    };
    await assert.rejects(
      () => replayEndpoint(skill, skill.endpoints[0], {}),
      /SSRF/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify the second test passes but the first fails**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: First test FAILS (SSRF blocks private IP even with allowLocal), second test PASSES

- [ ] **Step 3: Add `allowLocal` to `ReplayOptions`**

In `src/replay/engine.ts`, add to `ReplayOptions` interface (line ~57-70):

```typescript
allowLocal?: boolean;
```

- [ ] **Step 4: Implement allowLocal bypass in SSRF checks**

The SSRF check uses `resolveAndValidateUrl()` from `src/skill/ssrf.ts`. Rather than modifying the SSRF module, pass `allowLocal` as an option to `resolveAndValidateUrl()`.

Check `src/skill/ssrf.ts` for the `resolveAndValidateUrl()` signature. Add an `options` parameter:

```typescript
export async function resolveAndValidateUrl(
  urlString: string,
  options?: { allowLocal?: boolean },
): Promise<{ safe: boolean; reason?: string; resolvedIp?: string }>
```

Inside `resolveAndValidateUrl()`, find where private IP ranges are checked. When `options?.allowLocal` is true, skip the private-IP range check but keep all other validation (protocol, DNS rebinding, etc.).

In `src/replay/engine.ts`, at all SSRF check locations (lines ~308, ~491, ~504, and ~555 for retry-redirect), pass the `allowLocal` option. Grep for `resolveAndValidateUrl` to find all call sites:

```typescript
const ssrfCheck = await resolveAndValidateUrl(url.toString(), { allowLocal: options.allowLocal });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite to confirm no regressions**

Run: `npm test`
Expected: PASS — existing SSRF tests unchanged (allowLocal defaults to false)

- [ ] **Step 7: Commit**

```bash
git add src/replay/engine.ts src/skill/ssrf.ts test/replay/engine.test.ts
git commit -m "feat: add allowLocal SSRF bypass for local service replay"
```

---

### Task 8: Create `known-specs.json`

**Files:**
- Create: `src/data/known-specs.json`

**Context:** This is the protocol alias registry for the `stamp` command. Initially contains Newznab and SABnzbd entries. Per spec: bundled with package, not user-editable.

- [ ] **Step 1: Search for existing Newznab and SABnzbd OpenAPI specs**

Run these searches to find community specs:

```bash
# Search GitHub for Newznab OpenAPI specs
gh search repos "newznab openapi" --limit 10

# Search GitHub for SABnzbd OpenAPI specs
gh search repos "sabnzbd openapi" --limit 10

# Also check PyPI/npm for any published specs
```

Record the best spec URLs found. If none found, note that specs need to be authored (Task 10/11).

- [ ] **Step 2: Create `src/data/known-specs.json`**

```bash
ls ~/apitap/src/data/ 2>/dev/null || echo "Directory does not exist yet"
mkdir -p ~/apitap/src/data
```

```json
[
  {
    "name": "Newznab",
    "specUrl": "",
    "protocol": "newznab",
    "description": "Newznab-compatible Usenet indexer API"
  },
  {
    "name": "SABnzbd",
    "specUrl": "",
    "protocol": "sabnzbd",
    "description": "SABnzbd download client API"
  }
]
```

Note: `specUrl` values are intentionally empty — they will be populated in Tasks 11-12 once specs are sourced. `resolveSpecSource()` should treat an empty `specUrl` the same as a missing entry (fall through to URL/path handling).

- [ ] **Step 3: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/data/known-specs.json', 'utf-8')); console.log('OK')"`

- [ ] **Step 4: Commit**

```bash
git add src/data/known-specs.json
git commit -m "feat: add known-specs.json with Newznab and SABnzbd protocol aliases"
```

---

### Task 9: `apitap stamp` Command — Core Logic

**Files:**
- Create: `src/skill/stamp.ts`
- Test: `test/skill/stamp.test.ts`

**Context:** `stamp` resolves a spec source (protocol alias, URL, or file), imports it onto a target domain, wires auth, sets tags, and writes the skill file. It reuses `convertOpenAPISpec()` from `src/skill/openapi-converter.ts` and `writeSkillFile()` from `src/skill/store.ts`.

- [ ] **Step 1: Write failing tests**

Create `test/skill/stamp.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSpecSource } from '../src/skill/stamp.js';
import { readSkillFile } from '../src/skill/store.js';

describe('stamp', () => {
  describe('resolveSpecSource', () => {
    it('resolves protocol alias from known-specs', async () => {
      const result = await resolveSpecSource('newznab');
      assert.ok(result.startsWith('http') || result.startsWith('/'), `Expected URL or path, got: ${result}`);
    });

    it('passes through URLs unchanged', async () => {
      const url = 'https://example.com/spec.yaml';
      const result = await resolveSpecSource(url);
      assert.strictEqual(result, url);
    });

    it('passes through file paths unchanged', async () => {
      const path = '/tmp/spec.yaml';
      const result = await resolveSpecSource(path);
      assert.strictEqual(result, path);
    });

    it('throws on unknown protocol alias', async () => {
      await assert.rejects(() => resolveSpecSource('unknown-protocol'), /not found|unknown/i);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/skill/stamp.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement `resolveSpecSource()`**

Create `src/skill/stamp.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface KnownSpec {
  name: string;
  specUrl: string;
  protocol?: string;
  description?: string;
}

function loadKnownSpecs(): KnownSpec[] {
  const specPath = join(__dirname, '..', 'data', 'known-specs.json');
  try {
    return JSON.parse(readFileSync(specPath, 'utf-8'));
  } catch {
    return [];
  }
}

export async function resolveSpecSource(input: string): Promise<string> {
  // If it looks like a URL or file path, pass through
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('/') || input.startsWith('.')) {
    return input;
  }

  // Try protocol alias resolution
  const specs = loadKnownSpecs();
  const match = specs.find(s => s.protocol === input);
  if (match) {
    return match.specUrl;
  }

  throw new Error(`Unknown spec source "${input}". Not a URL, file path, or known protocol alias. Known protocols: ${specs.filter(s => s.protocol).map(s => s.protocol).join(', ')}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/skill/stamp.test.ts`
Expected: PASS (or partial pass — `resolveSpecSource('newznab')` depends on known-specs.json having a valid URL)

- [ ] **Step 5: Implement `stampSpec()` — the main stamp function**

Add to `src/skill/stamp.ts`:

```typescript
import { convertOpenAPISpec } from './openapi-converter.js';
import { writeSkillFile } from './store.js';
import { signSkillFileAs } from './signing.js';
import { AuthManager } from '../auth/manager.js';

export interface StampOptions {
  specSource: string;
  domain: string;
  apikey?: string;
  tags?: string[];
  limit?: number;
  allowLocal?: boolean;
  scheme?: 'http' | 'https';
  json?: boolean;
  skillsDir?: string;
  signingKey?: Buffer;
}

export interface StampResult {
  domain: string;
  endpointCount: number;
  tags: string[];
  provenance: string;
  baseUrl: string;
}

export async function stampSpec(options: StampOptions): Promise<StampResult> {
  const { specSource, domain, apikey, tags, limit, allowLocal, scheme = 'https', skillsDir, signingKey } = options;

  // 1. Resolve spec source
  const resolvedSource = await resolveSpecSource(specSource);

  // 2. Fetch and parse spec
  let specContent: string;
  if (resolvedSource.startsWith('http://') || resolvedSource.startsWith('https://')) {
    const resp = await fetch(resolvedSource);
    if (!resp.ok) throw new Error(`Failed to fetch spec: ${resp.status} ${resp.statusText}`);
    specContent = await resp.text();
  } else {
    const { readFile } = await import('node:fs/promises');
    specContent = await readFile(resolvedSource, 'utf-8');
  }

  // 3. Convert to endpoints
  // Note: convertOpenAPISpec() takes (spec, specUrl) and returns ImportResult { domain, endpoints, meta }
  const spec = JSON.parse(specContent);
  const importResult = convertOpenAPISpec(spec, resolvedSource);
  const endpoints = importResult.endpoints;
  if (limit) endpoints.splice(limit);

  // 4. Build skill file
  const baseUrl = `${scheme}://${domain}`;
  const skill = {
    version: '1.2',
    domain,
    capturedAt: new Date().toISOString(),
    baseUrl,
    endpoints,
    metadata: {
      captureCount: 0,
      filteredCount: 0,
      toolVersion: '1.0.0',  // matches convention used elsewhere in codebase
      ...(allowLocal ? { allowLocal: true } : {}),
    },
    provenance: 'imported-signed' as const,
    ...(tags && tags.length > 0 ? { tags } : {}),
  };

  // 5. Store auth
  // IMPORTANT: The replay engine's auth injection is header-only (injectAuthHeaders() sets
  // HTTP headers, not query params). For query-param auth (Newznab/SABnzbd), the agent
  // passes the apikey as a replay param: apitap_replay({..., params: {apikey: "key"}}).
  //
  // For header-based auth, store via AuthManager as usual.
  // For query-param auth, store via AuthManager (for potential future use) but also
  // set the apikey query param's example value in each endpoint so it's pre-filled.
  if (apikey) {
    const securitySchemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
    const hasHeaderAuth = Object.values(securitySchemes).some(
      (s: any) => s.type === 'apiKey' && s.in === 'header',
    );

    if (hasHeaderAuth) {
      // Header-based auth: store in AuthManager, injected at replay time
      const authManager = new AuthManager();
      const headerScheme = Object.values(securitySchemes).find(
        (s: any) => s.type === 'apiKey' && s.in === 'header',
      ) as any;
      await authManager.store(domain, {
        type: 'api-key',
        header: headerScheme.name ?? 'X-Api-Key',
        value: apikey,
      });
    } else {
      // Query-param auth (Newznab/SABnzbd pattern): set example values on endpoints
      // so the apikey is pre-filled in the queryParams. The agent can override at replay.
      const queryScheme = Object.values(securitySchemes).find(
        (s: any) => s.type === 'apiKey' && s.in === 'query',
      ) as any;
      const paramName = queryScheme?.name ?? 'apikey';
      for (const ep of endpoints) {
        ep.queryParams[paramName] = {
          type: 'string',
          example: apikey,
          required: false,
        };
      }
    }
  }

  // 6. Sign and write
  // Note: signSkillFileAs() returns a new object (does not mutate). Capture the return value.
  // Use 'imported-signed' provenance since stamp imports a spec onto a new domain.
  if (signingKey) {
    skill = signSkillFileAs(skill, signingKey, 'imported-signed');
  }
  await writeSkillFile(skill, skillsDir);

  return {
    domain,
    endpointCount: endpoints.length,
    tags: tags ?? [],
    provenance: skill.provenance,
    baseUrl,
  };
}
```

Note: Adapt the imports and function calls to match the exact signatures in the codebase. Check `convertOpenAPISpec()` — it may return a different structure than raw endpoints. Check `signSkillFile()` — it may use `signSkillFileAs()` for imported provenance. Check `AuthManager.store()` signature.

- [ ] **Step 6: Write integration test for stampSpec**

Add to `test/skill/stamp.test.ts`:

```typescript
describe('stampSpec', () => {
  let testDir: string;
  let specPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-stamp-'));

    // Write a minimal OpenAPI spec for testing
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      servers: [{ url: 'https://original.example.com' }],
      paths: {
        '/items': {
          get: {
            operationId: 'list-items',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    specPath = join(testDir, 'test-spec.json');
    await writeFile(specPath, JSON.stringify(spec));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('stamps a spec onto a new domain with tags', async () => {
    const result = await stampSpec({
      specSource: specPath,
      domain: 'stamped.example.com',
      tags: ['test-protocol'],
      skillsDir: join(testDir, 'skills'),
    });

    assert.strictEqual(result.domain, 'stamped.example.com');
    assert.strictEqual(result.endpointCount, 1);
    assert.deepStrictEqual(result.tags, ['test-protocol']);

    const loaded = await readSkillFile('stamped.example.com', join(testDir, 'skills'), { trustUnsigned: true });
    assert.strictEqual(loaded.domain, 'stamped.example.com');
    assert.strictEqual(loaded.baseUrl, 'https://stamped.example.com');
    assert.deepStrictEqual(loaded.tags, ['test-protocol']);
  });

  it('uses http scheme when specified', async () => {
    const result = await stampSpec({
      specSource: specPath,
      domain: '192.168.1.50:8080',
      scheme: 'http',
      allowLocal: true,
      skillsDir: join(testDir, 'skills'),
    });

    assert.strictEqual(result.baseUrl, 'http://192.168.1.50:8080');
  });
});
```

- [ ] **Step 7: Run tests**

Run: `node --import tsx --test test/skill/stamp.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/skill/stamp.ts test/skill/stamp.test.ts
git commit -m "feat: add stamp command core logic (resolveSpecSource + stampSpec)"
```

---

### Task 10: Wire `stamp` into CLI

**Files:**
- Modify: `src/cli.ts`

**Context:** Add `handleStamp()` function and wire it into the command dispatch switch (line ~2283). Follow the pattern of `handleImport()` (lines 528-639).

- [ ] **Step 1: Add `handleStamp()` function**

In `src/cli.ts`, add a `handleStamp` function near the other command handlers:

```typescript
async function handleStamp(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const specSource = positional[0];
  if (!specSource) {
    console.error('Error: Spec source required. Usage: apitap stamp <spec-source> --domain <host> [--apikey <key>] [--tags <csv>] [--allow-local] [--scheme http|https]');
    process.exit(1);
  }

  const domain = flags.domain as string;
  if (!domain) {
    console.error('Error: --domain flag required');
    process.exit(1);
  }

  const apikey = flags.apikey as string | undefined;
  const tagsStr = flags.tags as string | undefined;
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : undefined;
  const allowLocal = flags['allow-local'] === true;
  const scheme = (flags.scheme as string) === 'http' ? 'http' as const : 'https' as const;
  const limit = flags.limit ? parseInt(flags.limit as string, 10) : undefined;
  const json = flags.json === true;

  try {
    const result = await stampSpec({
      specSource,
      domain,
      apikey,
      tags,
      allowLocal,
      scheme,
      limit,
      skillsDir: SKILLS_DIR,
      signingKey: await getSigningKey(),
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Stamped ${result.endpointCount} endpoints onto ${result.domain}`);
      console.log(`  baseUrl: ${result.baseUrl}`);
      console.log(`  provenance: ${result.provenance}`);
      if (result.tags.length > 0) {
        console.log(`  tags: ${result.tags.join(', ')}`);
      }
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
```

Add the import for `stampSpec` at the top of the file:

```typescript
import { stampSpec } from './skill/stamp.js';
```

- [ ] **Step 2: Add `stamp` to command dispatch**

Find the command dispatch switch (line ~2283) and add:

```typescript
case 'stamp':
  await handleStamp(positional, flags);
  break;
```

- [ ] **Step 3: Add stamp to help text**

Find the usage/help output (around lines 82-170) and add:

```
  apitap stamp <spec> --domain <host> [--apikey <key>] [--tags <csv>] [--allow-local] [--scheme http|https] [--json]
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Test manually**

Run: `npx tsx src/cli.ts stamp --help`
Expected: Shows stamp in help text

Run: `npx tsx src/cli.ts stamp`
Expected: Error — spec source required

Run: `npx tsx src/cli.ts stamp /tmp/nonexistent.json --domain test.com`
Expected: Error — file not found

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire stamp command into CLI with help text"
```

---

### Task 11: Newznab OpenAPI Spec

**Files:**
- Create: `specs/newznab.yaml` (if no usable community spec found)

**Context:** Newznab uses query-param routing (`?t=<action>`) on a single `GET /api` path. The OpenAPI spec must use explicit `operationId` per operation to generate distinct endpoint IDs. All 6 operations share the path but differ by the `t` parameter.

- [ ] **Step 1: Search for existing specs**

```bash
# GitHub search
gh search repos "newznab openapi" --limit 10
gh search repos "newznab swagger" --limit 10

# SwaggerHub
npx tsx src/cli.ts import --from swaggerhub --query newznab --dry-run --limit 5

# Check common Newznab documentation
```

If a usable spec is found, download and validate it. If not, proceed to step 2.

- [ ] **Step 2: Verify `convertOpenAPISpec()` handles same-path operations**

Before writing the spec, test that `convertOpenAPISpec()` generates distinct endpoint IDs for operations sharing the same path but with different `operationId` values:

```bash
node --import tsx -e "
import { convertOpenAPISpec } from './src/skill/openapi-converter.js';
const spec = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0' },
  paths: {
    '/api': {
      get: {
        operationId: 'search',
        parameters: [{ name: 't', in: 'query', schema: { type: 'string', enum: ['search'] } }],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};
const result = convertOpenAPISpec(spec);
console.log(JSON.stringify(result.map(e => e.id), null, 2));
"
```

Note: OpenAPI 3.0 does NOT allow multiple GET operations on the same path. The Newznab spec will need to model each operation as a separate path OR use a single path with parameter enums. Test which approach `convertOpenAPISpec()` handles correctly.

**Option A:** If the converter handles `operationId` correctly, write a single-path spec with multiple operations (may require a custom approach).

**Option B:** Use path fragments or path-per-operation workaround: `/api/search`, `/api/tvsearch`, etc. — even though Newznab's real path is `/api?t=search`, model them as distinct paths for OpenAPI compatibility. The `queryParams` in the generated endpoint will include `t` with the correct value.

Determine the right approach based on test results.

- [ ] **Step 3: Write or adapt the Newznab spec**

Create `specs/newznab.yaml` with the 6 core endpoints from the design spec. Each operation must have:
- Explicit `operationId` (e.g., `search`, `tvsearch`, `movie`, `details`, `get`, `caps`)
- `t` as a required query parameter with a fixed enum value
- `apikey` as an optional query parameter
- Response schema matching Newznab XML/JSON responses

```yaml
openapi: '3.0.0'
info:
  title: Newznab API
  version: '1.0'
  description: Newznab-compatible Usenet indexer API
servers:
  - url: https://example.com
paths:
  # Model as separate paths for OpenAPI compatibility
  # The 't' query param is set per-operation
  /api:
    get:
      operationId: search
      summary: Full-text NZB search
      parameters:
        - name: t
          in: query
          required: true
          schema:
            type: string
            enum: [search]
        - name: q
          in: query
          required: true
          schema:
            type: string
          description: Search query
        - name: cat
          in: query
          schema:
            type: string
          description: Category IDs (comma-separated)
        - name: limit
          in: query
          schema:
            type: integer
          description: Max results
        - name: apikey
          in: query
          schema:
            type: string
      responses:
        '200':
          description: Search results
```

**Resolving the single-path problem:** OpenAPI 3.0 does not allow multiple GET operations on the same path. The converter at `src/skill/openapi-converter.ts:300-303` iterates `paths` then `HTTP_METHODS`, so there is exactly one GET per path object. Newznab needs 6 GET operations all on `/api`.

**Solution:** Write a single spec with 6 separate paths (`/api-search`, `/api-tvsearch`, `/api-movie`, `/api-details`, `/api-get`, `/api-caps`), each with its own `operationId`. After `convertOpenAPISpec()` generates the endpoints, post-process them in `stampSpec()`: patch every endpoint's `path` back to `/api` and ensure each has a `t` query param with the correct fixed value. This post-processing runs only when the protocol alias is `newznab` (simple if-check in `stampSpec()`). ~10 lines of code.

This works because Newznab servers route on `?t=`, not the path — so the actual HTTP request `GET /api?t=search&q=...` will work correctly. The `operationId` ensures distinct endpoint IDs (`get-search`, `get-tvsearch`, etc.).

- [ ] **Step 4: Test import**

```bash
npx tsx src/cli.ts stamp specs/newznab.yaml --domain test-indexer.example.com --tags newznab,usenet-indexer --json
```

Verify: 6 distinct endpoints generated with correct IDs.

- [ ] **Step 5: Update `known-specs.json`**

Update `src/data/known-specs.json` with the path to the spec (if bundled) or URL (if hosted):

```json
{
  "name": "Newznab",
  "specUrl": "./specs/newznab.yaml",
  "protocol": "newznab",
  "description": "Newznab-compatible Usenet indexer API"
}
```

Or use a raw GitHub URL if the spec is committed to the repo.

- [ ] **Step 6: Commit**

```bash
git add specs/newznab.yaml src/data/known-specs.json
git commit -m "feat: add Newznab OpenAPI spec and update known-specs registry"
```

---

### Task 12: SABnzbd OpenAPI Spec

**Files:**
- Create: `specs/sabnzbd.yaml` (if no usable community spec found)

**Context:** SABnzbd uses query-param routing (`?mode=<action>`) similar to Newznab. Same approach: explicit `operationId`, same converter caveats.

- [ ] **Step 1: Search for existing specs**

```bash
gh search repos "sabnzbd openapi" --limit 10
gh search repos "sabnzbd swagger" --limit 10
npx tsx src/cli.ts import --from swaggerhub --query sabnzbd --dry-run --limit 5
```

SABnzbd has official API docs at https://sabnzbd.org/wiki/advanced/api — check if they publish an OpenAPI spec.

- [ ] **Step 2: Write or adapt the SABnzbd spec**

Create `specs/sabnzbd.yaml` with the 4 core endpoints:

```yaml
openapi: '3.0.0'
info:
  title: SABnzbd API
  version: '1.0'
  description: SABnzbd download client API
servers:
  - url: http://localhost:8080
paths:
  /api:
    get:
      operationId: addurl
      summary: Add NZB by URL
      parameters:
        - name: mode
          in: query
          required: true
          schema:
            type: string
            enum: [addurl]
        - name: name
          in: query
          required: true
          schema:
            type: string
          description: URL of the NZB file
        - name: apikey
          in: query
          schema:
            type: string
        - name: output
          in: query
          schema:
            type: string
            enum: [json]
      responses:
        '200':
          description: Add result
```

Include all 4 operations: `addurl`, `queue`, `history`, `status`. Same `operationId` and converter caveats as Newznab.

- [ ] **Step 3: Test import**

```bash
npx tsx src/cli.ts stamp specs/sabnzbd.yaml --domain 192.168.1.50:8080 --allow-local --scheme http --tags sabnzbd --json
```

Verify: 4 distinct endpoints, `baseUrl` is `http://192.168.1.50:8080`, `metadata.allowLocal` is true.

- [ ] **Step 4: Update `known-specs.json`**

Add the SABnzbd entry alongside Newznab.

- [ ] **Step 5: Commit**

```bash
git add specs/sabnzbd.yaml src/data/known-specs.json
git commit -m "feat: add SABnzbd OpenAPI spec and update known-specs registry"
```

---

### Task 13: Verify Signing Includes Tags

**Files:**
- Test: `test/skill/signing.test.ts`

**Context:** Per spec, `canonicalize()` in `src/skill/signing.ts` already strips only `signature` and `provenance`, so `tags` is automatically included. This task verifies that assumption with an explicit test.

- [ ] **Step 1: Write test**

Add to `test/skill/signing.test.ts`:

```typescript
it('signature changes when tags are modified', () => {
  const skill1 = makeSkill('tag-test.example.com');
  skill1.tags = ['newznab'];
  const sig1 = signSkillFile(skill1, testKey);

  const skill2 = makeSkill('tag-test.example.com');
  skill2.tags = ['sabnzbd'];
  const sig2 = signSkillFile(skill2, testKey);

  assert.notStrictEqual(sig1, sig2, 'Different tags should produce different signatures');
});

it('signature changes when tags are added', () => {
  const skill1 = makeSkill('tag-test2.example.com');
  // No tags
  const sig1 = signSkillFile(skill1, testKey);

  const skill2 = makeSkill('tag-test2.example.com');
  skill2.tags = ['newznab'];
  const sig2 = signSkillFile(skill2, testKey);

  assert.notStrictEqual(sig1, sig2, 'Adding tags should change signature');
});
```

Adapt to the existing test patterns in `test/skill/signing.test.ts` — check how `makeSkill` and `signSkillFile` are used there.

- [ ] **Step 2: Run test**

Run: `node --import tsx --test test/skill/signing.test.ts`
Expected: PASS (tags already included via canonicalize)

- [ ] **Step 3: Commit**

```bash
git add test/skill/signing.test.ts
git commit -m "test: verify tags are included in HMAC signature"
```

---

### Task 14: Full Integration Test

**Files:**
- Test: `test/e2e/stamp.test.ts` (new)

**Context:** End-to-end test of the full stamp workflow: resolve spec, stamp onto domain, verify skill file, search by tag.

- [ ] **Step 1: Write e2e test**

Create `test/e2e/stamp.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stampSpec } from '../../src/skill/stamp.js';
import { searchSkills } from '../../src/skill/search.js';
import { readSkillFile } from '../../src/skill/store.js';

describe('stamp e2e', () => {
  let testDir: string;
  let skillsDir: string;
  let specPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-stamp-e2e-'));
    skillsDir = join(testDir, 'skills');

    // Minimal OpenAPI spec simulating Newznab
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Mock Newznab', version: '1.0' },
      servers: [{ url: 'https://original.example.com' }],
      paths: {
        '/api': {
          get: {
            operationId: 'search',
            parameters: [
              { name: 't', in: 'query', required: true, schema: { type: 'string', enum: ['search'] } },
              { name: 'q', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Results' } },
          },
        },
      },
    };
    specPath = join(testDir, 'mock-newznab.json');
    await writeFile(specPath, JSON.stringify(spec));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('stamps spec onto domain and is searchable by tag', async () => {
    // Stamp
    const result = await stampSpec({
      specSource: specPath,
      domain: 'api.nzbgeek.com',
      tags: ['newznab', 'usenet-indexer'],
      skillsDir,
    });

    assert.strictEqual(result.domain, 'api.nzbgeek.com');
    assert.ok(result.endpointCount >= 1);
    assert.deepStrictEqual(result.tags, ['newznab', 'usenet-indexer']);

    // Verify skill file
    const loaded = await readSkillFile('api.nzbgeek.com', skillsDir, { trustUnsigned: true });
    assert.strictEqual(loaded.baseUrl, 'https://api.nzbgeek.com');
    assert.deepStrictEqual(loaded.tags, ['newznab', 'usenet-indexer']);
    assert.strictEqual(loaded.provenance, 'imported-signed');

    // Search by tag
    const searchResult = await searchSkills('search', skillsDir, ['newznab']);
    assert.ok(searchResult.found);
    assert.strictEqual(searchResult.results![0].domain, 'api.nzbgeek.com');
  });

  it('stamps with allowLocal and http scheme', async () => {
    const result = await stampSpec({
      specSource: specPath,
      domain: '192.168.1.50:8080',
      allowLocal: true,
      scheme: 'http',
      tags: ['sabnzbd'],
      skillsDir,
    });

    const loaded = await readSkillFile('192.168.1.50:8080', skillsDir, { trustUnsigned: true });
    assert.strictEqual(loaded.baseUrl, 'http://192.168.1.50:8080');
    assert.strictEqual(loaded.metadata.allowLocal, true);
  });
});
```

- [ ] **Step 2: Run e2e test**

Run: `node --import tsx --test test/e2e/stamp.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add test/e2e/stamp.test.ts
git commit -m "test: add stamp e2e integration test"
```

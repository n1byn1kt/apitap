# Search Index Design

**Date:** 2026-03-21
**Status:** Approved
**Problem:** `apitap search` takes ~20s and `apitap list` takes ~10s because every call parses 345 JSON files (34MB), validates schemas, and verifies HMAC signatures sequentially.

## Goal

Sub-second search and list for both CLI and MCP tool usage. HMAC verification deferred to replay time only.

## Index Schema

Two-tier structure at `~/.apitap/index.json`:

```json
{
  "version": 1,
  "fileCount": 345,
  "builtAt": "2026-03-21T12:00:00Z",
  "domains": {
    "api.stripe.com": {
      "endpointCount": 446,
      "provenance": "imported-signed",
      "endpoints": [
        { "id": "get-getcharges", "method": "GET", "path": "/v1/charges" },
        { "id": "post-postcharges", "method": "POST", "path": "/v1/charges" }
      ]
    }
  }
}
```

**Why two-tier:** Domain-level search ("which domains match 'payments'?") scans only domain keys and counts — never touches endpoint arrays. Endpoint-level search ("stripe charges") expands only matching domains. The hot path stays fast.

**What's excluded:** Response shapes, examples, auth config, headers, query params, signatures. These are only needed at replay time, when the full skill file is read anyway.

### Exported types (`src/skill/index.ts`)

```typescript
export interface IndexEndpoint {
  id: string;
  method: string;
  path: string;
}

export interface IndexDomain {
  endpointCount: number;
  provenance: 'self' | 'imported-signed' | 'imported' | 'unsigned';
  endpoints: IndexEndpoint[];
}

export interface IndexFile {
  version: number;
  fileCount: number;
  builtAt: string;
  domains: Record<string, IndexDomain>;
}
```

### Provenance values

| Value | Meaning |
|---|---|
| `self` | Captured with response body, signed by this machine |
| `imported-signed` | Imported from OpenAPI spec, signed by this machine |
| `imported` | Foreign signature stripped (e.g., shared skill file) |
| `unsigned` | No signature present |

These match the existing `SkillFile.provenance` type. Agents and `listSkillFiles()` summaries may branch on this value.

## Stale Detection

On every search/list call, before reading the index:

```
readdir(skillsDir).length !== index.fileCount → rebuild
```

Zero extra I/O on the happy path (readdir is already needed to find the skills dir). Covers the common drift case: someone adds or removes a skill file outside `writeSkillFile()`.

**Secondary signal:** If `index.builtAt` is older than 24 hours and `fileCount` matches, log a soft warning: `Search index is over 24h old — run 'apitap index build' if you've edited skill files manually`. Does not trigger a rebuild automatically — just makes drift observable.

**In-place edit gap:** Stale detection does NOT catch edits to existing files (same file count, different content). This is the most likely drift case during development. Mitigation: `apitap index build` CLI command (see below), and the `--help` text for the command explicitly recommends running it after manual edits.

## Index Lifecycle

### Build triggers

1. **On write** — `writeSkillFile()` calls `updateIndex()` after successful write. Incremental: reads current index, updates the single changed domain entry, writes atomically.
2. **On delete** — `forgetSkillFile()` (the `apitap forget` command) calls `removeFromIndex()` to remove the domain entry.
3. **On stale detection** — full rebuild if `readdir().length !== index.fileCount`.
4. **Explicit CLI** — `apitap index build` forces a full rebuild. Logs progress.

### Build process (full rebuild)

```
readdir(skillsDir) → for each .json file:
  JSON.parse(file)  ← no validateSkillFile(), no HMAC check
  extract: domain, endpointCount, provenance, [{id, method, path}]
fileCount = readdir(skillsDir).filter(f => f.endsWith('.json')).length
→ write index.json atomically (tmp + rename)
```

`fileCount` is always derived from `readdir()` during a full rebuild — it reflects actual disk state, not indexed domain count.

No validation or signature checks during index build. The index is a read-only cache of metadata — not a trust boundary. Trust enforcement stays at replay time.

### Incremental update

When `writeSkillFile()` completes:

```
read existing index.json (or empty if missing)
index.domains[skill.domain] = { endpointCount, provenance, endpoints: [...] }
if domain is new (not previously in index):
  index.fileCount += 1
// fileCount unchanged for updates to existing domains
index.builtAt = now
write index.json atomically
```

`fileCount` is incremented only for genuinely new domains — not recalculated from `Object.keys(index.domains).length`, which could diverge from disk reality if a prior rebuild was partial or the index was hand-edited.

Single domain update, no full scan. Fast enough to run on every write without noticeable overhead.

### Remove from index

When `forgetSkillFile()` completes:

```
read existing index.json
delete index.domains[domain]
index.fileCount -= 1
write index.json atomically
```

## Search Flow (new)

### `searchSkills()` — index path

```
1. Read index.json (single file, ~1-2MB)
2. If missing → log warning, full rebuild, then read
3. If stale (fileCount mismatch) → full rebuild, then read
4. If >24h old → log soft warning (no rebuild)
5. Split query into terms
6. For each domain in index:
   a. If any term matches domain name → include all endpoints
   b. Else scan endpoints: if all terms match (id + method + path) → include
7. Return results
```

No `readSkillFile()`, no HMAC, no validation. Pure in-memory string matching on the index.

### `listSkillFiles()` — index path

```
1. Read index.json (with stale check)
2. Map domains → SkillSummary objects (domain, endpointCount, provenance)
3. Return
```

One file read instead of 345.

### `handleShow()` — skip HMAC

Currently calls `readSkillFile(domain, dir, { trustUnsigned: true })` which still verifies signatures. Change to skip verification entirely for browse-only operations:

```typescript
// Intentionally skip HMAC for browse-only — verification happens at replay time
readSkillFile(domain, dir, { verifySignature: false })
```

This already exists as a code path in `readSkillFile` (line 68: `options?.verifySignature !== false`). Just not used by `handleShow`. The code comment makes the security decision explicit for future readers.

## CLI Command

```
apitap index build    Force rebuild the search index
```

Help text:
```
  --help for index build:
    Force rebuild the search index from all skill files on disk.
    Run this after manually editing skill files outside of apitap commands.
```

Output:
```
  Rebuilding search index...
  Done: 345 domains, 11,126 endpoints indexed
```

## Fallback Behavior

If the index is missing (first run, deleted, etc.):
1. Log a warning: `Search index not found — rebuilding (this may take a moment)...`
2. Full rebuild
3. Proceed with search

**Not silent.** The user sees why it's slow the first time.

## Files Changed

| File | Change |
|---|---|
| `src/skill/index.ts` | **New.** Exports `IndexFile`, `IndexDomain`, `IndexEndpoint` types. Exports `buildIndex()`, `updateIndex()`, `removeFromIndex()`, `readIndex()`. |
| `src/skill/search.ts` | Replace `safeReadSkillFile` loop with index read via `readIndex()` |
| `src/skill/store.ts` | `writeSkillFile()` calls `updateIndex()` after write. `listSkillFiles()` rewritten to use index. |
| `src/cli.ts` | Add `apitap index build` command. `handleShow()` passes `verifySignature: false` with explanatory comment. |
| `test/skill/index.test.ts` | **New.** Index build, incremental update (new domain vs update), remove, stale detection, 24h warning, search-via-index. |

## What This Does NOT Change

- **Replay path** — still reads full skill file, verifies HMAC, checks SSRF. No shortcuts on the trust boundary.
- **Import path** — still validates, signs, writes. Index update is additive.
- **Skill file format** — unchanged. Index is a derived cache, not a source of truth.
- **Security model** — HMAC enforcement stays at replay time. Index contains no auth data, no secrets, no response bodies.

## Expected Performance

| Operation | Before | After |
|---|---|---|
| `apitap search "stripe"` | ~20s (345 file reads) | <100ms (1 file read) |
| `apitap list` | ~10s (345 file reads) | <50ms (1 file read) |
| `apitap show <domain>` | ~2s (HMAC verify) | <200ms (skip HMAC) |
| `writeSkillFile()` | ~50ms | ~60ms (+incremental index update) |

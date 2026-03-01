# MCP Bugfixes: contractWarnings batch, [stored] header fallback, fromCache rename

**Date**: 2026-02-28
**Scope**: 3 confirmed bugs from cross-site testing (PizzINT, Spotify, Twitch, Discord, GitHub, Reddit)
**Deferred**: OAuth/expiry lifecycle (separate brainstorm)

## Fix 1: contractWarnings in batch replay

**Bug**: `apitap_replay_batch` drops `contractWarnings` from individual replay results. `BatchReplayResult` type doesn't declare the field; `replayMultiple()` doesn't spread it.

Single replay is already fixed (commit 8999362, line 205 in mcp.ts).

### Changes

**`src/replay/engine.ts`**:
- Add `contractWarnings?: ContractWarning[]` to `BatchReplayResult`
- In `replayMultiple()`, spread from each `replayEndpoint()` result:
  `...(result.contractWarnings?.length ? { contractWarnings: result.contractWarnings } : {})`

**Tests**: Batch replay with an endpoint whose `responseSchema` differs from response. Assert `contractWarnings` present in that entry.

## Fix 2: Move [stored] header resolution into replay engine

**Bug**: `[stored]` placeholder resolution lives in the transport layer (mcp.ts, plugin.ts, serve.ts). mcp.ts uses `retrieveWithFallback()`, but plugin.ts and serve.ts use exact-only `retrieve()`. Cross-subdomain replay fails for custom headers (Spotify `guc3-spclient.spotify.com` sends literal `"[stored]"`).

**Root cause**: The pattern "update one caller, forget the others" is inherent when auth resolution is duplicated across three files.

### Design

Move [stored] resolution into `replayEndpoint()` in `engine.ts`. The engine already handles bearer auth injection (lines 233-241) — [stored] headers are the same concern.

**In `replayEndpoint()`, after existing bearer injection**:

1. Find all headers with value `'[stored]'`
2. If any exist and `authManager` + `domain` are provided:
   - Retrieve auth using `retrieveWithFallback()` (or exact `retrieve()` if `isolatedAuth`)
   - Replace headers matching `auth.header` (case-insensitive)
3. Delete any remaining unresolved `[stored]` headers — sending literal `"[stored]"` is worse than omitting
4. Emit debug log for each deleted unresolved header (e.g., `"deleted unresolved [stored] header 'x-client-id' for guc3-spclient.spotify.com"`) to aid diagnosis

**Remove [stored] resolution from**:
- `src/mcp.ts` (lines 171-181)
- `src/plugin.ts` (lines 106-118)
- `src/serve.ts` (lines 140-150)

These callers must pass `authManager` and `domain` to `replayEndpoint()` if they don't already.

### Multi-header note

Current `StoredAuth` holds one `header`/`value` pair per domain. With this fix, only one `[stored]` header resolves; others get deleted. This is intentionally safe — multi-header storage is a separate feature. Servers will return clear "missing header" errors rather than opaque failures from mangled `"[stored]"` values.

### Tests

- `replayEndpoint()` with `[stored]` headers resolves them when `authManager` has stored auth
- Unresolved `[stored]` headers are deleted, not sent as literals
- `isolatedAuth` flag prevents cross-subdomain fallback
- mcp.ts, plugin.ts, serve.ts no longer contain `[stored]` resolution code

## Fix 3: Rename fromCache to skillSource

**Bug**: `fromCache: true` on every `apitap_replay` response regardless of live HTTP. Means "skill file from disk" but reads as "cached response." Live 400/401 errors with `fromCache: true` confuses consumers.

### Design

Replace `fromCache: boolean` with `skillSource: 'disk' | 'discovered' | 'captured'`.

**`src/orchestration/browse.ts`**:
- Replace `const fromCache = source === 'disk'` with `const skillSource = source`
- All return statements: `skillSource` instead of `fromCache`
- Text-mode reads: `skillSource: 'disk'` (or introduce `'read'` if worth distinguishing)

**`src/mcp.ts`**:
- `apitap_replay`: Replace `const fromCache = !cached || cached.source === 'disk'` with `const skillSource = cached?.source ?? 'disk'`
- Response object: `skillSource` instead of `fromCache`
- `apitap_browse`: passes through from `browse()`, inherits change

**`src/types.ts`** (or `BrowseSuccess` interface):
- Replace `fromCache: boolean` with `skillSource: 'disk' | 'discovered' | 'captured'`

**Tests**: Update assertions from `fromCache` to `skillSource`.

## Summary of file changes

| File | Fix 1 | Fix 2 | Fix 3 |
|------|-------|-------|-------|
| `src/replay/engine.ts` | Add to BatchReplayResult + replayMultiple | Add [stored] resolution | - |
| `src/mcp.ts` | - | Remove [stored] block | Rename fromCache→skillSource |
| `src/plugin.ts` | - | Remove [stored] block, pass authManager | - |
| `src/serve.ts` | - | Remove [stored] block | - |
| `src/orchestration/browse.ts` | - | - | Rename fromCache→skillSource |
| `src/types.ts` | - | - | Update BrowseSuccess type |

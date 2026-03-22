# Design: Usenet API Support (Newznab + SABnzbd)

Skill file tags, a `stamp` command, and Newznab/SABnzbd skill files that enable AI agents to orchestrate the Usenet "search → grab → push → monitor" workflow using existing APITAP infrastructure.

## Motivation

Newznab is a standardized HTTP API that thousands of Usenet indexers implement identically. One OpenAPI spec covers NZBGeek, DOGnzb, NZBPlanet, and every other Newznab-compatible indexer. This is the ideal pattern for APITAP: capture once, replay everywhere.

Today, Usenet automation lives in self-contained UIs (Sonarr, Radarr) with no agent interface. An AI agent that can say "find me the best 1080p encode of X, push it to SABnzbd, and tell me when it's done" is a real workflow that nobody has built cleanly.

## Scope

**v1 (this spec):**
- `tags` field on `SkillFile` — lightweight metadata for grouping related skill files
- `apitap stamp` command — import a spec onto a specific domain with auth pre-wired
- Newznab OpenAPI spec — sourced from existing community specs, not written from scratch
- SABnzbd OpenAPI spec — same approach

**Deferred:**
- `apitap tag <domain> --add/--remove` edit command — tags at import/stamp time covers 95% of cases
- Sonarr/Radarr/NZBGet skill files — separate domains, separate specs, bonus not core
- `--header` and `--bearer` flags on `stamp` — for non-Newznab protocols that use header-based auth

**Future work (separate project):**
Using Usenet itself as a distribution layer for skill files — posting signed skill files to a newsgroup (e.g., `alt.binaries.apitap`) as yEnc-encoded attachments, with agents subscribing and auto-pulling new skill files via HMAC signature verification. Philosophically interesting (decentralized, no central registry, leverages existing Usenet infrastructure) but practically niche — requires Usenet access. Not designed here.

## Feature 1: `tags` Field on SkillFile

### Type change

In `src/types.ts`, add to `SkillFile`:

```typescript
tags?: string[];  // e.g., ["newznab", "usenet-indexer"]
```

### Validation

- Regex: `^[a-z0-9-]+$`
- Max length per tag: 32 characters
- Max tags per skill file: 16
- Validated at write time in `writeSkillFile()`
- Optional field, defaults to `undefined` (backward-compatible, no migration)

### Signing

Tags are automatically included in the HMAC signature via the existing `canonicalize()` function, which serializes all fields except `signature` and `provenance`. No change to `signing.ts` is needed — adding `tags` to the `SkillFile` type is sufficient.

### Search index

The domain-level entry in `~/.apitap/index.json` gains a `tags` array:

```jsonc
{
  "api.nzbgeek.com": {
    "endpointCount": 6,
    "provenance": "imported",
    "capturedAt": "2026-03-21T...",
    "tags": ["newznab", "usenet-indexer"],
    "endpoints": [...]
  }
}
```

Written by `writeSkillFile()` during the existing incremental index update. Stale detection unchanged.

### CLI

`apitap search` gains `--tag <name>` (repeatable):

```
apitap search --tag newznab
apitap search --tag newznab --tag usenet-indexer
```

Output includes a tags column when any results have tags.

### MCP

`apitap_search` gains an optional `tags` parameter:

```jsonc
"tags": {
  "type": "array",
  "items": {"type": "string"},
  "description": "Filter results to domains matching all specified tags"
}
```

### Filter semantics

AND logic: if `tags: ["newznab", "usenet-indexer"]` is specified, a domain must have *all* specified tags to match. Tag filtering happens before text matching (cheap filter first).

### Other tools

No other MCP tools change. `apitap_replay`, `apitap_read`, `apitap_discover` are tag-unaware — they operate on domains, not tags.

## Feature 2: `apitap stamp` Command

### CLI signature

```
apitap stamp <spec-source> --domain <host> --apikey <key> [--tags <csv>] [--limit N] [--json]
```

### Arguments and flags

| Argument/Flag | Type | Required | Description |
|---------------|------|----------|-------------|
| `<spec-source>` | positional | yes | URL, local file path, or protocol alias from `known-specs.json` |
| `--domain <host>` | string | yes | Target host to stamp the spec onto |
| `--apikey <key>` | string | no | API key to store via auth manager |
| `--tags <csv>` | string | no | Comma-separated tags, each validated against `^[a-z0-9-]+$`, max 32 chars |
| `--limit <n>` | number | no | Max endpoints to import (pass-through to import logic) |
| `--json` | boolean | no | Machine-readable JSON output |

### What it does (in order)

1. **Resolve spec source** — if `<spec-source>` matches a `protocol` field in any entry of `known-specs.json`, use that entry's spec URL. Otherwise treat as URL or file path. Lookup: `entries.find(e => e.protocol === input)`. ~3 lines.
2. **Fetch and parse** — reuses `convertOpenAPISpec()`. No new parsing logic.
3. **Generate skill file** — `domain` set to `--domain` value, `baseUrl` set to `https://<domain>`.
4. **Set tags** — from `--tags` flag, validated per Feature 1 rules.
5. **Store auth** — if `--apikey` provided:
   - Check OpenAPI `securitySchemes` for the auth mechanism (header vs. query param).
   - **Fallback:** if no `securitySchemes` detected and `--apikey` is provided, default to query-param auth (`?apikey=<key>`). Newznab and SABnzbd both use this pattern, and community specs often have incomplete `securitySchemes`.
   - Store via `authManager.store()`.
6. **Sign, validate, write** — existing pipeline: `signSkillFileAs('imported-signed')` → `writeSkillFile()`. Provenance is `imported-signed` (not `self`) since stamp imports a spec onto a new domain.
7. **Output** — domain, endpoint count, tags, provenance.

### known-specs.json integration

`known-specs.json` does not exist yet (issue #43 tracks it as a proposal). This spec includes creating it as new work.

**File location:** `src/data/known-specs.json` (bundled with the package, not user-editable).

**Loading:** `stamp` reads this file at startup via a simple `JSON.parse(readFileSync(...))`. No caching, no hot-reload — it's a small static file.

**Structure:** array of entries, each with an optional `protocol` field for alias resolution:

```jsonc
[
  {
    "name": "Newznab",
    "specUrl": "https://...",
    "protocol": "newznab"
  },
  {
    "name": "SABnzbd",
    "specUrl": "https://...",
    "protocol": "sabnzbd"
  }
]
```

**Resolution:** `entries.find(e => e.protocol === input)`. If no entry matches, `stamp` falls back to treating `<spec-source>` as a URL or file path.

### Deferred auth flags

`--header <name:value>` and `--bearer <token>` flags for non-Newznab protocols are deferred. `--apikey` covers the Newznab/SABnzbd use case. Noted here for future reference.

### Not included

`stamp` does not auto-discover indexers or batch-stamp multiple domains. One domain per invocation. Shell scripting handles the batch case.

## Feature 3: Newznab and SABnzbd Skill Files

### Spec sourcing strategy

Before writing a spec from scratch, search for existing community OpenAPI specs:

1. `apitap import --from github --topic openapi --query newznab`
2. `apitap import --from swaggerhub --query newznab`
3. Manual GitHub search for Newznab OpenAPI specs

If a usable spec is found, import it directly. If not (or incomplete), write a minimal OpenAPI 3.0 spec covering core endpoints only. Same approach for SABnzbd.

### Core Newznab endpoints

| Endpoint ID | Query param `t=` | Purpose | Workflow step |
|-------------|------------------|---------|---------------|
| `get-api-search` | `search` | Full-text search | Search |
| `get-api-tvsearch` | `tvsearch` | TV search (name/season/episode) | Search |
| `get-api-movie` | `movie` | Movie search (IMDB ID) | Search |
| `get-api-details` | `details` | NZB metadata | Grab (metadata) |
| `get-api-get` | `get` | Download NZB file (binary) | Grab (URL construction) |
| `get-api-caps` | `caps` | Server capabilities/categories | Discovery |

### Query-param routing caveat

All Newznab endpoints share the path `GET /api` and are distinguished by the `?t=` query parameter. The OpenAPI spec **must** use explicit `operationId` per operation to generate distinct endpoint IDs. Without `operationId`, `convertOpenAPISpec()` will collapse them into a single `get-api` endpoint.

This is a spec authoring requirement, not a code change. Verify during implementation that `convertOpenAPISpec()` respects `operationId` for same-path operations.

### Core SABnzbd endpoints

| Endpoint ID | Query param `mode=` | Purpose | Workflow step |
|-------------|---------------------|---------|---------------|
| `get-api-addurl` | `addurl` | Push NZB by URL | Push |
| `get-api-queue` | `queue` | Download queue status | Monitor |
| `get-api-history` | `history` | Completed downloads | Monitor |
| `get-api-status` | `status` | Server status | Monitor |

SABnzbd auth: API key as query param (`?apikey=XXX`), same pattern as Newznab.

### End-to-end agent workflow

```
1. Search:   apitap_replay(indexer, "get-api-search", {q: "ubuntu 24.04", cat: 5000})
              → returns search results with NZB IDs

2. Details:  apitap_replay(indexer, "get-api-details", {id: "<nzb-id>"})
              → returns metadata (title, size, group, category)

3. Push:     apitap_replay(sabnzbd, "get-api-addurl", {
               name: "https://<indexer>/api?t=get&id=<id>&apikey=<key>"
             })
              → SABnzbd fetches the NZB binary itself

4. Monitor:  apitap_replay(sabnzbd, "get-api-queue")
              → returns download progress, ETA, status
```

### Known limitation: NZB URL construction in step 3

The agent must construct the NZB download URL manually: `https://<baseUrl>/api?t=get&id=<id>&apikey=<stored-key>`. The `baseUrl` is available from the skill file domain. The `apikey` must be passed by the user at workflow time — it is stored in the encrypted auth manager and not returned in replay results.

This is a known limitation of the current auth model. The agent can work around it with clear prompting instructions. Not addressed in v1.

## Feature 4: `--allow-local` Flag on Stamp

### Problem

SABnzbd and NZBGet typically run on the local network (`http://192.168.1.x:8080`). APITAP's SSRF checks block private IPs by default. Without a per-domain opt-out, users must pass `--danger-disable-ssrf` on every replay — an unsafe global bypass.

### Solution

A per-domain `allowLocal` flag, stored in the skill file metadata and checked by the replay engine before SSRF validation.

### Stamp flag

```
apitap stamp sabnzbd --domain 192.168.1.50:8080 --apikey XXX --allow-local --tags sabnzbd
```

`--allow-local` sets `metadata.allowLocal: true` in the generated skill file.

### Type change

In `src/types.ts`, add to `SkillFile.metadata`:

```typescript
allowLocal?: boolean;  // Skip SSRF private-IP checks for this domain
```

### Replay engine behavior

In `src/replay/engine.ts`, before SSRF validation:

- If `skillFile.metadata.allowLocal === true`, skip the private-IP check for this request.
- All other SSRF checks remain (protocol validation, redirect following, DNS rebinding). Only the private/reserved IP range check is bypassed.
- This is a targeted exemption, not a global disable.

### Security note

`allowLocal` is included in the HMAC signature (via `canonicalize()`). An attacker cannot flip this flag without invalidating the signature. The flag is set at stamp time by the user — it requires explicit intent.

### baseUrl for local services

When `--allow-local` is provided, `stamp` should accept `--scheme http` (default is `https`). SABnzbd on a local network uses plain HTTP. The `baseUrl` becomes `http://<domain>`.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--allow-local` | boolean | false | Store `allowLocal: true` in skill file metadata |
| `--scheme <http\|https>` | string | `https` | URL scheme for baseUrl construction |

## Changes Summary

### Files modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `tags?: string[]` to `SkillFile` |
| `src/skill/store.ts` | Validate tags in `writeSkillFile()`, include tags in index update |
| `src/skill/signing.ts` | No change needed — `canonicalize()` already includes all non-excluded fields |
| `src/skill/search.ts` | Add `tags` filter parameter to `searchSkillFiles()` |
| `src/replay/engine.ts` | Check `metadata.allowLocal` before SSRF private-IP validation |
| `src/cli.ts` | Add `stamp` command, add `--tag` flag to `search` |
| `src/mcp.ts` | Add `tags` parameter to `apitap_search` tool schema |

### Files created

| File | Purpose |
|------|---------|
| `src/skill/stamp.ts` | `stamp` command logic (resolve spec source, import, wire auth, set tags) |
| `src/data/known-specs.json` | Protocol alias registry (new — issue #43). Initial entries: Newznab, SABnzbd. |
| `specs/newznab.yaml` | Newznab OpenAPI 3.0 spec (if no usable community spec found) |
| `specs/sabnzbd.yaml` | SABnzbd OpenAPI 3.0 spec (if no usable community spec found) |

### Tests

| Test file | Coverage |
|-----------|----------|
| `test/skill/stamp.test.ts` | Spec resolution (alias vs URL vs file), auth wiring (query param fallback), tag validation, allowLocal flag, output format |
| `test/replay/engine.test.ts` | allowLocal bypasses private-IP check, other SSRF checks still enforced |
| `test/skill/search.test.ts` | Tag filtering (AND semantics, empty tags, no tags), tag + text combined search |
| `test/skill/store.test.ts` | Tag validation regex, max length, tags in index update |
| `test/skill/signing.test.ts` | Verify tags are included in signature via existing canonicalize() |
| `test/mcp/search.test.ts` | `apitap_search` with tags parameter |

# Passive Index + On-Demand Promotion Design

**Date:** 2026-03-07
**Status:** Approved — ready for implementation planning
**Depends on:** Chrome extension v1 (2026-03-01)

## Summary

The Chrome extension silently observes API traffic via `webRequest` during normal browsing, building a lightweight index of discovered endpoints per domain. When an agent or user needs a full skill file, the extension briefly attaches CDP to capture response bodies and generates a complete skill file. The index continues accumulating after promotion, serving as a staleness detector for existing skill files.

Tagline: "Your browser writes your API docs as you work."

## Motivation

Skill files today require intentional setup — the user must click "Start Capture" or run `apitap capture`. This creates friction and limits coverage to sites the user explicitly decides to capture.

The passive index inverts this: skill files appear organically as a side effect of normal browsing. Every site the user visits gets silently catalogued. When an agent needs data from discord.com, the index already knows what endpoints exist, what auth type they use, and how often they're hit — before anyone asked.

## Two-Phase Architecture

### Phase 1: Silent Index (always-on)

Uses `webRequest.onCompleted` — no `chrome.debugger`, no infobar, invisible to the user.

Captures per request:
- Method + parameterized path (e.g., `GET /api/v10/channels/:id`)
- Query parameter names (never values — could contain PII)
- Auth type from request headers ("Bearer", "API Key", "Cookie" — never the token value)
- Response content-type (filter: only index JSON/GraphQL responses)
- `hasBody` boolean (content-length > 0, replaces noisy byte count)
- Pagination headers (Link, X-Total-Count, X-Has-More, X-Next-Cursor — structural metadata, not data)
- Hit count per endpoint (accumulated across visits)
- First/last seen timestamps

Design decisions:
- **Method clustering:** Entries are grouped by parameterized path with a `methods` array. `GET /api/channels/:id` and `PATCH /api/channels/:id` become one entry with `methods: ["GET", "PATCH"]`. Agents infer CRUD coverage at a glance.
- **GraphQL flagging:** Always `POST /graphql` — path is useless, operation names are in the body (unreadable via webRequest). Flag as `type: "graphql"` with a note that CDP capture is needed for operation discovery. Response size variance across hits is observable but not stored (too noisy).
- **Sensitive path blocklist:** Enforced at collection time, not at read time. Data that was never written can never leak. See Security section.

### Phase 2: Promotion to Full Skill File (on-demand)

Three promotion triggers, layered by consent level:

**(B) Manual — default, always available.** User opens popup, sees indexed domains with hit counts and endpoint maps, clicks "Generate full skill file." The popup makes the value legible before the user commits — "discord.com: 127 API calls observed, 8 endpoints mapped."

**(A) Agent-triggered — default, always available.** Agent requests capture via native messaging, extension shows a notification (reuses existing `consent.ts` flow), user approves, extension attaches CDP to the already-open tab, captures for 10-30 seconds, detaches. Chrome Store defensible: "user explicitly approved this capture."

**(C) Auto-promote — opt-in only.** On Nth revisit (configurable, default 3), extension auto-captures. Labeled "Auto-learn" in settings with explicit language: "ApiTap will briefly capture API traffic when you revisit sites." Power users who want the magic can have it. Everyone else gets safety by default.

Chrome Web Store policy note: MV3 has been progressively restricting `chrome.debugger`. Auto-attaching CDP to arbitrary tabs (C) could get flagged. The consent flow in (A) is the safest story for reviewers. Verify current MV3 debugger policy before implementing (C).

## Index Entry Schema

```typescript
interface IndexFile {
  v: 1;                        // schema version for future migration
  updatedAt: string;           // ISO timestamp of last write
  entries: IndexEntry[];
}

interface IndexEntry {
  domain: string;
  firstSeen: string;           // ISO timestamp
  lastSeen: string;            // ISO timestamp
  totalHits: number;           // all observed requests (including filtered)
  promoted: boolean;           // full skill file exists
  lastPromoted?: string;       // ISO timestamp of last CDP capture
  skillFileSource?: 'extension' | 'cli'; // who generated the skill file
  endpoints: IndexEndpoint[];
}

interface IndexEndpoint {
  path: string;                // parameterized: /api/v10/channels/:id
  methods: string[];           // ["GET", "PATCH", "DELETE"]
  authType?: string;           // "Bearer" | "API Key" | "Cookie" -- never the value
  hasBody: boolean;            // content-length > 0
  hits: number;                // per-endpoint count
  lastSeen: string;            // ISO timestamp
  pagination?: string;         // "cursor" | "offset" | "page"
  type?: 'graphql';            // flagged for special handling
  queryParamNames?: string[];  // ["limit", "offset", "q"] -- names only, never values
}
```

The format is essentially an OpenAPI skeleton auto-generated from real traffic — methods, paths, auth patterns, pagination — without any data content.

## Storage

**Single file: `~/.apitap/index.json`**

Not N JSON files per domain (awkward lifecycle queries), not SQLite (unnecessary dependency, MV3 service workers can't use it anyway). At 500 entries x 2-5KB each, this is a 1-2.5MB file. `Array.filter()` and `Array.sort()` handle all lifecycle operations in <5ms.

Schema version field (`v: 1`) at the top enables forward-compatible migration. Two lines of code now, saves a painful migration later.

Atomic writes: temp file + rename. Non-negotiable — interrupted writes must never corrupt the index.

## Sync Flow

1. Extension accumulates observations in `chrome.storage.local` (in-memory buffer in service worker, persisted to storage)
2. Flush triggers (hybrid):
   - On tab close (timely for per-site observations)
   - 5-minute batch timer (catches long-lived tabs)
   - `chrome.runtime.onSuspend` (best-effort safety net — MV3 service workers get killed without warning)
3. Native host reads `index.json`, merges incoming batch, writes atomically
4. CLI/MCP reads `index.json` (read-only) for agent queries

## Ownership Rules

The cleanest architectural decision: **the extension owns the index, the CLI owns skill files. They never write to each other's artifacts.**

- Extension writes `~/.apitap/index.json` via native host — observations, hit counts, timestamps, `promoted` flag
- CLI writes `~/.apitap/skills/<domain>.json` — full skill files (from Playwright capture)
- Extension writes skill files via native host — full skill files (from CDP promotion capture)
- No concurrent writers to either artifact. No merge logic needed. No locking needed.

Edge case: CLI's own `apitap capture` (Playwright-based) generates a skill file without the extension knowing. The index won't have a `promoted: true` flag for that domain. That's fine — the agent checks for a skill file first (fast path), falls back to the index. If a skill file exists from CLI capture, the index is irrelevant for that domain.

When the CLI generates a skill file, the `skillFileSource` field on the index entry stays unset (or gets set to `'cli'` if the CLI notifies the extension via native messaging). This matters for staleness detection — CLI-captured skill files (full Playwright session context) age differently than extension-captured ones (single CDP session).

## Lifecycle

- **Decay:** Entries with zero hits for 90 days get flagged stale. 30 days is too aggressive — people revisit sites in bursts, 6 weeks of inactivity doesn't mean a tool is abandoned.
- **Hard delete:** 180 days of zero hits. Generous but finite.
- **Soft cap:** 500 domains. Warn user to prune — never silently drop entries. At ~2-5KB per entry, 500 domains is ~2MB. Not a storage concern.
- **Post-promotion:** Index keeps accumulating hits after promotion. The promoted skill file is a snapshot in time. When hit count spikes after a long gap (site updated their API), that's the signal to re-capture. The index is a staleness detector for existing skill files.

## Security

### Sensitive Path Blocklist

Enforced at collection time in `sensitive-paths.ts`. Requests matching these patterns are never observed, never stored.

```typescript
const SENSITIVE_PATH_PATTERNS = [
  /\/login/i,
  /\/oauth/i,
  /\/token/i,
  /\/password/i,
  /\/passwd/i,
  /\/2fa/i,
  /\/mfa/i,
  /\/auth\b/i,       // /auth but not /authors
  /\/session\/new/i,
  /\/signup/i,
  /\/register/i,
  /\/forgot/i,
  /\/reset-password/i,
  /\/verify-email/i,
  /\/account\/security/i,
  /\/api-key/i,
  /\/credentials/i,
];
```

Implementation order: `sensitive-paths.ts` goes in **before** `observer.ts`. The blocklist must exist before the capture surface opens. Not even a single test run should accidentally observe a login flow.

### What the index never contains

- Header values (no tokens, no cookies, no auth credentials)
- Query parameter values (could contain search terms, user IDs, PII)
- Request or response bodies (not available via webRequest, and wouldn't want them)
- URLs matching sensitive path patterns (blocked at collection time)
- Any data from incognito mode (already blocked in current extension)

### Existing security measures (carry forward)

- `scrubAuthFromSkillJson()` applies to all promoted skill files
- `SENSITIVE_BODY_KEYS` regex scrubs password/token fields from body templates
- `SENSITIVE_HEADERS` set replaces auth header values with `[stored]`
- `isAllowedUrl()` blocks private IPs, internal schemes, dev tooling noise
- SSRF validation on any replayed URLs

## New Extension Components

| File | Purpose | Priority |
|------|---------|----------|
| `sensitive-paths.ts` | Blocklist patterns, enforced at observation time | First (before observer) |
| `observer.ts` | `webRequest.onCompleted` listener, builds in-memory observation buffer | Core |
| `index-store.ts` | Manages `chrome.storage.local` index, merge logic, flush scheduling | Core |
| `promotion.ts` | Orchestrates CDP capture for promotion (reuses existing `startCapture`/`stopCapture`) | Core |
| Popup additions | Indexed domains list with hit counts, "Generate full skill file" button, "Auto-learn" toggle | UI |

## CLI/MCP Integration

- **New CLI command:** `apitap discover [domain]` — show index entries (all or filtered by domain). `--json` for machine output.
- **New MCP tool:** `apitap_discover` — agent queries "what has been passively observed about this domain?" Better name than `apitap_index` — communicates what the agent uses it for, not the implementation detail.
- **Updated `apitap browse` pipeline:** check skill file (fast path) -> check index (is there passive data?) -> discover (probe for APIs) -> capture (last resort). The index becomes a new layer in the existing cascade.
- **Agent decision support:** Index entries inform whether to request full capture: "discord.com has 8 endpoints mapped, Bearer auth detected, 127 hits in the last week — should I request promotion?"

## Popup UX Additions

The popup becomes a discovery dashboard alongside the existing capture controls:

```
+------------------------------+
|  ApiTap                      |
|                              |
|  [Capture]  [Index]  [Gear]  |
|                              |
|  -- Index tab --             |
|                              |
|  discord.com          127 hits|
|    8 endpoints | Bearer auth |
|    [Generate skill file]     |
|                              |
|  github.com            43 hits|
|    12 endpoints | Cookie     |
|    [Skill file exists]       |
|                              |
|  reddit.com            89 hits|
|    6 endpoints | Bearer auth |
|    [Generate skill file]     |
|                              |
|  -- Settings (gear) --       |
|                              |
|  [ ] Auto-learn mode         |
|  "Automatically capture API  |
|   traffic on revisited sites"|
|  Revisit threshold: [3]      |
+------------------------------+
```

Domains with existing skill files show status instead of the generate button. Hit counts and endpoint counts make the value legible before the user commits to CDP capture.

## What This Is Not

- **Not a network logger.** No request/response content is stored in the index. It's a structural map, not a traffic capture.
- **Not a privacy risk if the blocklist works.** The index contains less information than browser history (no query param values, no body content, no auth tokens).
- **Not a replacement for CLI capture.** Playwright-based capture with full session context remains the gold standard. Extension promotion is a lightweight alternative for sites the user is already logged into.

## Future Considerations

- **Cross-device sync:** Index could sync via cloud storage or git. Not in scope — if this ever matters, it needs a proper backend, not local-file hacks.
- **Index-driven suggestions:** "You visit reddit.com 50x/day but don't have a skill file. Want one?" Push notification from extension.
- **Staleness alerts:** "discord.com skill file is 30 days old but the index shows 4 new endpoints since capture." Agent-visible signal for re-capture.

# ApiTap Architecture Design

**Date:** 2026-02-04
**Status:** Approved via brainstorming session

---

## Capture Layer: Playwright, Not Raw CDP

Use Playwright for the capture side. Raw `fetch()` for replay.

| Layer | Dependency | Rationale |
|-------|-----------|-----------|
| Capture | Playwright | `page.on('response')` gives clean API, `recordHAR()` for free, handles CDP lifecycle, abstracts future BiDi migration |
| Filter + Generator | None (pure logic) | Data transformation only |
| Replay | Node stdlib `fetch()` | Zero deps, portable |

Playwright is ~200MB but OpenClaw already ships it. For future standalone `npm install -g` use, consider an optional raw CDP adapter behind a pluggable interface. Not MVP.

---

## Replay Difficulty Classification

Every endpoint gets a tier — detected during capture, verified when possible.

### Tiers

- **Green** — Public JSON, permissive CORS, no signing. Replay trivially with `fetch()`.
- **Yellow** — Needs auth (Bearer/cookies) but no signing or anti-bot. Works with valid credentials.
- **Orange** — CSRF tokens, session binding, strict CORS. Replay possible but fragile.
- **Red** — Request signing, anti-bot (Cloudflare/Akamai), TLS fingerprinting. Needs browser.

### Detection Signals

| Signal | Detection | Impact |
|--------|-----------|--------|
| CORS strictness | `Access-Control-Allow-Origin` value | `*` = trivial, specific origin = spoof needed |
| Request signing | `X-Signature`, `X-Nonce`, HMAC headers | Likely unreplayable without reverse-engineering |
| Anti-bot | `cf-ray`, `__cf_bm`, Akamai `_abck` | Needs browser fingerprint |
| CSRF tokens | `X-CSRF-Token` headers, per-request tokens | Needs fetch-token-first step |
| Session binding | Large cookie sets, `__Secure-` prefixed | May expire fast |
| Auth complexity | None vs Bearer vs multi-cookie | Maps directly to tier |
| Rate limiting | `X-RateLimit-*`, `Retry-After`, 429s | Endpoint may be green for auth but throttled |
| GraphQL | Endpoint is `/graphql` | Try introspection — success = full schema |

### Auto-Verification

After capturing GET endpoints via Playwright, immediately replay each with raw `fetch()` and compare responses.

- Match → verified green
- 403/401 → auth-bound (yellow/orange)
- Different data → fingerprinted (orange/red)
- Blocked → anti-bot (red)

Constraints:
- GET only (POST/PUT/DELETE have side effects)
- One attempt per endpoint
- Within seconds of capture (while auth tokens are valid)
- Disable with `--no-verify`

Non-GET endpoints fall back to heuristic classification from signal headers.

### Skill File Schema

```json
{
  "id": "get-markets",
  "method": "GET",
  "path": "/api/markets",
  "replayability": {
    "tier": "green",
    "verified": true,
    "signals": ["cors-permissive", "no-signing", "public"],
    "rateLimit": { "remaining": 58, "resetSeconds": 60 },
    "notes": null
  }
}
```

---

## Browser Connection: Attach-First, Launch-Fallback

```
apitap capture <url>
  → Scan known CDP ports (18792, 18800, 9222)
  → Found? Attach + navigate
  → Not found? Launch browser via Playwright, navigate
```

Flags:
- `--attach` — Only attach, fail if no browser
- `--launch` — Always launch fresh
- `--port 9222` — Attach to specific CDP port

When attached to an existing browser, capture sees all traffic across tabs. Skill generator already groups by domain, so multi-domain capture works naturally.

---

## Capture Lifecycle

Default: run until Ctrl+C, with idle nudge.

```
🔍 Capturing polymarket.com... (Ctrl+C to stop)

  ✓ GET  /api/markets           [green ✓]  200  12 fields
  ✓ GET  /api/markets/:id       [green ✓]  200  8 fields
  ✓ GET  /api/events            [yellow]   200  needs auth
  ✗ POST /api/orders            [orange]   csrf-token detected
    filtered: 47 requests (analytics: 23, static: 18, tracking: 6)

  ⏸ No new endpoints for 15s — looks complete. Ctrl+C to finish.
```

On Ctrl+C — summary:

```
📋 Capture complete: polymarket.com

  Endpoints:  4 discovered (3 replayable, 1 fragile)
  Requests:   51 total, 4 kept, 47 filtered
  Duration:   34s
  Skill file: ~/.apitap/skills/polymarket.com.json

  Run 'apitap show polymarket.com' for details
  Run 'apitap replay polymarket.com get-markets' to test
```

Design principles:
- Endpoints appear when first discovered, not on every repeat request
- `[green ✓]` = verified via auto-replay. No checkmark = heuristic only.
- Filtered noise is a rolling counter, not individual lines
- Idle nudge is informational — does not auto-stop

Three modes for different users:
- **Interactive:** Ctrl+C when satisfied (default)
- **Duration:** `--duration 30s` for scripted use
- **Idle-timeout:** `--idle-timeout 10s` for agents — auto-stop when API surface is mapped

Verbosity: default (discoveries only), `--quiet` (summary only, agent-friendly), `--verbose` (all requests including filtered).

---

## CLI Design: "The CLI Is the API"

Every command supports `--json` for machine-readable output. Agents use the same commands humans do.

### Commands

```
apitap capture <url>                    # Capture API traffic
apitap list [--json]                    # List available skill files
apitap show <domain> [--json]           # Show endpoints for a domain
apitap replay <domain> <endpoint>       # Replay an endpoint
```

### Human vs Agent Output

```
$ apitap list
  polymarket.com        4 endpoints   3 green  1 orange   2h ago
  api.github.com       12 endpoints   8 green  4 yellow   3d ago

$ apitap list --json
[
  {
    "domain": "polymarket.com",
    "skillFile": "~/.apitap/skills/polymarket.com.json",
    "endpoints": 4,
    "replayability": { "green": 3, "yellow": 0, "orange": 1, "red": 0 },
    "capturedAt": "2026-02-04T14:30:00Z",
    "verified": true
  }
]
```

### Skill File Storage

```
~/.apitap/skills/
├── polymarket.com.json
├── api.github.com.json
└── jsonplaceholder.typicode.com.json
```

One file per domain. Predictable, `ls`-able.

---

## OpenClaw Plugin: Three Stateless Tools

The plugin registers three tools, all backed by CLI commands with `--json`.

### Tools

```
apitap_search(query)                    → apitap list --json + endpoint search
apitap_replay(domain, endpoint, params) → apitap replay ... --json
apitap_capture(url, options)            → apitap capture ... --json --quiet
```

### Agent Decision Tree

```
Agent: "get Polymarket markets"
  │
  ├─ apitap_search("polymarket markets")
  │    → { found: true, endpoint: "get-markets", tier: "green", verified: true }
  │    → tier is green → safe to replay
  │
  └─ apitap_replay("polymarket.com", "get-markets", { limit: 10 })
       → { data: [...], status: 200 }
```

No skill file:
```
  ├─ apitap_search("polymarket markets")
  │    → { found: false, suggestion: "run apitap_capture" }
  │
  ├─ apitap_capture("polymarket.com", { duration: "30s" })
  │    → { endpoints: 4, green: 3, yellow: 1 }
  │
  └─ apitap_replay(...)
```

Orange/red endpoint:
```
  ├─ apitap_search("polymarket orders")
  │    → { found: true, tier: "orange", reason: "csrf-token",
  │        recommendation: "use browser" }
  │
  └─ Agent falls back to browser automation
```

The tier system gives agents a clear signal without needing to understand HTTP security.

### Future: Async Capture

`apitap_capture` is synchronous (30s+ tool call) in MVP. Future improvement: start capture → return handle → agent polls for completion. The CLI's `--duration` flag bounds the wait time, which is sufficient for v0.1.

### Plugin Size

~50 lines of tool registration. No daemon, no custom protocol, no state management. Skill files on disk are the state.

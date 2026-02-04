# Architecture Document

*Brainstorming output — Clawd + Claude Code (partial), 2026-02-04*

---

## 1. Name Candidates

Since "apitab" is taken:

| Name | CLI Command | Vibe |
|------|-------------|------|
| **apitap** | `apitap capture polymarket.com` | Tapping into the API stream |
| **webrift** | `webrift learn polymarket.com` | Rift between browser and API |
| **skipbrowser** | `skipbrowser capture` | Does what it says |
| **netsniff** | `netsniff record` | Sniffing the network layer |
| **rawfetch** | `rawfetch learn` | Raw fetch, no browser rendering |
| **apilens** | `apilens discover` | Lens into the API layer |
| **wirecut** | `wirecut capture` | Cut the wire between browser and data |
| **shortcut** | `shortcut learn` | Shortcut past the browser |
| **tapline** | `tapline record` | Tapping into the data line |
| **bypass** | `bypass capture` | Bypass the browser layer |

**Recommendation:** `apitap` — short, memorable, descriptive, works as CLI command and npm package name.

---

## 2. Architecture Overview

### Core Insight
Every SPA fetches JSON from internal APIs. The browser renders that JSON into HTML. Browser automation scrapes HTML back into data. We skip the middle: intercept the JSON directly.

### Approach
**CDP Network Monitor + Portable Skill Files**

- Use Chrome DevTools Protocol to passively record API calls during normal browsing
- Filter noise (analytics, ads, tracking) from real data APIs
- Generate portable JSON "skill files" — maps of discovered endpoints
- Replay via direct HTTP calls (no browser needed)

### Data Flow

```
CAPTURE MODE:
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │────▶│   CDP    │────▶│  Filter  │────▶│  Skill   │
│ (OpenClaw)│     │ Monitor  │     │  Engine  │     │ Generator│
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                  Network.*                          writes to
                  events                             skills/*.json

REPLAY MODE:
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Agent   │────▶│  Replay  │────▶│  Target  │
│ (OpenClaw│     │  Engine  │     │  API     │
│  or CLI) │     │ (fetch)  │     │          │
└──────────┘     └──────────┘     └──────────┘
                  reads from
                  skills/*.json
```

---

## 3. Core Components

### A. CDP Monitor (`src/capture/monitor.ts`)
**Responsibility:** Attach to Chrome/Chromium via CDP, listen for network events.

- Connect to CDP on configurable port (default: OpenClaw's 18792 or 18800)
- Enable `Network` domain
- Listen for `Network.requestWillBeSent` + `Network.responseReceived`
- Capture request/response bodies via `Network.getResponseBody`
- Pass raw traffic to Filter Engine

### B. Filter Engine (`src/capture/filter.ts`)
**Responsibility:** Separate signal (real APIs) from noise (analytics, tracking, static assets).

**Filtering layers:**
1. **Content-Type filter** — keep `application/json`, `application/graphql`, `text/json`. Drop images, CSS, fonts, HTML.
2. **URL pattern blocklist** — drop known analytics/tracking domains:
   - `google-analytics.com`, `googletagmanager.com`, `facebook.net`
   - `doubleclick.net`, `segment.io`, `hotjar.com`, `sentry.io`
   - `*.ads.*`, `*.tracking.*`, `*.pixel.*`
3. **Response size filter** — skip tiny responses (<50 bytes, likely beacons) and huge ones (>5MB, likely downloads)
4. **Method filter** — capture GET, POST, PUT, PATCH, DELETE. Skip OPTIONS, HEAD.
5. **Smart heuristics:**
   - If response is JSON array with >5 items of same shape → likely data API ✅
   - If response contains user-facing data (names, prices, titles) → likely data API ✅
   - If URL contains `/api/`, `/v1/`, `/v2/`, `/graphql` → likely API ✅
   - If URL contains `/analytics`, `/track`, `/log`, `/beacon` → noise ❌

**Configurable:** User can add custom allow/block patterns.

### C. Skill Generator (`src/skill/generator.ts`)
**Responsibility:** Take filtered API calls and produce portable skill files.

- Group requests by domain
- Detect endpoint patterns (parameterized URLs: `/api/users/123` → `/api/users/:id`)
- Capture auth patterns (where tokens appear: header, cookie, query param)
- Detect pagination patterns (offset, cursor, page params)
- Output skill JSON file per domain

### D. Replay Engine (`src/replay/engine.ts`)
**Responsibility:** Execute API calls from skill files without a browser.

- Read skill file for target domain
- Substitute parameters from agent's request
- Apply stored auth (tokens, cookies)
- Execute via native `fetch()` (Node 18+)
- Return clean JSON to caller

### E. Auth Manager (`src/auth/manager.ts`)
**Responsibility:** Handle authentication lifecycle.

- Detect auth type from captured requests (Bearer, Cookie, API Key, Basic)
- Store auth credentials in skill file (encrypted at rest)
- Detect token expiration (401/403 responses)
- Support refresh flows: re-capture auth by briefly opening browser
- Never store plaintext secrets in skill files on disk — use OS keyring or encrypted JSON

### F. CLI Interface (`src/cli.ts`)
**Responsibility:** Standalone command-line interface.

```bash
apitap capture <url>          # Open browser, record API calls
apitap capture --port 18800   # Attach to existing CDP session
apitap list                   # Show captured skills
apitap show <domain>          # Show endpoints for domain
apitap replay <domain> <endpoint> [params]  # Call API directly
apitap export <domain>        # Export skill file
apitap import <file>          # Import skill file
apitap filter add <pattern>   # Add to blocklist
apitap filter list             # Show filter rules
```

### G. OpenClaw Plugin (`src/plugin.ts`)
**Responsibility:** Integrate with OpenClaw as a plugin.

- Auto-detect OpenClaw's CDP port
- Register tools: `apitap_capture`, `apitap_replay`, `apitap_list`
- Agent can say "capture the APIs on this page" or "call polymarket API for markets"
- Store skills in `~/.openclaw/skills/apitap/` or configurable path

---

## 4. Skill Schema

```json
{
  "version": "1.0",
  "domain": "polymarket.com",
  "capturedAt": "2026-02-04T22:00:00Z",
  "baseUrl": "https://polymarket.com",
  "auth": {
    "type": "bearer",
    "headerName": "Authorization",
    "tokenSource": "captured",
    "expiresAt": null,
    "refreshEndpoint": null
  },
  "endpoints": [
    {
      "id": "get-markets",
      "name": "Get Markets",
      "method": "GET",
      "path": "/api/markets",
      "queryParams": {
        "limit": { "type": "number", "default": 20, "required": false },
        "offset": { "type": "number", "default": 0, "required": false },
        "active": { "type": "boolean", "default": true, "required": false }
      },
      "headers": {
        "Accept": "application/json"
      },
      "responseShape": {
        "type": "array",
        "itemFields": ["id", "question", "slug", "active", "closed", "volume"]
      },
      "pagination": {
        "type": "offset",
        "limitParam": "limit",
        "offsetParam": "offset"
      },
      "examples": {
        "request": "GET /api/markets?limit=10&active=true",
        "responsePreview": "[{\"id\":\"123\",\"question\":\"Will X happen?\",\"volume\":\"$1.2M\"}]"
      },
      "lastCalled": "2026-02-04T22:00:00Z",
      "successRate": 1.0,
      "avgResponseMs": 180
    },
    {
      "id": "get-market-by-slug",
      "name": "Get Market by Slug",
      "method": "GET",
      "path": "/api/markets/:slug",
      "pathParams": {
        "slug": { "type": "string", "required": true }
      },
      "headers": {
        "Accept": "application/json"
      },
      "responseShape": {
        "type": "object",
        "fields": ["id", "question", "description", "outcomes", "volume", "endDate"]
      },
      "examples": {
        "request": "GET /api/markets/will-trump-win-2028",
        "responsePreview": "{\"id\":\"456\",\"question\":\"Will Trump win 2028?\",\"outcomes\":[...]}"
      },
      "lastCalled": "2026-02-04T22:01:00Z",
      "successRate": 1.0,
      "avgResponseMs": 150
    }
  ],
  "cookies": [
    {
      "name": "session_id",
      "domain": ".polymarket.com",
      "required": true,
      "expiresAt": "2026-02-11T22:00:00Z"
    }
  ],
  "metadata": {
    "captureCount": 47,
    "filteredCount": 12,
    "noiseDropped": 35,
    "toolVersion": "0.1.0"
  }
}
```

---

## 5. Auth Handling Strategy

### Detection (during capture)
1. Scan all request headers for auth patterns:
   - `Authorization: Bearer <token>` → Bearer auth
   - `Cookie: session=<value>` → Cookie auth  
   - `X-API-Key: <value>` → API key
   - `?api_key=<value>` in URL → Query param auth
2. Track which endpoints require auth (got 401 without, 200 with)
3. Detect CSRF tokens (`X-CSRF-Token`, hidden form fields)

### Storage
- Auth tokens stored in skill file, **encrypted with OS keyring** where available
- Fallback: encrypted JSON with user-provided passphrase
- Never plaintext on disk
- Skill files WITHOUT auth can be freely shared

### Refresh
- Monitor for 401/403 during replay
- On auth failure: 
  1. Try stored refresh endpoint if detected
  2. If no refresh flow: prompt user to re-capture (brief browser session)
  3. Cache new tokens

### Levels
```
Level 0: No auth (public APIs) — just replay
Level 1: Cookie/session — captured and stored, may expire
Level 2: Bearer token — captured, may need refresh
Level 3: OAuth flow — complex, defer to v0.2+
```

---

## 6. Smart Filtering

### Blocklist (built-in, ~50 domains)
```
# Analytics
google-analytics.com, googletagmanager.com, analytics.*, 
segment.io, segment.com, mixpanel.com, amplitude.com,
hotjar.com, fullstory.com, heap.io, posthog.com

# Ads
doubleclick.net, googlesyndication.com, facebook.net,
adsrvr.org, adnxs.com, criteo.com

# Tracking  
sentry.io, bugsnag.com, datadoghq.com, newrelic.com,
logrocket.com

# CDN (static assets, not APIs)
cdn.*, cloudfront.net (when serving static), 
unpkg.com, cdnjs.cloudflare.com, fonts.googleapis.com
```

### Allowlist (auto-detected)
- Same-origin requests (domain matches page domain)
- URLs containing `/api/`, `/v1/`, `/v2/`, `/graphql`, `/rest/`
- Responses with `Content-Type: application/json`

### Scoring System
Each request gets a "signal score" 0-100:
- Same-origin: +30
- JSON response: +25  
- `/api/` in path: +20
- Response has structured data (array/object with >3 fields): +15
- Known analytics domain: -100
- Tiny response (<50 bytes): -20
- URL contains `track|log|beacon|pixel`: -50

**Threshold:** Score ≥ 40 = captured. Below = dropped.

---

## 7. MVP Scope

### v0.1 — Proof of Concept ✅
- [ ] CDP connection + network event capture
- [ ] Basic filtering (content-type + blocklist)
- [ ] Skill file generation (JSON schema above)
- [ ] Basic replay via fetch
- [ ] CLI: `capture`, `list`, `show`, `replay`
- [ ] Works with OpenClaw's headless Chromium

**Complexity:** Medium. ~1-2 weekends.
**Deliverable:** Can capture Polymarket APIs, replay them without browser.

### v0.2 — Usable
- [ ] Auth detection + encrypted storage
- [ ] Smart filtering (scoring system)
- [ ] URL parameterization (`/users/123` → `/users/:id`)
- [ ] OpenClaw plugin wrapper
- [ ] Pagination detection

**Complexity:** Medium-High. ~2-3 weekends.

### v0.3 — Polish
- [ ] GraphQL support (introspection + query capture)
- [ ] Auth refresh flows
- [ ] Skill sharing (export/import without auth)
- [ ] Anti-detection (rate limiting, header rotation)
- [ ] Request diff (detect when APIs change)

### v1.0 — Release
- [ ] Full OpenClaw plugin with agent-friendly tool descriptions
- [ ] Multiple domain support
- [ ] Skill versioning
- [ ] Documentation + README
- [ ] npm package published

---

## 8. Project Structure

```
apitap/
├── package.json
├── tsconfig.json
├── README.md
├── ARCHITECTURE.md          # This file
├── BRIEF.md                 # Original brief
├── src/
│   ├── index.ts             # Main exports
│   ├── cli.ts               # CLI entry point
│   ├── plugin.ts            # OpenClaw plugin entry
│   ├── capture/
│   │   ├── monitor.ts       # CDP connection + event capture
│   │   ├── filter.ts        # Signal/noise filtering
│   │   └── blocklist.ts     # Built-in domain blocklist
│   ├── skill/
│   │   ├── generator.ts     # Raw traffic → skill file
│   │   ├── schema.ts        # Skill JSON schema + validation
│   │   └── store.ts         # Read/write skill files
│   ├── replay/
│   │   ├── engine.ts        # Execute API calls from skills
│   │   └── params.ts        # Parameter substitution
│   ├── auth/
│   │   ├── detector.ts      # Detect auth patterns
│   │   ├── manager.ts       # Store + refresh tokens
│   │   └── crypto.ts        # Encrypt/decrypt stored auth
│   └── utils/
│       ├── cdp.ts           # CDP connection helpers
│       ├── url.ts           # URL parsing + parameterization
│       └── logger.ts        # Structured logging
├── skills/                  # Generated skill files live here
│   └── polymarket.com.json
├── test/
│   ├── filter.test.ts
│   ├── generator.test.ts
│   └── replay.test.ts
└── scripts/
    └── build.sh
```

---

## 9. Implementation Plan

| Order | Component | Complexity | Est. Time | Dependencies |
|-------|-----------|-----------|-----------|-------------|
| 1 | CDP Monitor (`capture/monitor.ts`) | Low | 2-3 hrs | None |
| 2 | Basic Filter (`capture/filter.ts`) | Low | 1-2 hrs | #1 |
| 3 | Skill Schema (`skill/schema.ts`) | Low | 1 hr | None |
| 4 | Skill Generator (`skill/generator.ts`) | Medium | 3-4 hrs | #1, #2, #3 |
| 5 | Skill Store (`skill/store.ts`) | Low | 1 hr | #3 |
| 6 | Replay Engine (`replay/engine.ts`) | Medium | 2-3 hrs | #3, #5 |
| 7 | CLI (`cli.ts`) | Medium | 2-3 hrs | #1-6 |
| 8 | **MVP COMPLETE** | — | ~15 hrs | — |
| 9 | Auth Detector (`auth/detector.ts`) | Medium | 2-3 hrs | #1 |
| 10 | Auth Manager (`auth/manager.ts`) | High | 4-5 hrs | #9 |
| 11 | URL Parameterization (`utils/url.ts`) | Medium | 2-3 hrs | None |
| 12 | Smart Filtering/Scoring | Medium | 2-3 hrs | #2 |
| 13 | OpenClaw Plugin (`plugin.ts`) | Medium | 3-4 hrs | #1-7 |
| 14 | Tests | Medium | 3-4 hrs | All |

**Total MVP: ~15 hours (2 focused weekends)**
**Total v0.2: ~30 hours**

---

## 10. Key Design Decisions

1. **CDP over Proxy** — No MITM cert setup, leverages OpenClaw's existing browser
2. **Skill files are tool-agnostic** — Just JSON, any HTTP client can use them
3. **Filter aggressively** — Better to miss a noisy endpoint than pollute the skill file
4. **Auth encrypted at rest** — Skills without auth are shareable, auth is separate concern
5. **TypeScript** — Type safety for schema validation, compiles to JS, npm-friendly
6. **No external dependencies for core** — Only stdlib `fetch()` for replay. CDP client is the main dep.
7. **CLI-first, plugin-second** — Get it working standalone, then wrap for OpenClaw

---

*"Every website already has an API. Your agent just didn't know about it."*

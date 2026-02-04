# ApiTap — Open Source API Interception for AI Agents

**Status:** Backlog 🔖 → Brainstorming
**Created:** 2026-02-04

---

## The Problem

AI agents using browser automation burn 50-200K tokens per web interaction (DOM snapshots, element finding, clicking, re-rendering). Meanwhile, every SPA already fetches clean JSON from internal APIs. The browser is just a rendering layer.

We're doing: **JSON → HTML → scrape HTML → data.** That's insane.

## The Solution

**First visit:** browse normally, ApiTap records API calls (one-time cost).
**Every visit after:** agent calls the API directly. No browser. 200ms. 1-5K tokens instead of 50-200K.

## Inspiration & Why We're Building Our Own

Inspired by `lekt9/unbrowse-openclaw` — clever concept, but:
- 28MB closed-source native binaries (can't audit)
- Requires Solana wallet + private key in config
- Phones home to `index.unbrowse.ai` marketplace
- UNLICENSED despite claiming MIT
- 2 days old, unknown author

**Our version is:** fully open source, pure JS/TS, privacy-first, no marketplace, no crypto, local-only, auditable.

---

## Technical Approach

### Core Insight
Every SPA fetches JSON from internal APIs. Intercept the JSON directly via Chrome DevTools Protocol (CDP).

### Data Flow

```
CAPTURE MODE:
Browser (OpenClaw) → CDP Monitor → Filter Engine → Skill Generator → skills/*.json

REPLAY MODE:
Agent → Replay Engine (reads skill file) → Target API → clean JSON back
```

### Core Components

1. **CDP Monitor** — Attach to Chrome/Chromium via CDP, listen for network events (requestWillBeSent, responseReceived, getResponseBody)
2. **Filter Engine** — Separate signal (real APIs) from noise (analytics, tracking, static assets) using content-type, blocklist, URL patterns, and scoring heuristics
3. **Skill Generator** — Group by domain, detect endpoint patterns, parameterize URLs, capture auth patterns, output portable JSON
4. **Replay Engine** — Read skill file, substitute parameters, apply stored auth, execute via native fetch()
5. **Auth Manager** — Detect auth type (Bearer, Cookie, API Key), encrypted storage, handle refresh flows
6. **CLI** — `apitap capture`, `apitap list`, `apitap show`, `apitap replay`
7. **OpenClaw Plugin** — Auto-detect CDP port, register tools, agent-friendly

### Skill File Format (JSON)
Portable skill files per domain containing:
- Endpoints with method, path, params, headers, response shape
- Auth patterns (type, header, token source, expiry)
- Pagination detection
- Request examples and response previews
- Metadata (capture count, noise filtered, tool version)

### Smart Filtering
Scoring system (0-100): same-origin +30, JSON response +25, /api/ in path +20, structured data +15. Known analytics = -100. Threshold ≥ 40 captured.

Built-in blocklist: ~50 analytics/ads/tracking domains (GA, GTM, Segment, Hotjar, Sentry, etc.)

### Auth Strategy
- **Level 0:** No auth (public APIs) — just replay
- **Level 1:** Cookie/session — captured, may expire
- **Level 2:** Bearer token — captured, may need refresh
- **Level 3:** OAuth flow — complex, defer to v0.2+
- Storage: encrypted with OS keyring (fallback: encrypted JSON with passphrase)

---

## Project Structure

```
apitap/
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
├── skills/                  # Generated skill files
├── test/
└── scripts/
```

---

## MVP Roadmap

### v0.1 — Proof of Concept (~15 hrs / 2 weekends)
- CDP connection + network event capture
- Basic filtering (content-type + blocklist)
- Skill file generation
- Basic replay via fetch
- CLI: `capture`, `list`, `show`, `replay`
- Works with OpenClaw's headless Chromium

### v0.2 — Usable (~30 hrs cumulative)
- Auth detection + encrypted storage
- Smart filtering (scoring system)
- URL parameterization (`/users/123` → `/users/:id`)
- OpenClaw plugin wrapper
- Pagination detection

### v0.3 — Polish
- GraphQL support
- Auth refresh flows
- Skill sharing (export/import without auth)
- Anti-detection (rate limiting, header rotation)

---

## Key Design Decisions

1. **CDP over Proxy** — No MITM cert setup, leverages OpenClaw's existing browser
2. **Skill files are tool-agnostic** — Just JSON, any HTTP client can use them
3. **Filter aggressively** — Better to miss an endpoint than pollute the skill file
4. **Auth encrypted at rest** — Skills without auth are shareable
5. **TypeScript** — Type safety, npm-friendly, compiles to JS
6. **No external dependencies for core** — Only stdlib fetch() for replay
7. **CLI-first, plugin-second** — Get it working standalone, then wrap for OpenClaw

## Technical Constraints

- Pure JS/TypeScript — no native binaries, no compiled blobs
- Privacy-first — no external services, no phone-home, everything local
- Works with OpenClaw's existing browser control (CDP on port 18792/18800)
- Linux-first (Fedora), but portable
- Must handle auth (Bearer tokens, cookies, API keys)

## Open Questions for Brainstorming

1. Best way to hook CDP in OpenClaw's existing browser stack?
2. Handle auth rotation (tokens expire)?
3. How to deal with CSRF/anti-bot protections?
4. GraphQL introspection — worth building early?
5. Should skill files be versionable/diffable?
6. Plugin architecture: how to detect OpenClaw presence and adapt?
7. How to handle WebSocket APIs (not just REST)?

---

## Success Criteria

Agent browses Polymarket once → captures API → calls it directly next time.
Token usage drops from ~100K to ~2K for the same task.
No external dependencies. Pure local. Clean enough to open-source day one.

---

*"Every website already has an API. Your agent just didn't know about it."*

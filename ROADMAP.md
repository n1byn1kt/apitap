# ApiTap Roadmap

**Every website already has an API. Your agent just didn't know about it.**

---

## v1.0 — API-Layer Browsing (Current)

**721 tests | 16 CLI commands | 12 MCP tools | 7 content decoders**

What shipped:

- **Capture + Replay pipeline** — Capture API traffic via Playwright, generate skill files, replay with zero-dep `fetch()`
- **Framework discovery** — Detect WordPress, Next.js, Shopify, and more without a browser
- **Text-mode browsing** — `peek` and `read` commands with 7 built-in decoders (Reddit, YouTube, Wikipedia, HN, Grokipedia, Twitter/X, generic HTML)
- **Auth management** — Auto-detect credentials during capture, AES-256-GCM encrypted storage, browser-based refresh
- **Security hardening** — PII scrubbing, SSRF protection, skill file signing, read-only capture
- **MCP server** — 12 tools including interactive capture sessions and batch replay
- **Replayability tiers** — Green/yellow/orange/red classification with auto-verification

---

## v1.1 — Community & Sharing

- **Skill export** — Strip auth, export shareable skill files
- **Community repository** — Curated API maps for popular sites
- **Browser profile mode** — Capture using existing Chrome profile (logged-in sessions)
- **Batch replay workflows** — Multi-endpoint sequences for complex data gathering

---

## v1.2 — Intelligence Layer

- **Auto-discovery** — Crawl a site and discover all API endpoints automatically
- **Schema inference** — Generate TypeScript types from captured responses
- **API change detection** — Diff captures to find breaking changes and new endpoints
- **Rate limit learning** — Auto-detect and respect rate limits
- **Response caching** — Smart caching for development and testing

---

## Design Principles

1. **Pure JS/TS** — No native binaries, runs everywhere Node runs
2. **Privacy-first** — Local-only, no phone-home, encrypted auth
3. **CLI is the API** — `--json` on every command, MCP tools are thin wrappers
4. **Filter aggressively** — Better to miss an endpoint than pollute skill files
5. **Test everything** — TDD, never ship without tests
6. **Minimal deps** — Three runtime dependencies: Playwright, MCP SDK, Zod

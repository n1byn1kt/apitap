# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ApiTap intercepts web API traffic during normal browsing and generates portable JSON "skill files" so AI agents can call APIs directly instead of using browser automation. This eliminates the 50-200K token cost of DOM-based scraping, replacing it with direct API calls at ~1-5K tokens.

**Status:** v0.2 — Privacy & Security Hardening. Architecture in PROJECT.md, design decisions in `docs/plans/2026-02-04-architecture-design.md`.

## Architecture

Two modes:

- **Capture:** Browser → Playwright listener → Filter Engine → Skill Generator → `~/.apitap/skills/<domain>.json`
- **Replay:** Agent → Replay Engine (reads skill file) → Target API → JSON response

### Dependency Split

| Layer | Dependency | Rationale |
|-------|-----------|-----------|
| Capture | Playwright | `page.on('response')`, HAR recording, CDP lifecycle |
| Filter + Generator | None (pure logic) | Data transformation only |
| Replay | Node stdlib `fetch()` | Zero deps, portable |

### Core Components

- `capture/monitor.ts` — Playwright-based network listener. Attach-first (scan CDP ports 18792, 18800, 9222), launch-fallback if no browser found.
- `capture/filter.ts` — Scoring-based signal/noise separation (threshold >= 40). ~50 domain blocklist for analytics/tracking.
- `skill/generator.ts` — Groups traffic by domain, parameterizes URLs (`/users/123` → `/users/:id`), outputs skill JSON with replayability tiers.
- `replay/engine.ts` — Reads skill files, substitutes params, executes via `fetch()`.
- `auth/manager.ts` — Detects auth type (Bearer/Cookie/API Key), encrypted storage.
- `cli.ts` — Commands: `capture`, `list`, `show`, `replay`, `import`. All commands support `--json` for machine-readable output. The CLI is the API — agents use the same commands humans do.
- `plugin.ts` — OpenClaw integration. Three stateless tools (`apitap_search`, `apitap_replay`, `apitap_capture`) wrapping CLI commands.

### Security (v0.2)

- `capture/scrubber.ts` — PII detection and redaction (emails, phones, IPs, cards, SSNs).
- `capture/domain.ts` — Dot-prefix domain matching for capture filtering.
- `auth/crypto.ts` — AES-256-GCM encryption, PBKDF2 key derivation, HMAC-SHA256 signing.
- `auth/manager.ts` — Encrypted credential storage at `~/.apitap/auth.enc`.
- `skill/signing.ts` — HMAC-SHA256 skill file signing with three-state provenance (self/imported/unsigned).
- `skill/ssrf.ts` — URL validation against private IPs, internal hostnames, non-HTTP schemes.
- `skill/importer.ts` — Import validation pipeline: signature check → SSRF scan → confirmation.

### Replayability Tiers

Every endpoint is classified during capture:
- **Green** — Public, permissive CORS, no signing. Replay trivially.
- **Yellow** — Needs auth but no signing/anti-bot. Works with valid credentials.
- **Orange** — CSRF tokens, session binding, strict CORS. Fragile replay.
- **Red** — Request signing, anti-bot (Cloudflare/Akamai). Needs browser.

GET endpoints are auto-verified during capture (Playwright response vs raw `fetch()` comparison). Non-GET endpoints use heuristic classification only.

## Technical Constraints

- Pure TypeScript — no native binaries
- Playwright for capture, stdlib `fetch()` for replay (no deps in core replay)
- Privacy-first: local-only, no external services, no phone-home
- Linux-first (Fedora), portable
- Filter aggressively: better to miss an endpoint than pollute skill files
- Auth encrypted at rest; skill files without auth are shareable

## Build & Development

**Install:** `npm install`

**Run tests:** `npm test` (Node built-in test runner + tsx)

**Run single test:** `node --import tsx --test test/path/to/test.ts`

**Type check:** `npm run typecheck`

**Build:** `npm run build` (compiles to `dist/`)

**Dev CLI:** `npx tsx src/cli.ts <command>`

**Usage:**
- `npx tsx src/cli.ts capture <url>` — capture API traffic (domain-only by default)
- `npx tsx src/cli.ts capture <url> --all-domains` — capture all domains
- `npx tsx src/cli.ts capture <url> --preview` — include response data previews
- `npx tsx src/cli.ts capture <url> --no-scrub` — disable PII scrubbing
- `npx tsx src/cli.ts list` — list skill files (shows provenance)
- `npx tsx src/cli.ts show <domain>` — show endpoints (shows auth badges)
- `npx tsx src/cli.ts replay <domain> <endpoint-id>` — replay with stored auth
- `npx tsx src/cli.ts import <file>` — import skill file with safety validation

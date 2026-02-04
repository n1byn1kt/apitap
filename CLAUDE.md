# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ApiTap intercepts web API traffic during normal browsing and generates portable JSON "skill files" so AI agents can call APIs directly instead of using browser automation. This eliminates the 50-200K token cost of DOM-based scraping, replacing it with direct API calls at ~1-5K tokens.

**Status:** Pre-implementation. Architecture in PROJECT.md, design decisions in `docs/plans/2026-02-04-architecture-design.md`.

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
- `cli.ts` — Commands: `capture`, `list`, `show`, `replay`. All commands support `--json` for machine-readable output. The CLI is the API — agents use the same commands humans do.
- `plugin.ts` — OpenClaw integration. Three stateless tools (`apitap_search`, `apitap_replay`, `apitap_capture`) wrapping CLI commands.

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

No build system configured yet. Planned stack:
- TypeScript on Node.js 18+
- CLI entry point: `src/cli.ts`
- Plugin entry point: `src/plugin.ts` (OpenClaw integration)
- Tests: `test/` directory (framework TBD)

When setting up the project, establish: `package.json`, `tsconfig.json`, and npm scripts for `build`, `dev`, `test`, and `lint`.

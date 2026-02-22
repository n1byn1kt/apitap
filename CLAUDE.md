# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Using ApiTap as an MCP Tool

When asked to fetch data from a website, **always check for existing skill files first**:

1. `apitap show <domain>` — check if a skill file already exists
2. If it exists → use `apitap replay <domain> <endpoint-id>` (no browser needed)
3. If no skill file → try `apitap read <url>` first (text extraction, no browser)
4. Only use `apitap capture` or `apitap browse` as a last resort (requires browser)

**The replay path is the fast path.** It calls APIs directly with `fetch()` — no browser, no Playwright, no Chrome. Don't open a browser if a skill file already exists.

## Commands

```bash
npm test                                          # Run all tests (~721, Node built-in runner + tsx)
node --import tsx --test test/path/to/test.ts     # Run a single test file
npm run typecheck                                 # Type check (tsc --noEmit)
npm run build                                     # Compile to dist/
npx tsx src/cli.ts <command> [args]               # Run CLI from source
```

## Architecture

ApiTap intercepts web API traffic via browser, generates portable "skill files," and replays APIs without a browser. Two distinct runtime paths:

**Capture path** (requires Playwright):
```
Browser → CDP listener (monitor.ts) → filter.ts → SkillGenerator → skill.json on disk
```

**Replay path** (zero dependencies, stdlib fetch):
```
Skill file → replay/engine.ts → fetch() → JSON response
```

### Module Map

- **`src/capture/`** — Browser-side interception. `monitor.ts` is the Playwright CDP listener. `session.ts` wraps monitor into a stateful interactive session (used by MCP `capture_start`/`capture_interact`/`capture_finish`). `filter.ts` scores requests to separate API calls from noise. `parameterize.ts` converts `/users/123` → `/users/:id`.
- **`src/skill/`** — Skill file lifecycle. `generator.ts` groups captured exchanges, deduplicates by `method + parameterizedPath`, extracts auth/pagination/body templates. `store.ts` reads/writes `~/.apitap/skills/<domain>.json`. `signing.ts` provides HMAC-SHA256 integrity. `ssrf.ts` validates URLs against private IP ranges.
- **`src/replay/`** — `engine.ts` substitutes params, injects auth from encrypted storage, validates URLs via SSRF checks, and calls `fetch()`. Auth comes from `AuthManager`, never from the skill file itself.
- **`src/discovery/`** — Browser-free API detection. `frameworks.ts` detects WordPress/Next.js/Shopify from HTML/headers. `openapi.ts` probes for specs. `probes.ts` checks common API paths. `index.ts` orchestrates all three in parallel.
- **`src/read/`** — Text-mode content extraction. Site-specific decoders (Reddit, YouTube, Wikipedia, HN, Twitter, Grokipedia, DeepWiki) in `decoders/`. Falls back to generic HTML extraction in `extract.ts`. `peek.ts` does HEAD-only triage.
- **`src/auth/`** — `manager.ts` stores/retrieves encrypted credentials (AES-256-GCM). `refresh.ts` handles browser-based token refresh. `handoff.ts` opens a visible browser for human login. `oauth-refresh.ts` handles OAuth refresh_token flows.
- **`src/orchestration/`** — `browse.ts` is the high-level "just get me the data" pipeline (cache → disk → discover → replay). `cache.ts` is an in-memory session cache for the MCP server.
- **`src/cli.ts`** — Hand-rolled arg parser, all CLI commands. No framework (no yargs/commander).
- **`src/mcp.ts`** — MCP server (12 tools) using `@modelcontextprotocol/sdk`. All responses from external APIs are wrapped with `untrusted: true` metadata.
- **`src/plugin.ts`** — Lightweight non-MCP plugin interface (search + replay + batch tools).
- **`src/serve.ts`** — Serves a single skill file as a dedicated MCP server where each endpoint becomes its own tool.

### Key Design Decisions

- **CLI is the API**: agents use the same commands humans do. `--json` on every command for machine output.
- **Skill files are the central artifact**: JSON at `~/.apitap/skills/<domain>.json` with version, endpoints, auth config, provenance, and HMAC signature.
- **Auth is never in skill files**: credentials live in separate encrypted storage. Skill files only contain `[stored]` placeholders.
- **SSRF defense is multi-layered**: validated at import, at replay, after DNS resolution, and after redirects. Private IPs, cloud metadata, localhost all blocked.
- **Generator deduplication**: keyed on `method + parameterizedPath`. For POST bodies, duplicate bodies stored in `exchangeBodies` map for cross-request diffing during `toSkillFile()`.
- **ESM-only**: `"type": "module"` with `.js` extensions in imports (even for .ts source files, required by NodeNext resolution).

## Testing Conventions

- Tests mirror `src/` structure under `test/` (e.g., `src/capture/filter.ts` → `test/capture/filter.test.ts`).
- Uses Node's built-in `node:test` with `describe`/`it`/`assert`. No Jest, no Mocha.
- E2E tests in `test/e2e/` spin up local HTTP servers for capture→replay round-trips.
- Security tests in `test/security/` cover SSRF, path traversal, header injection, DNS rebinding, redirect attacks.
- MCP tests in `test/mcp/` test the MCP server tools end-to-end.

## TypeScript

- Strict mode. Target ES2022, module NodeNext.
- All imports use `.js` extension (NodeNext requirement): `import { foo } from './bar.js'`.
- Core types in `src/types.ts`: `CapturedExchange`, `SkillFile`, `SkillEndpoint`, `StoredAuth`, `Replayability`, `DiscoveryResult`.

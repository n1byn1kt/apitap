# Copilot Instructions for ApiTap

## Build and test commands
- Install deps: `npm install`
- Full test suite: `npm test` (Node test runner via `node --import tsx --test 'test/**/*.test.ts'`)
- Single test file: `node --import tsx --test test/path/to/test.ts`
- Type check: `npm run typecheck`
- Build: `npm run build`
- Run CLI from source: `npx tsx src/cli.ts <command> [args]`

## High-level architecture
ApiTap has two primary execution paths that share skill-file artifacts:
- **Capture path (browser required):** Playwright/CDP capture in `src/capture/monitor.ts` and `src/capture/session.ts` collects traffic, `src/capture/filter.ts` removes noise, then `src/skill/generator.ts` deduplicates by `method + parameterizedPath` and writes skill files through `src/skill/store.ts` to `~/.apitap/skills/<domain>.json`.
- **Replay path (browser-free):** `src/replay/engine.ts` loads a skill file, substitutes params, injects credentials from `src/auth/manager.ts`, applies SSRF/header protections from `src/skill/ssrf.ts`, then executes requests with stdlib `fetch()`.

Supporting layers:
- `src/discovery/` runs framework detection, OpenAPI probing, and endpoint probes in parallel.
- `src/orchestration/browse.ts` is the high-level pipeline (cache -> disk -> discover -> replay).
- `src/read/` provides `peek`/`read` text-mode extraction with site-specific decoders and generic fallback.
- `src/mcp.ts` exposes MCP tools over the same core pipeline; external API responses are marked untrusted.

## Key repository conventions
- **ESM + NodeNext rules are strict:** use `.js` in TS imports (e.g. `import { x } from './y.js'`).
- **CLI-first surface area:** keep behavior exposed via `src/cli.ts` commands, and ensure machine-readable `--json` output remains consistent.
- **Skill files are central artifacts:** endpoint metadata belongs in skill JSON, but auth secrets must never be stored there; auth stays in encrypted storage.
- **Security checks are part of normal flow:** preserve SSRF validation, header filtering, DNS/redirect checks during import and replay paths.
- **Test layout mirrors source layout:** add/update tests under `test/` matching `src/` paths; use Node's built-in `node:test` style.
- **Dependency discipline:** replay path should prefer stdlib `fetch`; keep Playwright usage scoped to capture/auth browser flows.

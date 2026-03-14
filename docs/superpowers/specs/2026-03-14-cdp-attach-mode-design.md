# CDP Attach Mode — Design Spec

**Date:** 2026-03-14
**Status:** Approved
**PR scope:** First PR ships CLI `attach` command for live browser sessions only

## Problem

ApiTap's extension capture path has structural limitations for authenticated flows:
- Authenticated sessions live in the browser's native process, not extension storage
- The extension injects per-tab via `chrome.debugger`, missing cross-tab flows (OAuth, SSO)
- Service worker lifecycle and 1MB native message limits make long passive captures brittle
- Users don't want to babysit a popup during checkout flows or API exploration

## Solution

A CLI command that attaches to a running Chrome instance via Chrome DevTools Protocol (CDP), passively captures all network traffic across all tabs, and generates signed skill files on exit.

```
apitap attach [--port <number>] [--domain <glob,...>] [--json]
```

## Command Interface

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `9222` | Chrome remote debugging port |
| `--domain <glob,...>` | (all) | Comma-separated domain globs to include |
| `--json` | off | Machine-readable summary to stdout on completion |

- **Start:** command connects to Chrome and begins passive capture
- **Stop:** Ctrl+C (SIGINT) triggers skill file generation and exit
- Domain globs support `*` wildcards: `*.github.com` matches `api.github.com` and `github.com`
- `--domain` is additive focus on top of the existing blocklist, not a replacement

## Architecture

### New Files

- `src/capture/cdp-attach.ts` — CDP WebSocket client, browser-level Network listener, multi-target session management

### Modified Files

- `src/cli.ts` — add `handleAttach()` command parser and handler
- `src/capture/filter.ts` — block `chrome-extension://` URLs (self-capture prevention)

### Data Flow

```
Chrome (live, signed-in)
  ↓ CDP WebSocket (browser-level)
cdp-attach.ts
  ├─ Target.getTargets() → attach to all existing page targets
  ├─ Target.setAutoAttach() → catch future tabs
  ├─ Per-target: Network.enable → requestWillBeSent + responseReceived + loadingFinished
  ├─ Network.getResponseBody (in loadingFinished handler, synchronous)
  ├─ shouldCapture() filter (existing filter.ts + blocklist)
  ├─ Domain glob filter (if --domain specified)
  └─ SkillGenerator.addExchange() per domain
         ↓ SIGINT
  ├─ generator.toSkillFile() per domain
  ├─ signSkillFile() (existing signing.ts)
  └─ writeSkillFile() (existing store.ts)
```

### Reused Modules

The attach mode does NOT use Playwright. It connects via raw WebSocket to CDP. But it feeds captured exchanges through the same pipeline as the Playwright path:

- `src/capture/filter.ts` — `shouldCapture()` for 2xx JSON filtering + blocklist
- `src/capture/parameterize.ts` — `parameterizePath()` for semantic path params
- `src/skill/generator.ts` — `SkillGenerator` for dedup, auth extraction, schema snapshot
- `src/skill/signing.ts` — `signSkillFile()` for HMAC-SHA256 integrity
- `src/skill/store.ts` — `writeSkillFile()` for disk persistence

## CDP Implementation Details

### Browser-Level Attach

Connect to `http://localhost:{port}/json/version` to get the browser WebSocket URL. Attach at the browser level (not per-tab) to get a single multiplexed connection.

### Target Discovery — Two-Phase

Existing tabs and future tabs require separate handling:

```ts
// Phase 1: Attach to all existing page targets
const { targetInfos } = await browser.send('Target.getTargets');
for (const target of targetInfos) {
  if (target.type === 'page') {
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId: target.targetId, flatten: true
    });
    await enableNetworkForSession(sessionId);
  }
}

// Phase 2: Auto-attach to future targets (new tabs, popups, OAuth redirects)
await browser.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true   // critical: use session-based multiplexing, not nested WebSockets
});
```

`flatten: true` is required — it uses modern session-based CDP multiplexing. Without it, each tab needs its own WebSocket connection and the architecture becomes unmanageable.

### Network.getResponseBody Timing Constraint

`Network.getResponseBody` must be called in the `loadingFinished` handler without deferral. Chrome's network buffer evicts response bodies aggressively — on high-traffic tabs, bodies can be gone by the next event loop tick.

```ts
session.on('Network.loadingFinished', async ({ requestId }) => {
  try {
    const { body } = await session.send('Network.getResponseBody', { requestId });
    responseBodies.set(requestId, body);
  } catch {
    // Body evicted or no body (204, redirects) — not fatal, skip gracefully
  }
});
```

The "No resource with given identifier found" error is expected and must not crash the capture session. A missing body means the endpoint is captured (method, path, status, headers) but without response shape or schema — still useful for the skill file.

## Self-Capture Prevention

Browser-level CDP captures ALL network traffic, including extension service worker requests. If ApiTap's extension is loaded in the same browser, its own API calls would be captured — creating a feedback loop.

Fix in `shouldCapture()` in `src/capture/filter.ts`:

```ts
// Block extension-internal traffic (prevents self-capture when
// attaching to a browser with ApiTap extension loaded)
if (response.url.startsWith('chrome-extension://')) return false;
if (response.url.startsWith('moz-extension://')) return false;
```

Added before the `new URL()` parse so it's a fast prefix check.

## Domain Glob Filtering

When `--domain` is specified, each captured URL's hostname is tested against the glob list. A request passes if it matches ANY pattern.

Glob rules:
- `*` matches any sequence of characters within a domain segment
- `*.github.com` matches `api.github.com`, `raw.github.com`, `github.com`
- `nordstrom.com` is exact match (also matches `www.nordstrom.com` if glob is `*nordstrom.com`)
- Multiple patterns comma-separated: `--domain *.github.com,*.stripe.com`

Applied after the blocklist — a blocklisted domain is filtered even if it matches `--domain`.

## SIGINT / Error Handling

- SIGINT handler registered **before** CDP connect attempt
- **Chrome unreachable:** print `[attach] Cannot connect to Chrome on :9222 — is remote debugging enabled?`, exit 1, no partial writes
- **Zero requests captured:** print `[attach] Nothing captured`, exit 0, no empty skill files
- **CDP disconnect mid-session** (browser closed): treat as implicit stop, generate skill files from whatever was captured
- **Multiple SIGINT signals:** second signal forces immediate exit (no double-generate)
- **Generator pipeline is idempotent:** calling toSkillFile() on an empty generator returns a valid but empty structure — we check endpoint count > 0 before writing

## Output Format

### stderr (live progress)

```
[attach] Connected to Chrome 146 on :9222 (23 tabs)
[attach] Watching all domains (filter: *.github.com)
  [api] GET 200 api.github.com /repos/:owner/:repo
  [api] GET 200 api.github.com /repos/:owner/:repo/issues
  [api] POST 200 github.com /session
  [skip] analytics.google.com (blocklisted)
  [skip] chrome-extension://fign... (extension)
^C
[attach] Generating skill files...
  api.github.com — 3 endpoints → ~/.apitap/skills/api.github.com.json
  github.com — 1 endpoint → ~/.apitap/skills/github.com.json
```

### stdout with --json

```json
{
  "domains": [
    { "domain": "api.github.com", "endpoints": 3, "skillFile": "~/.apitap/skills/api.github.com.json" },
    { "domain": "github.com", "endpoints": 1, "skillFile": "~/.apitap/skills/github.com.json" }
  ],
  "totalRequests": 47,
  "filteredRequests": 43,
  "duration": 124
}
```

## Enabling Remote Debugging

The user must launch Chrome with `--remote-debugging-port=9222` (or enable it via `chrome://flags`). The `attach` command should print a helpful message if connection fails:

```
[attach] Cannot connect to Chrome on :9222

To enable remote debugging, relaunch Chrome with:
  google-chrome --remote-debugging-port=9222

Or on macOS:
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

## Scope Exclusions

These are explicitly deferred to follow-up PRs:

- **MCP tool** (`apitap_capture_cdp`) — ship CLI first, MCP wraps it later
- **Headless automation mode** (`--headless --url <url>`) — follow-up flag on same command
- **Tray/menubar UI** — not planned
- **Auto-detection of debugging port** — not planned
- **Replayability verification** (`verifyEndpoints()`) — attach mode writes skill files without replay verification to avoid making outbound requests the user didn't initiate. Verification can be run separately via `apitap verify <domain>`.

## Test Plan

- Unit tests for domain glob matching
- Unit tests for `chrome-extension://` filter addition
- Integration test: launch headless Chrome with `--remote-debugging-port`, run `apitap attach`, navigate via CDP from a second connection, verify skill file output
- SIGINT test: verify clean shutdown with no partial writes
- Zero-capture test: verify exit 0 with no skill files written
- Multi-domain test: capture traffic from 3 domains, verify 3 separate skill files

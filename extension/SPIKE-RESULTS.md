# Chrome Extension Spike Results

## Build Validation (automated)

### Code Reuse

The "98% code reuse" claim is **confirmed** at the build level:

- `SkillGenerator` (generator.ts) — bundled, no modifications needed
- `shouldCapture` (filter.ts) — bundled, no modifications needed
- `parameterizePath` (parameterize.ts) — bundled via generator, no modifications needed
- All transitive dependencies (body-variables, body-diff, graphql, pagination, scrubber, entropy, oauth-detector, blocklist, token-detector, schema) — bundled cleanly

**Only new code written:** ~250 lines across background.ts, popup.ts, types.ts, shim.ts

### Buffer Shim

The two `Buffer.from()` calls (entropy.ts line 57, oauth-detector.ts line 132) are handled by a 20-line global shim that replaces `Buffer.from(str, 'base64').toString('utf-8')` with `atob()`. Build succeeds with zero errors.

### Bundle Size

| File | Size |
|------|------|
| background.js | 45 KB |
| popup.js | 4 KB |
| **Total** | **49 KB** |

Background includes all shared capture/generator logic. Well within Chrome extension limits.

### Node.js Dependency Audit

| Concern | Result |
|---------|--------|
| `node:crypto` (auth/crypto.ts) | NOT in generator import tree — clean |
| `node:fs` (auth/crypto.ts) | NOT in generator import tree — clean |
| `node:os` (auth/crypto.ts) | NOT in generator import tree — clean |
| `process.*` | Not referenced in bundle |
| `__dirname` | Not referenced in bundle |
| `require("node:*")` | Not referenced in bundle |

### Architecture

- MV3 manifest with `debugger`, `activeTab`, `storage`, `downloads` permissions
- Service worker (`background.ts`) uses `chrome.debugger.attach()` → CDP `Network.enable`
- CDP events: `requestWillBeSent` → `responseReceived` → `loadingFinished` → `Network.getResponseBody`
- Same data flow as Playwright monitor: assemble `CapturedExchange` → `shouldCapture()` → `generator.addExchange()`
- Auth detection from outgoing `Authorization` and `x-api-key` headers
- Popup communicates via `chrome.runtime.sendMessage`

---

## Manual Testing Results

### Reddit Capture (Brave browser)

Tested against `https://www.reddit.com` (logged in). Browsed subreddits, scrolled, expanded comments.

**Results:**
- [x] Extension loads and popup shows "Ready"
- [x] Start/Stop capture works, debugger infobar appears
- [x] Download skill file works (after fix: moved download to background worker)
- [x] **7 endpoints** captured from 38 requests (353 filtered out)
- [x] GraphQL detected: `POST /svc/shreddit/graphql` with body variables
- [x] `csrf_token` correctly identified as refreshable token
- [x] Auth headers scrubbed to `[stored]` on Matrix endpoints
- [x] Multi-domain traffic captured (reddit.com, redditstatic.com, matrix.redditspace.com)
- [x] Response schemas generated correctly
- [x] POST request bodies captured with variable detection

### Bugs Found

1. **Download popup close** (fixed): Blob URLs created in popup died when popup closed on download. Fixed by moving download to background service worker using data URLs.

2. **Domain mismatch** (known limitation): `domain` field in skill file showed `github.com` instead of `reddit.com` — capture was started on a GitHub tab, then user navigated to Reddit. The domain is set from the tab URL at capture start and doesn't update on navigation. Multi-domain traffic (redditstatic, matrix.redditspace) also means a single-domain skill file doesn't fully represent the capture.

### Quality Assessment

| Feature | CLI Capture | Extension Capture |
|---------|-------------|-------------------|
| Filter quality | Same `shouldCapture()` | Same — confirmed identical |
| Body variable detection | 3 strategies | Same — csrf_token detected |
| Auth scrubbing | `[stored]` placeholders | Same — confirmed working |
| Path parameterization | Shared `parameterizePath` | Same — bundled identically |
| Multi-domain | Per-domain generators | Single generator (bug) |
| Schema inference | Full | Full — same code path |

---

## Decision

- [x] **Proceed** — spike validates the core approach

### What works
- 98% code reuse confirmed both at build and runtime
- CDP capture via `chrome.debugger` produces identical data quality to Playwright
- All shared modules (filter, generator, body-diff, graphql, scrubber) work in browser
- 49KB total bundle, no Node.js dependencies leaked
- Auth detection works — killer feature confirmed (user already logged in)

### Fixes needed before v1
- Domain should track from captured requests, not just tab URL at start
- Multi-domain support: per-domain generators (like CLI monitor) or merged output
- Popup state should survive popup close/reopen (use `chrome.storage.session`)

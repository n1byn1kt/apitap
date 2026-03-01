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

## Manual Testing (TODO)

### Test 1: Load in Chrome

- [ ] `chrome://extensions` → Developer mode → Load unpacked → select `extension/`
- [ ] Extension icon appears in toolbar
- [ ] Clicking icon opens popup with "Ready" state

### Test 2: jsonplaceholder.typicode.com

- [ ] Navigate to `https://jsonplaceholder.typicode.com/`
- [ ] Click ApiTap icon → "Start Capture"
- [ ] Debugger infobar appears
- [ ] Click links on the page (posts, comments, users)
- [ ] Popup stats update (endpoint count, request count)
- [ ] Click "Stop Capture"
- [ ] Endpoint list renders
- [ ] "Download Skill File" produces valid JSON
- [ ] Skill file has parameterized paths (e.g. `/posts/:id`)

### Test 3: Authenticated site (Reddit)

- [ ] Navigate to `https://www.reddit.com` (logged in)
- [ ] Start capture, browse subreddits, scroll, expand comments
- [ ] Stop capture, download
- [ ] Endpoints present?
- [ ] Paths parameterized?
- [ ] Auth detected? (should show Bearer token)
- [ ] POST bodies present?

### Test 4: Compare with CLI

```bash
cd /home/fkj/clawd/projects/apitap
npx tsx src/cli.ts capture https://jsonplaceholder.typicode.com/ --duration 15
```

- [ ] Compare endpoint count
- [ ] Compare path parameterization quality
- [ ] Note any differences

---

## Decision

_To be filled after manual testing:_

- [ ] **Proceed** — spike works, extension becomes #1 priority
- [ ] **Fix** — works with issues, document fixes needed
- [ ] **Shelve** — fundamental problems, document blockers

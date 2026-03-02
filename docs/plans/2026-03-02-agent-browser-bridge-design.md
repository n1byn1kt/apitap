# Agent-Browser Bridge Design

**Date:** 2026-03-02
**Status:** Approved — ready for implementation planning
**Priority:** High — closes the autonomous agent loop, eliminates auth wall for agents
**Depends on:** Native messaging bridge (docs/plans/2026-03-01-native-messaging-bridge.md)

## Summary

Let AI agents transparently access the user's authenticated browser sessions via the Chrome extension. When `apitap_browse` hits an auth wall, it escalates to the extension — which captures API traffic from the user's real, logged-in browser — and returns the data as if nothing special happened. The agent never knows about the extension. It asks for data, it gets data.

## Motivation

Today, agents hit a wall when sites require authentication:
1. `apitap_browse` tries cache → disk → discover → replay
2. Auth-walled sites (Discord, Spotify, Reddit) fail at every step
3. Agent gives up with "use `apitap auth request` for manual login"
4. Human has to manually log in, then the agent retries

The bridge eliminates step 3-4. The user is already logged into Discord in their browser. The extension captures the live API traffic, generates a skill file, and the agent replays it — all in one `apitap_browse` call.

## Architecture

```
Agent → MCP → browse.ts ──[unix socket]──> Native Host ──[stdio]──> Extension
Agent ← MCP ← browse.ts <──[unix socket]── Native Host <──[stdio]── Extension
```

Three components:

1. **Native host relay** — extends the existing `src/native-host.ts` to be a bidirectional message broker. Listens on a Unix domain socket (`~/.apitap/bridge.sock`) for CLI requests. Relays them to the extension via stdio (Chrome native messaging). Relays responses back.

2. **Extension agent handler** — new code in `extension/src/background.ts`. Receives `capture_request` messages from the native host. Checks per-site consent, finds/opens a tab, runs a capture with plateau detection, returns the skill file.

3. **Browse escalation** — new step in `src/orchestration/browse.ts`. After all existing paths fail, checks if `~/.apitap/bridge.sock` exists. If so, sends a capture request through the socket. Signs and saves the returned skill file, then replays immediately. Agent gets data in one round trip.

## Data Flow

```
Agent                CLI/MCP               Native Host           Extension
  │                    │                      │                     │
  │ apitap_browse()    │                      │                     │
  ├───────────────────>│                      │                     │
  │                    │ cache/disk/discover:  │                     │
  │                    │ all miss or auth wall │                     │
  │                    │                      │                     │
  │                    │ connect unix socket   │                     │
  │                    ├─────────────────────>│                     │
  │                    │ {action: capture_request, domain: discord.com}
  │                    │                      ├────────────────────>│
  │                    │                      │                     │
  │                    │                      │                     │ check consent
  │                    │                      │                     │ (stored → proceed)
  │                    │                      │                     │ (new → show dialog)
  │                    │                      │                     │
  │                    │                      │                     │ find tab for discord.com
  │                    │                      │                     │ attach CDP, capture
  │                    │                      │                     │ plateau detection
  │                    │                      │                     │ generate skill file
  │                    │                      │                     │
  │                    │                      │   {skillFiles: [...]}│
  │                    │                      │<────────────────────┤
  │                    │  {skillFiles: [...]} │                     │
  │                    │<─────────────────────┤                     │
  │                    │                      │                     │
  │                    │ sign + save to disk   │                     │
  │                    │ replay endpoint       │                     │
  │                    │                      │                     │
  │  {data: ...}       │                      │                     │
  │<───────────────────┤                      │                     │
```

## Bidirectional Native Messaging

Chrome native messaging is extension-initiated — the extension calls `chrome.runtime.connectNative()` to open a persistent port to the native host. The CLI can't push to the extension directly.

**Solution:** The native host becomes a message broker with two interfaces:

- **Stdio (extension side):** Persistent `chrome.runtime.connectNative('com.apitap.native')` port. Extension sends messages (save_skill, etc.), native host receives. Native host can also write messages that the extension reads.
- **Unix domain socket (CLI side):** `~/.apitap/bridge.sock`. CLI connects, sends a JSON request, waits for response. Native host relays to extension via stdio, relays response back over the socket.

```
CLI ──[unix socket: ~/.apitap/bridge.sock]──> Native Host ──[stdio]──> Extension
CLI <──[unix socket]── Native Host <──[stdio]── Extension
```

**Process lifetime:** The native host lives as long as Chrome has the extension connected. When Chrome closes, the native host dies, the socket file disappears, and `bridgeAvailable()` returns false — clean fallback.

**Stale socket safety:** On startup, the native host unlinks any existing `~/.apitap/bridge.sock` before binding. If the CLI finds a socket file but can't connect (stale from a crash), it gets an immediate connection error and falls through to the unavailable path.

## Per-Site Consent

Agent-initiated captures require explicit user approval, persisted per domain.

**Mental model:** Same as browser permissions ("Allow notifications from discord.com"). One approval per site, never asked again unless revoked.

**Flow:**
1. Extension receives `capture_request` for `discord.com`
2. Checks `chrome.storage.local` for approved domains
3. If approved → proceed to capture
4. If not approved → show consent UI in extension popup
   - "An ApiTap agent wants to capture API traffic from discord.com"
   - [Allow] [Deny]
5. User clicks Allow → domain added to approved list, capture proceeds
6. User clicks Deny → `{error: 'user_denied'}` returned to CLI

**Consent UI:** Primary path is a Chrome notification that, when clicked, opens the extension popup with the consent dialog. This avoids dependency on notification action buttons (deprecated in some Chrome versions). The popup is the reliable, controlled interaction surface.

**Revocation:** Extension settings page (future) shows approved domains. User can remove any domain at any time.

## Timeout & Fallback Chain

Four outcomes when the CLI escalates to the extension:

1. **User approved (consent stored or freshly granted)** → Capture runs with plateau detection. Skill files returned. CLI signs, saves, replays. Agent gets data. Total time: 10-30s.

2. **User is slow / AFK** → 60-second timeout. Native host returns `{error: 'approval_timeout'}`. Browse returns:
   ```json
   {"success": false, "suggestion": "User approval pending for discord.com. Click Allow in the ApiTap extension and try again."}
   ```

3. **User denies** → Extension returns `{error: 'user_denied'}`. CLI does NOT retry for that domain in this session. Browse returns:
   ```json
   {"success": false, "suggestion": "User denied browser access to discord.com. Use 'apitap auth request discord.com' for manual login instead."}
   ```

4. **Bridge unavailable** (no socket file, Chrome not running, extension not connected) → Escalation step skipped entirely. Zero cost. Browse falls through to existing guidance.

## Tab Strategy

When the extension receives a `capture_request`:

1. Search open tabs for one matching the requested domain (`chrome.tabs.query({url: '*://discord.com/*'})`)
2. If found → use that tab (live authenticated state, real API traffic)
3. If not found → open a new tab for the domain, navigate to it

Using an existing tab is the primary path — it has the authenticated session, cookies, and page state the agent needs. A new tab is the fallback.

## Capture: Plateau Detection

Agent-triggered captures use smart duration — stop when the site stops producing new endpoints:

- **Idle timeout:** 10 seconds with no new endpoints discovered → capture stops
- **Hard cap:** 2 minutes maximum
- **Implementation:** Timer resets on each new endpoint (reuses existing `state.endpointCount` tracking). When the timer fires, `stopCapture()` is called automatically.

This is self-tuning: busy pages (Discord with many API calls on load) capture for longer. Idle pages (simple REST API with one endpoint) finish in seconds.

## CLI-Side Integration

In `src/orchestration/browse.ts`, add one escalation step before the final fallback:

```typescript
// After all existing paths fail...

// Try extension bridge
if (bridgeAvailable()) {  // fast check: does ~/.apitap/bridge.sock exist?
  const result = await bridgeCapture(domain, { timeout: 60_000 });

  if (result.success && result.skillFiles?.length > 0) {
    for (const sf of result.skillFiles) {
      await signAndSave(sf);  // CLI signs — crypto stays in Node.js
    }
    return await replay(domain, endpointId, params);  // immediate replay
  }

  // Handle deny/timeout (see fallback chain above)
}

// Final fallback — existing guidance
```

**Zero overhead for users without the extension:** `bridgeAvailable()` is a filesystem stat on `~/.apitap/bridge.sock`. If the file doesn't exist (no extension, no native host), the check costs ~0.1ms and the escalation is skipped entirely.

**Skill file persistence:** After `signAndSave()`, the skill file is on disk regardless of whether the immediate replay succeeds. The capture investment is never lost — if replay fails (wrong endpoint, params mismatch), the skill file is there for the next call.

## Extension Protocol Messages

### CLI → Extension (via native host relay)

| Action | Fields | Response |
|--------|--------|----------|
| `capture_request` | `domain: string` | `{success, skillFiles: SkillFile[], error?}` |
| `ping` | — | `{success, version, bridgeConnected}` |

### Extension → CLI (existing, via native host)

| Action | Fields | Response |
|--------|--------|----------|
| `save_skill` | `domain, skillJson` | `{success, path}` |
| `save_batch` | `skills: [{domain, skillJson}]` | `{success, paths}` |
| `ping` | — | `{success, version, skillsDir}` |
| `poll` | — | `{pendingRequest?}` or `{none: true}` |

## Scope Boundaries

### In scope (v1):
- Bidirectional native messaging relay (Unix socket + stdio)
- `capture_request` action: extension captures, returns skill files
- Per-site consent with persistence in `chrome.storage.local`
- Plateau detection for capture duration
- `browse.ts` escalation to extension bridge
- Timeout/deny/unavailable fallback chain
- Tab finding for existing authenticated sessions

### Out of scope (future):
- Full browser control from agent (navigate, click, type)
- Passive real-time API observation (extension streams to agent)
- Multiple concurrent agent captures
- Cross-extension communication (other extensions as data sources)
- Windows support for native messaging (named pipes instead of Unix sockets)

## Dependencies

This design builds on:
1. **Native messaging bridge** (docs/plans/2026-03-01-native-messaging-bridge.md) — must be implemented first. The agent bridge extends the native host, not replaces it.
2. **Extension v1 hardening** (completed) — security model, multi-domain capture, auth scrubbing.

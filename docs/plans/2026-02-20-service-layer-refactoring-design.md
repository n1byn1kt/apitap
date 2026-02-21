# Service Layer Refactoring Design

**Date:** 2026-02-20
**Status:** Approved
**Approach:** Service Layer extraction + CLI/MCP split + large function decomposition

## Problem

The codebase (9,300 LOC, 53 source files) has three primary issues:

1. **Duplication across surfaces.** cli.ts (1031 LOC), mcp.ts (640 LOC), and plugin.ts (188 LOC) all implement the same operations (replay, capture, browse, search, etc.) with copy-pasted boilerplate: auth manager setup (10x), skill file validation (5x), stored auth injection (3x), MCP response formatting (24x).

2. **Monolithic entry points.** cli.ts and mcp.ts are the two largest files. Adding a new command requires modifying a 1000+ line file and duplicating patterns.

3. **Oversized functions.** `replayEndpoint()` (294 LOC), `addExchange()` (180 LOC), `htmlToMarkdown()` (122 LOC), `doBrowserRefresh()` (105 LOC), and `interact()` (90 LOC switch) each do too many things.

## Solution

### 1. Service Layer (`src/services/`)

Extract shared business logic into service functions that cli, mcp, and any future surface can call. Each service handles auth setup, skill loading, validation, and orchestration — the boilerplate that's currently duplicated.

| Service | Wraps | Eliminates |
|---------|-------|-----------|
| `services/auth-factory.ts` | `getMachineId()` + `new AuthManager()` | 10x auth setup duplication |
| `services/skill-loader.ts` | `readSkillFile()` + validation + endpoint lookup | 5x skill validation duplication |
| `services/replay.ts` | Auth injection + stored placeholder check + replay call | 3x replay boilerplate |
| `services/capture.ts` | Capture orchestration + verification + signing + auth storage | Shared between cli/mcp |
| `services/discover.ts` | Discovery + optional skill save | Shared between cli/mcp |
| `services/url.ts` | `normalizeUrl()`, common URL validation | 3x URL normalization |

The existing `orchestration/browse.ts` already follows this pattern and stays in place.

**Example — `services/replay.ts`:**
```typescript
export async function replayWithAuth(domain: string, endpointId: string, opts: {
  params?: Record<string, string>;
  fresh?: boolean;
  maxBytes?: number;
  skillsDir?: string;
}): Promise<ReplayResult> {
  const skill = await loadSkillOrThrow(domain, opts.skillsDir);
  const endpoint = findEndpointOrThrow(skill, endpointId);
  const authManager = await createAuthManager();
  const storedAuth = await authManager.get(domain);
  injectStoredAuth(endpoint, storedAuth);
  return replayEndpoint(skill, endpoint, { ...opts, authManager, domain });
}
```

### 2. CLI Split (`src/cli/`)

Split the monolithic cli.ts into per-command modules:

```
src/cli/
  index.ts          # Entry point: parseArgs + dispatch (~80 LOC)
  parser.ts         # Improved arg parser with --flag=value and validation (~60 LOC)
  helpers.ts        # formatJson(), formatError(), tierBadge(), timeAgo() (~50 LOC)
  commands/
    capture.ts
    discover.ts
    inspect.ts
    search.ts
    list.ts
    show.ts
    replay.ts
    import.ts
    refresh.ts
    auth.ts
    serve.ts
    browse.ts
    peek.ts
    read.ts
    stats.ts
```

Each command module exports a single `async function handle(positional, flags, json)` that calls the service layer and formats output for the terminal. `src/cli.ts` stays as the bin entry point but just re-exports from `cli/index.ts`.

**Parser improvements** (no new dependency):
- Support `--flag=value` syntax
- Validate flag values (e.g., `--duration` without a number errors instead of silently becoming `true`)

### 3. MCP Split (`src/mcp/`)

Split mcp.ts into tool modules:

```
src/mcp/
  index.ts          # createMcpServer(), transport setup (~60 LOC)
  helpers.ts        # wrapExternalContent(), formatTextResponse(), formatErrorResponse() (~30 LOC)
  session-manager.ts  # SessionManager class (Map + cleanup + MAX_SESSIONS)
  tools/
    search.ts       # apitap_search
    discover.ts     # apitap_discover
    replay.ts       # apitap_replay + apitap_replay_batch
    browse.ts       # apitap_browse
    read.ts         # apitap_peek + apitap_read
    capture.ts      # apitap_capture + capture_start/interact/finish
    auth.ts         # apitap_auth_request
```

**SessionManager class** replaces the raw Map + duplicated cleanup logic:
```typescript
class SessionManager {
  add(session: CaptureSession): void;
  get(id: string): CaptureSession | null;  // auto-cleans expired
  isFull(): boolean;
}
```

**wrapExternalContent()** usage made consistent: all tools returning external data (replay, browse, read) use it. Local data tools (search, discover) don't.

### 4. Remove `plugin.ts`

plugin.ts (188 LOC) implements 3 tools (search, replay, batch) that are a strict subset of the MCP server. Remove it. If backward compatibility is needed, `src/plugin.ts` becomes a thin re-export wrapper around service layer functions.

### 5. Break Up Large Functions

#### 5a. `replayEndpoint()` in replay/engine.ts (294 LOC)

| Extracted function | Responsibility |
|---|---|
| `buildReplayRequest()` | URL construction, path/query param substitution, header filtering |
| `prepareBody()` | Body variable substitution, content-type handling |
| `checkTokenFreshness()` | JWT expiry check, proactive refresh decision |
| `executeWithRedirects()` | fetch + manual redirect following with SSRF re-check |
| `processResponse()` | Parse JSON/text, truncation, wrap auth errors |
| `replayEndpoint()` | Orchestrator calling the above |

#### 5b. `addExchange()` in skill/generator.ts (180 LOC)

| Extracted function | Responsibility |
|---|---|
| `classifyExchange()` | GraphQL detection, URL parsing, path parameterization |
| `extractAuth()` | Entropy-based auth header detection, OAuth detection |
| `buildEndpointFromExchange()` | Construct SkillEndpoint with headers, params, body, shape |
| `addExchange()` | Orchestrator: classify, extract, build, deduplicate |

#### 5c. `interact()` in capture/session.ts (90 LOC switch)

Extract each case into a private method: `doClick()`, `doType()`, `doSelect()`, `doNavigate()`, `doScroll()`, `doWait()`, `doSnapshot()`. Switch becomes a dispatch table.

#### 5d. `htmlToMarkdown()` in read/extract.ts (122 LOC)

Break into a pipeline of pure transformers: `stripScriptStyle()` -> `convertHeadings()` -> `convertLists()` -> `convertLinks()` -> `convertBlockquotes()` -> `convertCodeBlocks()` -> `cleanWhitespace()`.

#### 5e. `doBrowserRefresh()` in auth/refresh.ts (105 LOC)

Extract `restoreSession()` (session cache -> browser context) and `captureTokensFromTraffic()` (request interception -> token extraction). Keep `doBrowserRefresh()` as orchestrator.

### 6. Shared Constants

Move to `src/constants.ts`:
- `APITAP_DIR` (currently defined in 4 files)
- `TIER_BADGES` map

### 7. Cleanup

- Remove unused `detectAntiBot` import in cli.ts
- Remove `plugin.ts` (replaced by service layer)

## Test Impact

- **Existing tests don't change.** Public API from `src/index.ts` maintains the same exports, just pointing to new internal locations.
- **CLI process tests** (`test/cli/`) continue to work since `src/cli.ts` stays as the bin entry point.
- **New service layer functions** should get unit tests, but existing 721 tests provide regression coverage.

## Migration Order

Each step is independently verifiable (run full test suite after each):

1. Create service layer + shared constants (additive, nothing breaks)
2. Split cli.ts into cli/ (move handlers, keep entry point)
3. Split mcp.ts into mcp/ (move tool definitions)
4. Break up large functions (within their existing files)
5. Remove plugin.ts, update index.ts exports
6. Clean up dead imports and code

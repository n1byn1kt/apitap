# Service Layer Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract a shared service layer, split cli.ts and mcp.ts into per-command modules, break up oversized functions, and remove plugin.ts.

**Architecture:** Shared `src/services/` layer handles business logic (auth setup, skill loading, replay orchestration). CLI and MCP become thin I/O adapters. Large functions are decomposed into focused helpers.

**Tech Stack:** TypeScript (ESM, NodeNext), Node built-in test runner, no new dependencies.

**Important conventions:**
- All imports use `.js` extension (NodeNext requirement)
- `APITAP_DIR` uses `process.env.APITAP_DIR || join(homedir(), '.apitap')`
- `SKILLS_DIR` uses `process.env.APITAP_SKILLS_DIR || undefined`
- Tests use `node:test` with `describe`/`it`/`assert`

---

## Phase 1: Service Layer + Constants (Additive)

### Task 1: Create shared constants

**Files:**
- Create: `src/constants.ts`
- Test: `test/constants.test.ts`

**Step 1: Write the test**

```typescript
// test/constants.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_BADGES, DEFAULT_APITAP_DIR, getApitapDir, getSkillsDir } from '../src/constants.js';

describe('constants', () => {
  it('exports TIER_BADGES with all tiers', () => {
    assert.ok(TIER_BADGES.green);
    assert.ok(TIER_BADGES.yellow);
    assert.ok(TIER_BADGES.orange);
    assert.ok(TIER_BADGES.red);
    assert.ok(TIER_BADGES.unknown);
  });

  it('getApitapDir returns default when no env var', () => {
    const dir = getApitapDir();
    assert.ok(dir.endsWith('.apitap'));
  });

  it('getSkillsDir returns undefined when no env var', () => {
    assert.equal(getSkillsDir(), undefined);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/constants.test.ts`
Expected: FAIL — cannot find module `../src/constants.js`

**Step 3: Write the implementation**

```typescript
// src/constants.ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_APITAP_DIR = join(homedir(), '.apitap');

export function getApitapDir(): string {
  return process.env.APITAP_DIR || DEFAULT_APITAP_DIR;
}

export function getSkillsDir(): string | undefined {
  return process.env.APITAP_SKILLS_DIR || undefined;
}

export const TIER_BADGES: Record<string, string> = {
  green: '[green]',
  yellow: '[yellow]',
  orange: '[orange]',
  red: '[red]',
  unknown: '[ ]',
};
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/constants.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/constants.ts test/constants.test.ts
git commit -m "refactor: extract shared constants to src/constants.ts"
```

---

### Task 2: Create URL helper

**Files:**
- Create: `src/services/url.ts`
- Test: `test/services/url.test.ts`

**Step 1: Write the test**

```typescript
// test/services/url.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/services/url.js';

describe('normalizeUrl', () => {
  it('passes through http URLs unchanged', () => {
    assert.equal(normalizeUrl('http://example.com'), 'http://example.com');
  });

  it('passes through https URLs unchanged', () => {
    assert.equal(normalizeUrl('https://example.com/path'), 'https://example.com/path');
  });

  it('prepends https:// to bare domains', () => {
    assert.equal(normalizeUrl('example.com'), 'https://example.com');
  });

  it('prepends https:// to domains with paths', () => {
    assert.equal(normalizeUrl('example.com/api/v1'), 'https://example.com/api/v1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/services/url.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

```typescript
// src/services/url.ts

/** Normalize a URL: prepend https:// if no scheme present. */
export function normalizeUrl(url: string): string {
  return url.startsWith('http') ? url : `https://${url}`;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/services/url.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/url.ts test/services/url.test.ts
git commit -m "refactor: extract normalizeUrl to services/url.ts"
```

---

### Task 3: Create auth factory service

**Files:**
- Create: `src/services/auth-factory.ts`
- Test: `test/services/auth-factory.test.ts`

**Step 1: Write the test**

```typescript
// test/services/auth-factory.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthManager } from '../src/services/auth-factory.js';

describe('createAuthManager', () => {
  it('returns an AuthManager instance', async () => {
    const mgr = await createAuthManager();
    assert.ok(mgr);
    assert.equal(typeof mgr.store, 'function');
    assert.equal(typeof mgr.retrieve, 'function');
  });

  it('returns an AuthManager with custom dir', async () => {
    const mgr = await createAuthManager('/tmp/test-apitap');
    assert.ok(mgr);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/services/auth-factory.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

```typescript
// src/services/auth-factory.ts
import { AuthManager, getMachineId } from '../auth/manager.js';
import { getApitapDir } from '../constants.js';

/** Create an AuthManager with the standard machine-id-based key. */
export async function createAuthManager(baseDir?: string): Promise<AuthManager> {
  const machineId = await getMachineId();
  return new AuthManager(baseDir ?? getApitapDir(), machineId);
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/services/auth-factory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/auth-factory.ts test/services/auth-factory.test.ts
git commit -m "refactor: extract createAuthManager to services/auth-factory.ts"
```

---

### Task 4: Create skill-loader service

**Files:**
- Create: `src/services/skill-loader.ts`
- Test: `test/services/skill-loader.test.ts`

**Step 1: Write the test**

```typescript
// test/services/skill-loader.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSkillOrThrow, findEndpointOrThrow } from '../src/services/skill-loader.js';
import type { SkillFile } from '../src/types.js';

describe('loadSkillOrThrow', () => {
  it('throws for nonexistent domain', async () => {
    await assert.rejects(
      () => loadSkillOrThrow('nonexistent.example.com', '/tmp/no-such-dir'),
      (err: Error) => err.message.includes('No skill file found')
    );
  });
});

describe('findEndpointOrThrow', () => {
  const skill: SkillFile = {
    version: '1.2',
    domain: 'example.com',
    capturedAt: new Date().toISOString(),
    baseUrl: 'https://example.com',
    endpoints: [{
      id: 'get-users',
      method: 'GET',
      path: '/users',
      queryParams: {},
      headers: {},
      responseShape: { type: 'array' },
      examples: { request: { url: 'https://example.com/users', headers: {} }, responsePreview: null },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self',
  };

  it('returns endpoint by id', () => {
    const ep = findEndpointOrThrow(skill, 'get-users');
    assert.equal(ep.id, 'get-users');
  });

  it('throws for nonexistent endpoint id', () => {
    assert.throws(
      () => findEndpointOrThrow(skill, 'nonexistent'),
      (err: Error) => err.message.includes('not found')
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/services/skill-loader.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

```typescript
// src/services/skill-loader.ts
import { readSkillFile } from '../skill/store.js';
import type { SkillFile, SkillEndpoint } from '../types.js';

/** Load a skill file or throw if not found. */
export async function loadSkillOrThrow(domain: string, skillsDir?: string): Promise<SkillFile> {
  const skill = await readSkillFile(domain, skillsDir);
  if (!skill) {
    throw new Error(`No skill file found for "${domain}". Use apitap capture first.`);
  }
  return skill;
}

/** Find an endpoint by ID within a skill file, or throw. */
export function findEndpointOrThrow(skill: SkillFile, endpointId: string): SkillEndpoint {
  const endpoint = skill.endpoints.find(e => e.id === endpointId);
  if (!endpoint) {
    const ids = skill.endpoints.map(e => e.id).join(', ');
    throw new Error(`Endpoint "${endpointId}" not found in ${skill.domain}. Available: ${ids}`);
  }
  return endpoint;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/services/skill-loader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/skill-loader.ts test/services/skill-loader.test.ts
git commit -m "refactor: extract skill-loader service"
```

---

### Task 5: Create replay service

**Files:**
- Create: `src/services/replay.ts`
- Test: `test/services/replay.test.ts`

**Step 1: Write the test**

This test creates a skill file on disk and verifies the service wires everything together. Use the same tmpdir pattern as existing e2e tests.

```typescript
// test/services/replay.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { injectStoredAuth } from '../src/services/replay.js';
import type { SkillEndpoint, StoredAuth } from '../src/types.js';

describe('injectStoredAuth', () => {
  it('replaces [stored] placeholder with actual auth value', () => {
    const endpoint: SkillEndpoint = {
      id: 'test',
      method: 'GET',
      path: '/test',
      queryParams: {},
      headers: { authorization: '[stored]' },
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/test', headers: {} }, responsePreview: null },
    };

    const auth: StoredAuth = {
      type: 'bearer',
      header: 'authorization',
      value: 'Bearer test-token',
    };

    injectStoredAuth(endpoint, auth);
    assert.equal(endpoint.headers.authorization, 'Bearer test-token');
  });

  it('does nothing when no [stored] placeholder', () => {
    const endpoint: SkillEndpoint = {
      id: 'test',
      method: 'GET',
      path: '/test',
      queryParams: {},
      headers: { accept: 'application/json' },
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/test', headers: {} }, responsePreview: null },
    };

    injectStoredAuth(endpoint, null);
    assert.equal(endpoint.headers.accept, 'application/json');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/services/replay.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

```typescript
// src/services/replay.ts
import { replayEndpoint, type ReplayResult, type ReplayOptions } from '../replay/engine.js';
import { loadSkillOrThrow, findEndpointOrThrow } from './skill-loader.js';
import { createAuthManager } from './auth-factory.js';
import type { SkillEndpoint, StoredAuth } from '../types.js';

/** Inject stored auth into endpoint headers that have [stored] placeholders. */
export function injectStoredAuth(endpoint: SkillEndpoint, auth: StoredAuth | null): void {
  const hasPlaceholder = Object.values(endpoint.headers).some(v => v === '[stored]');
  if (hasPlaceholder && auth) {
    endpoint.headers[auth.header] = auth.value;
  }
}

export interface ReplayWithAuthOptions {
  params?: Record<string, string>;
  fresh?: boolean;
  maxBytes?: number;
  skillsDir?: string;
  /** @internal Skip SSRF check — for testing only */
  _skipSsrfCheck?: boolean;
}

/**
 * High-level replay: load skill, find endpoint, inject auth, replay.
 * Consolidates the boilerplate duplicated across cli.ts, mcp.ts, plugin.ts.
 */
export async function replayWithAuth(
  domain: string,
  endpointId: string,
  opts: ReplayWithAuthOptions = {},
): Promise<ReplayResult> {
  const skill = await loadSkillOrThrow(domain, opts.skillsDir);
  const endpoint = findEndpointOrThrow(skill, endpointId);
  const authManager = await createAuthManager();

  try {
    const storedAuth = await authManager.retrieve(domain);
    injectStoredAuth(endpoint, storedAuth);
  } catch {
    // Auth retrieval failed — proceed without it
  }

  return replayEndpoint(skill, endpoint, {
    params: opts.params,
    fresh: opts.fresh,
    maxBytes: opts.maxBytes,
    authManager,
    domain,
    _skipSsrfCheck: opts._skipSsrfCheck,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/services/replay.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/replay.ts test/services/replay.test.ts
git commit -m "refactor: extract replay service with auth injection"
```

---

### Task 6: Run full test suite to verify Phase 1

**Step 1: Run full test suite**

Run: `npm test`
Expected: All 721+ tests pass. Phase 1 is purely additive — no existing code was modified.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 3: Commit (if any fixes needed)**

---

## Phase 2: Split cli.ts into cli/

### Task 7: Create CLI parser and helpers modules

**Files:**
- Create: `src/cli/parser.ts`
- Create: `src/cli/helpers.ts`
- Test: `test/cli/parser.test.ts`
- Test: `test/cli/helpers.test.ts`

**Step 1: Write tests for parser**

```typescript
// test/cli/parser.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli/parser.js';

describe('parseArgs', () => {
  it('parses command and positional args', () => {
    const result = parseArgs(['capture', 'https://example.com']);
    assert.equal(result.command, 'capture');
    assert.deepEqual(result.positional, ['https://example.com']);
  });

  it('parses --flag value pairs', () => {
    const result = parseArgs(['capture', 'url', '--duration', '30']);
    assert.equal(result.flags.duration, '30');
  });

  it('parses boolean flags', () => {
    const result = parseArgs(['list', '--json']);
    assert.equal(result.flags.json, true);
  });

  it('supports --flag=value syntax', () => {
    const result = parseArgs(['capture', '--duration=30']);
    assert.equal(result.flags.duration, '30');
  });

  it('defaults command to help', () => {
    const result = parseArgs([]);
    assert.equal(result.command, 'help');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/cli/parser.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write parser implementation**

```typescript
// src/cli/parser.ts

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const arg = rest[i].slice(2);
      // Support --flag=value syntax
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg] = next;
          i++;
        } else {
          flags[arg] = true;
        }
      }
    } else {
      positional.push(rest[i]);
    }
  }

  return { command, positional, flags };
}
```

**Step 4: Write tests for helpers**

```typescript
// test/cli/helpers.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo, requireArg } from '../src/cli/helpers.js';

describe('timeAgo', () => {
  it('returns "just now" for recent timestamps', () => {
    assert.equal(timeAgo(new Date().toISOString()), 'just now');
  });

  it('returns minutes for <1h', () => {
    const d = new Date(Date.now() - 5 * 60000).toISOString();
    assert.equal(timeAgo(d), '5m ago');
  });
});

describe('requireArg', () => {
  it('returns value when present', () => {
    assert.equal(requireArg('hello', 'Usage: test'), 'hello');
  });

  it('throws when undefined', () => {
    assert.throws(() => requireArg(undefined, 'Usage: test'), /Usage: test/);
  });
});
```

**Step 5: Write helpers implementation**

```typescript
// src/cli/helpers.ts
import { TIER_BADGES } from '../constants.js';

export { TIER_BADGES };

export function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function requireArg(value: string | undefined, usage: string): string {
  if (!value) throw new Error(usage);
  return value;
}

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputError(message: string, json: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}
```

**Step 6: Run tests to verify they pass**

Run: `node --import tsx --test test/cli/parser.test.ts test/cli/helpers.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/cli/parser.ts src/cli/helpers.ts test/cli/parser.test.ts test/cli/helpers.test.ts
git commit -m "refactor: create cli/parser.ts and cli/helpers.ts"
```

---

### Task 8: Extract CLI commands to individual files

This is the largest single task. Extract each handler from `src/cli.ts` into its own file under `src/cli/commands/`. Each command module exports a single `handle` function.

**Files:**
- Create: `src/cli/commands/capture.ts` (from cli.ts lines 144-275)
- Create: `src/cli/commands/search.ts` (from cli.ts lines 277-304)
- Create: `src/cli/commands/list.ts` (from cli.ts lines 306-327)
- Create: `src/cli/commands/show.ts` (from cli.ts lines 329-364)
- Create: `src/cli/commands/replay.ts` (from cli.ts lines 366-428)
- Create: `src/cli/commands/import.ts` (from cli.ts lines 430-478)
- Create: `src/cli/commands/refresh.ts` (from cli.ts lines 480-523)
- Create: `src/cli/commands/auth.ts` (from cli.ts lines 525-630)
- Create: `src/cli/commands/serve.ts` (from cli.ts lines 632-669)
- Create: `src/cli/commands/inspect.ts` (from cli.ts lines 682-752)
- Create: `src/cli/commands/stats.ts` (from cli.ts lines 754-765)
- Create: `src/cli/commands/discover.ts` (from cli.ts lines 767-855)
- Create: `src/cli/commands/browse.ts` (from cli.ts lines 857-899)
- Create: `src/cli/commands/peek.ts` (from cli.ts lines 901-929)
- Create: `src/cli/commands/read.ts` (from cli.ts lines 931-966)
- Create: `src/cli/index.ts` (dispatch table)
- Modify: `src/cli.ts` (reduce to thin entry point)

**Approach:** Move handlers one by one. After each group, run the full test suite. Use services where available (auth-factory, skill-loader, url normalizer, replay service). Keep the same behavior — this is a pure structural refactor.

**Step 1: Create the command interface and a few example commands**

Each command file follows this pattern:

```typescript
// src/cli/commands/list.ts
import { listSkillFiles } from '../../skill/store.js';
import { getSkillsDir } from '../../constants.js';
import { timeAgo, outputJson } from '../helpers.js';

export async function handle(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const json = flags.json === true;
  const skills = await listSkillFiles(getSkillsDir());
  if (json) {
    outputJson(skills);
    return;
  }
  if (skills.length === 0) {
    console.log('No skill files found. Run `apitap capture <url>` to get started.');
    return;
  }
  for (const s of skills) {
    console.log(`  ${s.domain.padEnd(35)} ${String(s.endpointCount).padStart(2)} endpoints   ${timeAgo(s.capturedAt)}`);
  }
}
```

**Step 2: Create the dispatch index**

```typescript
// src/cli/index.ts
import { parseArgs } from './parser.js';

// Lazy imports to avoid loading all commands upfront
const COMMANDS: Record<string, () => Promise<{ handle: (p: string[], f: Record<string, string | boolean>) => Promise<void> }>> = {
  capture:  () => import('./commands/capture.js'),
  search:   () => import('./commands/search.js'),
  list:     () => import('./commands/list.js'),
  show:     () => import('./commands/show.js'),
  replay:   () => import('./commands/replay.js'),
  import:   () => import('./commands/import.js'),
  refresh:  () => import('./commands/refresh.js'),
  auth:     () => import('./commands/auth.js'),
  serve:    () => import('./commands/serve.js'),
  inspect:  () => import('./commands/inspect.js'),
  stats:    () => import('./commands/stats.js'),
  discover: () => import('./commands/discover.js'),
  browse:   () => import('./commands/browse.js'),
  peek:     () => import('./commands/peek.js'),
  read:     () => import('./commands/read.js'),
};

export async function main(argv: string[]): Promise<void> {
  const { command, positional, flags } = parseArgs(argv);

  if (command === 'help' || flags.help) {
    const { printUsage } = await import('./commands/help.js');
    printUsage();
    return;
  }

  if (command === '--version' || flags.version) {
    const { printVersion } = await import('./commands/help.js');
    printVersion();
    return;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(`Unknown command: ${command}. Run "apitap help" for usage.`);
    process.exit(1);
  }

  const mod = await loader();
  await mod.handle(positional, flags);
}
```

**Step 3: Reduce src/cli.ts to entry point**

```typescript
#!/usr/bin/env node
// src/cli.ts
import { main } from './cli/index.js';

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

**Step 4: Move all 15 command handlers to individual files**

For each handler, the transformation is:
1. Copy the handler function body
2. Replace `APITAP_DIR`/`SKILLS_DIR` with `getApitapDir()`/`getSkillsDir()` from constants
3. Replace auth setup boilerplate with `createAuthManager()` from services
4. Replace skill loading boilerplate with `loadSkillOrThrow()` from services
5. Replace URL normalization with `normalizeUrl()` from services
6. Import helpers from `../helpers.js` (timeAgo, outputJson, requireArg, TIER_BADGES)
7. Export as `handle(positional, flags)`

This is mechanical — preserve exact behavior, just move code.

**Step 5: Create help command with usage text and version**

```typescript
// src/cli/commands/help.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function printVersion(): void {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
  console.log(pkg.version);
}

export function printUsage(): void {
  console.log(`
  apitap — API interception for AI agents

  Usage:
    apitap capture <url>       Capture API traffic from a website
    apitap discover <url>      Detect APIs without a browser (fast recon)
    apitap inspect <url>       Discover APIs without saving (X-ray vision)
    apitap search <query>      Search skill files for a domain or endpoint
    apitap list                List available skill files
    apitap show <domain>       Show endpoints for a domain
    apitap replay <domain> <endpoint-id> [key=value...]
                               Replay an API endpoint
    apitap import <file>       Import a skill file with safety validation
    apitap refresh <domain>    Refresh auth tokens via browser
    apitap auth [domain]       View or manage stored auth
    apitap serve <domain>      Serve a skill file as an MCP server
    apitap browse <url>        Browse a URL (discover + replay in one step)
    apitap peek <url>          Zero-cost triage (HEAD only)
    apitap read <url>          Extract content without a browser
    apitap stats               Show token savings report

  Options:
    --json                     Machine-readable JSON output
    --version                  Print version
    --help                     Show this help
`);
}
```

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass. The CLI binary entry point hasn't changed, so all CLI tests that spawn `npx tsx src/cli.ts` continue to work.

**Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 8: Commit**

```bash
git add src/cli.ts src/cli/ test/cli/parser.test.ts test/cli/helpers.test.ts
git commit -m "refactor: split cli.ts into per-command modules under src/cli/"
```

---

## Phase 3: Split mcp.ts into mcp/

### Task 9: Create MCP helpers and SessionManager

**Files:**
- Create: `src/mcp/helpers.ts`
- Create: `src/mcp/session-manager.ts`
- Test: `test/mcp/session-manager.test.ts`

**Step 1: Write the test for SessionManager**

```typescript
// test/mcp/session-manager.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/mcp/session-manager.js';

describe('SessionManager', () => {
  it('stores and retrieves sessions by id', () => {
    const mgr = new SessionManager(3);
    const fakeSession = { id: 'abc', isActive: true } as any;
    mgr.add('abc', fakeSession);
    assert.equal(mgr.get('abc'), fakeSession);
  });

  it('returns null for unknown session id', () => {
    const mgr = new SessionManager(3);
    assert.equal(mgr.get('nonexistent'), null);
  });

  it('cleans up inactive sessions on get miss', () => {
    const mgr = new SessionManager(3);
    mgr.add('old', { id: 'old', isActive: false } as any);
    mgr.add('active', { id: 'active', isActive: true } as any);
    mgr.get('nonexistent'); // triggers cleanup
    assert.equal(mgr.get('old'), null);
    assert.ok(mgr.get('active'));
  });

  it('reports full when at max capacity', () => {
    const mgr = new SessionManager(2);
    mgr.add('a', { id: 'a', isActive: true } as any);
    mgr.add('b', { id: 'b', isActive: true } as any);
    assert.equal(mgr.isFull(), true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/mcp/session-manager.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write SessionManager**

```typescript
// src/mcp/session-manager.ts
import type { CaptureSession } from '../capture/session.js';

export class SessionManager {
  private sessions = new Map<string, CaptureSession>();
  private maxSessions: number;

  constructor(maxSessions: number = 3) {
    this.maxSessions = maxSessions;
  }

  add(id: string, session: CaptureSession): void {
    this.sessions.set(id, session);
  }

  get(id: string): CaptureSession | null {
    const session = this.sessions.get(id);
    if (session) return session;
    // Clean up expired sessions on miss
    for (const [sid, s] of this.sessions) {
      if (!s.isActive) this.sessions.delete(sid);
    }
    return null;
  }

  isFull(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
}
```

**Step 4: Write MCP helpers**

```typescript
// src/mcp/helpers.ts

/** Wrap response data with MCP untrusted content metadata. */
export function wrapExternalContent(data: unknown, source: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    _meta: {
      externalContent: { untrusted: true, source },
    },
  };
}

/** Format a successful text response. */
export function textResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

/** Format an error response. */
export function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}
```

**Step 5: Run tests**

Run: `node --import tsx --test test/mcp/session-manager.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/mcp/helpers.ts src/mcp/session-manager.ts test/mcp/session-manager.test.ts
git commit -m "refactor: create mcp/helpers.ts and mcp/session-manager.ts"
```

---

### Task 10: Split MCP tools into individual files

**Files:**
- Create: `src/mcp/tools/search.ts` (from mcp.ts lines 62-88)
- Create: `src/mcp/tools/discover.ts` (from mcp.ts lines 91-133)
- Create: `src/mcp/tools/replay.ts` (from mcp.ts lines 136-256, includes batch)
- Create: `src/mcp/tools/browse.ts` (from mcp.ts lines 259-297)
- Create: `src/mcp/tools/read.ts` (from mcp.ts lines 300-364, includes peek)
- Create: `src/mcp/tools/capture.ts` (from mcp.ts lines 367-575, includes session tools)
- Create: `src/mcp/tools/auth.ts` (from mcp.ts lines 578-620)
- Create: `src/mcp/index.ts` (server setup + tool registration)
- Modify: `src/mcp.ts` (reduce to thin entry point)

**Approach:** Each tool file exports a function `registerTools(server, options)` that registers its tools on the MCP server instance. The index file creates the server and calls each registration function.

**Step 1: Create the tool registration pattern**

Each tool file follows this structure:

```typescript
// src/mcp/tools/search.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchSkills } from '../../skill/search.js';
import { textResponse, errorResponse } from '../helpers.js';

export function registerSearchTools(server: McpServer, options: { skillsDir?: string }): void {
  server.tool(
    'apitap_search',
    'Search available API skill files...',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      try {
        const results = await searchSkills(query, options.skillsDir);
        return textResponse(results);
      } catch (err: any) {
        return errorResponse(`Search failed: ${err.message}`);
      }
    }
  );
}
```

**Step 2: Create MCP index that composes all tools**

```typescript
// src/mcp/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from './session-manager.js';
import { SessionCache } from '../orchestration/cache.js';
import { registerSearchTools } from './tools/search.js';
import { registerDiscoverTools } from './tools/discover.js';
import { registerReplayTools } from './tools/replay.js';
import { registerBrowseTools } from './tools/browse.js';
import { registerReadTools } from './tools/read.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerAuthTools } from './tools/auth.js';

export interface McpServerOptions {
  skillsDir?: string;
  _skipSsrfCheck?: boolean;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'apitap', version: '0.5.0' });
  const sessionManager = new SessionManager();
  const sessionCache = new SessionCache();

  const ctx = { ...options, sessionManager, sessionCache };

  registerSearchTools(server, ctx);
  registerDiscoverTools(server, ctx);
  registerReplayTools(server, ctx);
  registerBrowseTools(server, ctx);
  registerReadTools(server, ctx);
  registerCaptureTools(server, ctx);
  registerAuthTools(server, ctx);

  return server;
}
```

**Step 3: Reduce src/mcp.ts to entry point**

```typescript
#!/usr/bin/env node
// src/mcp.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp/index.js';

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 4: Move all 12 tools to their respective files**

Same mechanical process as CLI split: copy tool handler code, replace inline patterns with service layer calls and MCP helpers, preserve exact behavior.

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass. MCP tests in `test/mcp/` import `createMcpServer` — ensure it's still exported from the same path or update imports.

**Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 7: Commit**

```bash
git add src/mcp.ts src/mcp/
git commit -m "refactor: split mcp.ts into per-tool modules under src/mcp/"
```

---

## Phase 4: Break Up Large Functions

### Task 11: Decompose replayEndpoint() in replay/engine.ts

**Files:**
- Modify: `src/replay/engine.ts`

**Step 1: Run existing replay tests to establish baseline**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: All pass — this is our baseline.

**Step 2: Extract buildReplayRequest()**

Extract lines 166-256 from `replayEndpoint()` into a new function:

```typescript
interface ReplayRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
  method: string;
}

function buildReplayRequest(
  skill: SkillFile,
  endpoint: SkillEndpoint,
  params: Record<string, string>,
  skipSsrf: boolean,
): ReplayRequest {
  // Path param substitution
  // URL construction with query params
  // SSRF validation
  // Header filtering (ALLOWED_SKILL_HEADERS / BLOCKED_HEADERS)
  // Body preparation
  // Returns assembled request
}
```

**Step 3: Extract checkTokenFreshness()**

Extract JWT expiry check (lines 258-294):

```typescript
async function checkTokenFreshness(
  headers: Record<string, string>,
  authManager: AuthManager,
  domain: string,
  skill: SkillFile,
): Promise<{ refreshed: boolean }> {
  // JWT claims parsing
  // Expiry check
  // Proactive refresh if needed
  // Re-inject auth header
}
```

**Step 4: Extract executeWithRedirects()**

Extract lines 296-408 (fetch + redirect handling + 401 retry):

```typescript
async function executeWithRedirects(
  request: ReplayRequest,
  options: { skipSsrf: boolean; authManager?: AuthManager; domain?: string; skill?: SkillFile },
): Promise<Response> {
  // Initial fetch with redirect: 'manual'
  // Redirect following with SSRF re-check
  // 401/403 retry with token refresh
}
```

**Step 5: Extract processResponse()**

Extract lines 410-440:

```typescript
function processResponse(
  response: Response,
  text: string,
  maxBytes?: number,
): { status: number; headers: Record<string, string>; data: unknown; truncated?: boolean } {
  // Header conversion
  // JSON/text detection
  // Truncation
}
```

**Step 6: Rewrite replayEndpoint() as orchestrator**

```typescript
export async function replayEndpoint(
  skill: SkillFile,
  endpoint: SkillEndpoint,
  options?: ReplayOptions | Record<string, string>,
): Promise<ReplayResult> {
  const opts = normalizeOptions(options);
  const request = await buildReplayRequest(skill, endpoint, opts.params ?? {}, opts._skipSsrfCheck ?? false);

  if (opts.authManager && opts.domain) {
    const { refreshed } = await checkTokenFreshness(request.headers, opts.authManager, opts.domain, skill);
    if (refreshed) result.refreshed = true;
  }

  const response = await executeWithRedirects(request, opts);
  const text = await response.text();
  return processResponse(response, text, opts.maxBytes);
}
```

**Step 7: Run replay tests**

Run: `node --import tsx --test test/replay/engine.test.ts`
Expected: All pass — behavior is identical.

**Step 8: Run full test suite**

Run: `npm test`
Expected: All pass.

**Step 9: Commit**

```bash
git add src/replay/engine.ts
git commit -m "refactor: decompose replayEndpoint into focused helpers"
```

---

### Task 12: Decompose addExchange() in skill/generator.ts

**Files:**
- Modify: `src/skill/generator.ts`

**Step 1: Run existing generator tests**

Run: `node --import tsx --test test/skill/generator.test.ts`
Expected: All pass — baseline.

**Step 2: Extract classifyExchange()**

Extract URL parsing, GraphQL detection, path parameterization (lines 201-234):

```typescript
interface ExchangeClassification {
  url: URL;
  method: string;
  contentType: string;
  isGraphQL: boolean;
  operationName?: string;
  parameterizedPath: string;
  dedupKey: string;
}

function classifyExchange(exchange: CapturedExchange): ExchangeClassification {
  // URL parsing
  // GraphQL detection
  // Path parameterization
  // Dedup key generation
}
```

**Step 3: Extract buildEndpointFromExchange()**

Extract endpoint construction logic (lines 260-375):

```typescript
function buildEndpointFromExchange(
  exchange: CapturedExchange,
  classification: ExchangeClassification,
  options: GeneratorOptions,
): { endpoint: SkillEndpoint; auth: StoredAuth | null; oauth: OAuthInfo | null } {
  // Auth extraction
  // Header filtering
  // Query param extraction
  // Response shape detection
  // Body processing
  // Pagination detection
  // Endpoint assembly
}
```

**Step 4: Rewrite addExchange() as orchestrator**

The method becomes ~40 lines: classify → check duplicate → build → store.

**Step 5: Run generator tests**

Run: `node --import tsx --test test/skill/generator.test.ts`
Expected: All pass.

**Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/skill/generator.ts
git commit -m "refactor: decompose addExchange into classify + build helpers"
```

---

### Task 13: Decompose interact() in capture/session.ts

**Files:**
- Modify: `src/capture/session.ts`

**Step 1: Run session tests**

Run: `node --import tsx --test test/capture/session.test.ts`
Expected: All pass — baseline.

**Step 2: Extract action methods**

Replace the switch statement in `interact()` with private methods:

```typescript
private async doClick(action: InteractionAction): Promise<InteractionResult> { ... }
private async doType(action: InteractionAction): Promise<InteractionResult> { ... }
private async doSelect(action: InteractionAction): Promise<InteractionResult> { ... }
private async doNavigate(action: InteractionAction): Promise<InteractionResult> { ... }
private async doScroll(action: InteractionAction): Promise<InteractionResult> { ... }
private async doWait(action: InteractionAction): Promise<InteractionResult> { ... }
```

**Step 3: Replace switch with dispatch**

```typescript
async interact(action: InteractionAction): Promise<InteractionResult> {
  if (this.expired) return { success: false, error: 'Session expired', snapshot: this.emptySnapshot() };
  if (this.closed) return { success: false, error: 'Session closed', snapshot: this.emptySnapshot() };
  if (!this.page) return { success: false, error: 'Session not started', snapshot: this.emptySnapshot() };

  try {
    switch (action.action) {
      case 'snapshot': return { success: true, snapshot: await this.takeSnapshot() };
      case 'click':    return await this.doClick(action);
      case 'type':     return await this.doType(action);
      case 'select':   return await this.doSelect(action);
      case 'navigate': return await this.doNavigate(action);
      case 'scroll':   return await this.doScroll(action);
      case 'wait':     return await this.doWait(action);
      default:         return { success: false, error: `Unknown action: ${(action as any).action}`, snapshot: await this.takeSnapshot() };
    }
  } catch (err: any) {
    try {
      return { success: false, error: err.message, snapshot: await this.takeSnapshot() };
    } catch {
      return { success: false, error: err.message, snapshot: this.emptySnapshot() };
    }
  }
}
```

**Step 4: Run session tests**

Run: `node --import tsx --test test/capture/session.test.ts`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/capture/session.ts
git commit -m "refactor: extract interact() switch cases into private methods"
```

---

### Task 14: Decompose htmlToMarkdown() in read/extract.ts

**Files:**
- Modify: `src/read/extract.ts`

**Step 1: Run extract tests**

Run: `node --import tsx --test test/read/extract.test.ts`
Expected: All pass — baseline.

**Step 2: Extract transformer functions**

Break htmlToMarkdown into a pipeline of pure functions:

```typescript
function convertHeadings(md: string): string { ... }
function convertBlockquotes(md: string): string { ... }
function convertCodeBlocks(md: string): string { ... }
function convertImages(md: string, images: Array<{alt: string; src: string}>): string { ... }
function convertLinks(md: string, links: Array<{text: string; href: string}>): string { ... }
function convertFormatting(md: string): string { ... }  // bold, italic
function convertLists(md: string): string { ... }
function cleanWhitespace(md: string): string { ... }
```

**Step 3: Rewrite htmlToMarkdown as pipeline**

```typescript
export function htmlToMarkdown(
  html: string,
  links: Array<{text: string; href: string}>,
  images: Array<{alt: string; src: string}>,
): string {
  let md = html.replace(/<!--[\s\S]*?-->/g, '');
  md = convertHeadings(md);
  md = convertBlockquotes(md);
  md = convertCodeBlocks(md);
  md = convertImages(md, images);
  md = convertLinks(md, links);
  md = convertFormatting(md);
  md = convertLists(md);
  md = cleanWhitespace(md);
  return md.trim();
}
```

**Step 4: Run extract tests**

Run: `node --import tsx --test test/read/extract.test.ts`
Expected: All pass.

**Step 5: Run full read tests**

Run: `node --import tsx --test 'test/read/**/*.test.ts'`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/read/extract.ts
git commit -m "refactor: decompose htmlToMarkdown into transformer pipeline"
```

---

### Task 15: Decompose doBrowserRefresh() in auth/refresh.ts

**Files:**
- Modify: `src/auth/refresh.ts`

**Step 1: Run refresh tests**

Run: `node --import tsx --test test/auth/refresh.test.ts`
Expected: All pass — baseline.

**Step 2: Extract restoreSession()**

```typescript
async function restoreSession(
  context: BrowserContext,
  session: StoredSession | undefined,
): Promise<void> {
  if (!session || !isSessionValid(session)) return;
  await context.addCookies(session.cookies);
  // localStorage restoration if needed
}
```

**Step 3: Extract captureTokensFromTraffic()**

```typescript
async function captureTokensFromTraffic(
  page: Page,
  tokenNames: string[],
  authManager: AuthManager,
  domain: string,
): Promise<Record<string, string>> {
  const captured: Record<string, string> = {};
  // Set up request interception
  // Extract token values from request bodies
  // Store via authManager
  return captured;
}
```

**Step 4: Rewrite doBrowserRefresh as orchestrator**

~30 lines: launch browser → restore session → navigate → detect captcha → capture tokens → save session → return result.

**Step 5: Run refresh tests**

Run: `node --import tsx --test test/auth/refresh.test.ts test/auth/refresh-dispatcher.test.ts`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/auth/refresh.ts
git commit -m "refactor: decompose doBrowserRefresh into focused helpers"
```

---

## Phase 5: Cleanup

### Task 16: Remove plugin.ts and update exports

**Files:**
- Delete: `src/plugin.ts`
- Modify: `src/index.ts` (remove plugin exports, add service exports)
- Modify: `test/plugin/plugin.test.ts` (if it tests plugin.ts directly, remove or adapt)

**Step 1: Check what imports plugin.ts**

Search for imports of `./plugin.js` or `createPlugin` across the codebase. Update or remove references.

**Step 2: Update src/index.ts**

Remove the plugin export line:
```typescript
// Remove this line:
export { createPlugin, type Plugin, type ToolDefinition, type PluginOptions } from './plugin.js';

// Add service exports:
export { createAuthManager } from './services/auth-factory.js';
export { loadSkillOrThrow, findEndpointOrThrow } from './services/skill-loader.js';
export { replayWithAuth, injectStoredAuth } from './services/replay.js';
export { normalizeUrl } from './services/url.js';
export { getApitapDir, getSkillsDir, TIER_BADGES } from './constants.js';

// Add MCP export:
export { createMcpServer, type McpServerOptions } from './mcp/index.js';
```

**Step 3: Delete plugin.ts**

```bash
rm src/plugin.ts
```

**Step 4: Run full test suite**

Run: `npm test`
Expected: All pass (may need to remove/update plugin-specific tests).

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove plugin.ts, export services from index.ts"
```

---

### Task 17: Final cleanup and verification

**Files:**
- Modify: Various (remove dead imports, unused code)

**Step 1: Remove dead imports**

- Remove `detectAntiBot` import from any file where it's unused
- Remove any other unused imports flagged by typecheck

**Step 2: Run full test suite**

Run: `npm test`
Expected: All 721+ tests pass.

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 4: Run build**

Run: `npm run build`
Expected: Compiles cleanly to dist/.

**Step 5: Verify CLI still works end-to-end**

Run: `npx tsx src/cli.ts --version`
Expected: Prints version number.

Run: `npx tsx src/cli.ts help`
Expected: Prints usage.

Run: `npx tsx src/cli.ts list --json`
Expected: Prints JSON array of skill files (or empty array).

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: final cleanup — remove dead imports, verify build"
```

---

## Summary

| Phase | Tasks | What changes |
|-------|-------|-------------|
| 1: Service Layer | Tasks 1-6 | New `src/services/` and `src/constants.ts` (additive) |
| 2: CLI Split | Tasks 7-8 | `src/cli.ts` → `src/cli/` with 15 command modules |
| 3: MCP Split | Tasks 9-10 | `src/mcp.ts` → `src/mcp/` with 7 tool modules |
| 4: Functions | Tasks 11-15 | Break up 5 oversized functions in-place |
| 5: Cleanup | Tasks 16-17 | Remove plugin.ts, update exports, dead code |

Each phase is independently verifiable — run `npm test` after each task.

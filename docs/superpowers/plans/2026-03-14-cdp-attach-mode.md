# CDP Attach Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `apitap attach` CLI command that connects to a running Chrome browser via CDP, passively captures API traffic across all tabs, and generates signed skill files on Ctrl+C.

**Architecture:** One new module (`src/capture/cdp-attach.ts`) handles CDP WebSocket communication, browser-level target management, and network event collection. It feeds captured exchanges through the existing `shouldCapture()` → `SkillGenerator` → `signSkillFile()` → `writeSkillFile()` pipeline. The CLI wires it up with SIGINT handling and stderr progress output.

**Tech Stack:** Node.js built-in `WebSocket` (Node 22+), `http` for CDP discovery, existing ApiTap filter/generator/signing/store modules.

**Spec:** `docs/superpowers/specs/2026-03-14-cdp-attach-mode-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/capture/cdp-attach.ts` | Create | CDP client, browser-level attach, multi-target Network capture, domain glob filtering |
| `src/capture/filter.ts` | Modify | Add `chrome-extension://` and `moz-extension://` URL scheme blocking |
| `src/cli.ts` | Modify | Add `attach` command to parser, usage text, and switch statement |
| `test/capture/cdp-attach.test.ts` | Create | Unit tests for domain glob matching, exchange collection, SIGINT behavior |
| `test/capture/filter.test.ts` | Modify | Add test for extension URL blocking |

---

## Chunk 1: Self-Capture Prevention (filter.ts fix)

### Task 1: Block chrome-extension:// URLs in filter.ts

**Files:**
- Modify: `src/capture/filter.ts:38-56`
- Modify: `test/capture/filter.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/capture/filter.test.ts`, add a test case for extension URLs:

```ts
it('rejects chrome-extension:// URLs', () => {
  assert.equal(shouldCapture({
    url: 'chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/api/data',
    status: 200,
    contentType: 'application/json',
  }), false);
});

it('rejects moz-extension:// URLs', () => {
  assert.equal(shouldCapture({
    url: 'moz-extension://abcd1234/api/data',
    status: 200,
    contentType: 'application/json',
  }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/filter.test.ts`
Expected: FAIL — extension URLs currently pass through shouldCapture

- [ ] **Step 3: Add extension URL blocking to shouldCapture()**

In `src/capture/filter.ts`, add at the top of `shouldCapture()`, before the status check:

```ts
export function shouldCapture(response: FilterableResponse): boolean {
  // Block extension-internal traffic (prevents self-capture when
  // attaching to a browser with ApiTap extension loaded)
  if (response.url.startsWith('chrome-extension://')) return false;
  if (response.url.startsWith('moz-extension://')) return false;

  // Only keep 2xx success responses
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/capture/filter.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: No new failures

- [ ] **Step 6: Commit**

```bash
git add src/capture/filter.ts test/capture/filter.test.ts
git commit -m "fix: block chrome-extension:// URLs in shouldCapture (self-capture prevention)"
```

---

## Chunk 2: Domain Glob Matching

### Task 2: Domain glob matcher utility

**Files:**
- Create: `src/capture/cdp-attach.ts` (start with just the glob utility, exported for testing)
- Create: `test/capture/cdp-attach.test.ts`

- [ ] **Step 1: Write the failing tests for domain glob matching**

Create `test/capture/cdp-attach.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesDomainGlob } from '../../src/capture/cdp-attach.js';

describe('matchesDomainGlob', () => {
  it('matches exact domain', () => {
    assert.equal(matchesDomainGlob('api.github.com', ['api.github.com']), true);
  });

  it('rejects non-matching exact domain', () => {
    assert.equal(matchesDomainGlob('api.stripe.com', ['api.github.com']), false);
  });

  it('*.domain matches subdomains', () => {
    assert.equal(matchesDomainGlob('api.github.com', ['*.github.com']), true);
    assert.equal(matchesDomainGlob('raw.github.com', ['*.github.com']), true);
  });

  it('*.domain matches bare domain (zero or more subdomains)', () => {
    assert.equal(matchesDomainGlob('github.com', ['*.github.com']), true);
  });

  it('*.domain does NOT match unrelated domain with same suffix', () => {
    assert.equal(matchesDomainGlob('notgithub.com', ['*.github.com']), false);
  });

  it('matches any pattern in a list', () => {
    assert.equal(matchesDomainGlob('api.stripe.com', ['*.github.com', '*.stripe.com']), true);
  });

  it('returns true when pattern list is empty (no filter)', () => {
    assert.equal(matchesDomainGlob('anything.com', []), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/cdp-attach.test.ts`
Expected: FAIL — module does not exist yet

- [ ] **Step 3: Implement matchesDomainGlob**

Create `src/capture/cdp-attach.ts` with the glob matcher:

```ts
// src/capture/cdp-attach.ts

/**
 * Test if a hostname matches any pattern in a domain glob list.
 * Empty list means "match all" (no filter).
 *
 * Glob rules:
 * - "api.github.com" — exact match
 * - "*.github.com" — matches any subdomain AND the bare domain
 *   (the *. prefix means "zero or more subdomains")
 */
export function matchesDomainGlob(hostname: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;

  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2); // "github.com"
      // Match bare domain or any subdomain
      if (hostname === base || hostname.endsWith('.' + base)) {
        return true;
      }
    } else {
      if (hostname === pattern) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/capture/cdp-attach.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/capture/cdp-attach.ts test/capture/cdp-attach.test.ts
git commit -m "feat(attach): add domain glob matcher for --domain filter"
```

---

## Chunk 3: CDP Client Core

### Task 3: CDP WebSocket session class and browser discovery

**Files:**
- Modify: `src/capture/cdp-attach.ts`

- [ ] **Step 1: Write tests for parseDomainPatterns**

Add to `test/capture/cdp-attach.test.ts`:

```ts
import { parseDomainPatterns } from '../../src/capture/cdp-attach.js';

describe('parseDomainPatterns', () => {
  it('splits comma-separated patterns', () => {
    assert.deepEqual(parseDomainPatterns('*.github.com,api.stripe.com'), ['*.github.com', 'api.stripe.com']);
  });

  it('trims whitespace', () => {
    assert.deepEqual(parseDomainPatterns(' *.github.com , api.stripe.com '), ['*.github.com', 'api.stripe.com']);
  });

  it('returns empty array for undefined', () => {
    assert.deepEqual(parseDomainPatterns(undefined), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseDomainPatterns(''), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/capture/cdp-attach.test.ts`
Expected: FAIL — parseDomainPatterns not exported

- [ ] **Step 3: Implement parseDomainPatterns, CDPSession, and discoverBrowserWsUrl**

Add to `src/capture/cdp-attach.ts`:

```ts
import http from 'node:http';
import type { CapturedExchange } from '../types.js';
import { shouldCapture } from './filter.js';
import { SkillGenerator } from '../skill/generator.js';

/**
 * Parse a comma-separated domain pattern string into a list.
 */
export function parseDomainPatterns(input: string | undefined): string[] {
  if (!input || input.trim() === '') return [];
  return input.split(',').map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Discover Chrome's browser-level WebSocket URL via the /json/version endpoint.
 */
export async function discoverBrowserWsUrl(port: number): Promise<{ wsUrl: string; browser: string; tabCount?: number }> {
  const versionInfo = await cdpGet<{
    Browser: string;
    webSocketDebuggerUrl: string;
  }>(`http://127.0.0.1:${port}/json/version`);

  const targets = await cdpGet<Array<{ type: string }>>(`http://127.0.0.1:${port}/json/list`);
  const tabCount = targets.filter(t => t.type === 'page').length;

  return {
    wsUrl: versionInfo.webSocketDebuggerUrl,
    browser: versionInfo.Browser,
    tabCount,
  };
}

function cdpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

/** Minimal CDP session over a WebSocket (browser-level, with session multiplexing) */
export class CDPSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private callbacks = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(private wsUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e}`));
      this.ws.onclose = () => {
        for (const [, cb] of this.callbacks) {
          clearTimeout(cb.timer);
          cb.reject(new Error('CDP connection closed'));
        }
        this.callbacks.clear();
        // Fire close listeners
        for (const handler of this.listeners.get('close') ?? []) {
          handler({});
        }
      };
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(
          typeof event.data === 'string' ? event.data : String(event.data)
        ) as Record<string, unknown>;

        if (msg.id !== undefined && this.callbacks.has(msg.id as number)) {
          const cb = this.callbacks.get(msg.id as number)!;
          clearTimeout(cb.timer);
          this.callbacks.delete(msg.id as number);
          if (msg.error) {
            const err = msg.error as { message: string };
            cb.reject(new Error(`CDP: ${err.message}`));
          } else {
            cb.resolve(msg.result);
          }
        }

        if (msg.method) {
          const sessionId = msg.sessionId as string | undefined;
          // Fire session-scoped handlers: "sessionId:Event.name"
          if (sessionId) {
            const scopedKey = `${sessionId}:${msg.method as string}`;
            for (const handler of this.listeners.get(scopedKey) ?? []) {
              handler(msg.params as Record<string, unknown>);
            }
          }
          // Fire global handlers for all events
          for (const handler of this.listeners.get(msg.method as string) ?? []) {
            handler({
              ...(msg.params as Record<string, unknown>),
              ...(sessionId ? { _sessionId: sessionId } : {}),
            });
          }
        }
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.callbacks.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws!.send(JSON.stringify(msg));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/capture/cdp-attach.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/capture/cdp-attach.ts test/capture/cdp-attach.test.ts
git commit -m "feat(attach): CDP session class and browser discovery"
```

---

## Chunk 4: Attach Engine

### Task 4: The main attach() function — target management, network capture, SIGINT handling

**Files:**
- Modify: `src/capture/cdp-attach.ts`

- [ ] **Step 1: Implement the attach engine**

Add the following imports to the top of `src/capture/cdp-attach.ts`:

```ts
import { signSkillFile } from '../skill/signing.js';
import { writeSkillFile } from '../skill/store.js';
import { getMachineId } from '../auth/manager.js';
import { deriveSigningKey } from '../auth/crypto.js';
import { homedir } from 'node:os';
```

Add the `attach()` function and types:

```ts
export interface AttachOptions {
  port: number;
  domainPatterns: string[];
  json: boolean;
  onProgress?: (line: string) => void;
}

export interface AttachResult {
  domains: Array<{
    domain: string;
    endpoints: number;
    skillFile: string;
  }>;
  totalRequests: number;
  filteredRequests: number;
  duration: number;
}

export async function attach(options: AttachOptions): Promise<AttachResult> {
  const { port, domainPatterns, json } = options;
  const log = (msg: string) => {
    if (!json) process.stderr.write(msg + '\n');
    options.onProgress?.(msg);
  };

  // Register SIGINT handler BEFORE connecting (spec requirement)
  let shutdownResolve: ((result: AttachResult) => void) | null = null;
  let stopping = false;

  // Phase 0: Discover browser
  let browserInfo;
  try {
    browserInfo = await discoverBrowserWsUrl(port);
  } catch {
    log(`[attach] Cannot connect to Chrome on :${port}`);
    log('');
    log('To enable remote debugging, relaunch Chrome with:');
    log(`  google-chrome --remote-debugging-port=${port}`);
    log('');
    log('Or on macOS:');
    log(`  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`);
    process.exit(1);
  }

  log(`[attach] Connected to ${browserInfo.browser} on :${port} (${browserInfo.tabCount} tabs)`);
  if (domainPatterns.length > 0) {
    log(`[attach] Watching domains: ${domainPatterns.join(', ')}`);
  } else {
    log('[attach] Watching all domains');
  }

  // Phase 1: Connect browser-level CDP session
  const browser = new CDPSession(browserInfo.wsUrl);
  await browser.connect();

  // Capture state
  const generators = new Map<string, SkillGenerator>();
  const requests = new Map<string, {
    url: string; method: string; headers: Record<string, string>; postData?: string;
  }>();
  const responses = new Map<string, {
    status: number; headers: Record<string, string>; mimeType: string;
  }>();
  let totalRequests = 0;
  let filteredRequests = 0;
  const startTime = Date.now();
  const activeSessions = new Set<string>();

  function enableNetworkForSession(sessionId: string): void {
    if (activeSessions.has(sessionId)) return;
    activeSessions.add(sessionId);

    // Prefix requestIds with sessionId to avoid collisions across tabs
    const prefix = sessionId.slice(0, 8);

    browser.on(`${sessionId}:Network.requestWillBeSent`, (params) => {
      const key = `${prefix}:${params.requestId}`;
      const request = params.request as Record<string, unknown>;
      requests.set(key, {
        url: request.url as string,
        method: request.method as string,
        headers: request.headers as Record<string, string>,
        postData: request.postData as string | undefined,
      });
    });

    browser.on(`${sessionId}:Network.responseReceived`, (params) => {
      const key = `${prefix}:${params.requestId}`;
      const response = params.response as Record<string, unknown>;
      responses.set(key, {
        status: response.status as number,
        headers: response.headers as Record<string, string>,
        mimeType: response.mimeType as string,
      });
    });

    browser.on(`${sessionId}:Network.loadingFinished`, (params) => {
      const key = `${prefix}:${params.requestId}`;
      const req = requests.get(key);
      const resp = responses.get(key);
      if (!req || !resp) return;

      totalRequests++;

      // Get response body immediately (before Chrome evicts it from buffer).
      // This MUST be called synchronously in the handler — deferring risks
      // "No resource with given identifier found" on high-traffic tabs.
      browser.send(
        'Network.getResponseBody',
        { requestId: params.requestId },
        sessionId,
      ).then((result) => {
        processExchange(key, req, resp, (result.body as string) ?? '', log);
      }).catch(() => {
        // Body evicted or unavailable — still process exchange without body
        processExchange(key, req, resp, '', log);
      });
    });

    // Enable network capture for this session (fire-and-forget)
    browser.send('Network.enable', {}, sessionId).catch(() => {
      // Session may have been destroyed
    });
  }

  function processExchange(
    key: string,
    req: { url: string; method: string; headers: Record<string, string>; postData?: string },
    resp: { status: number; headers: Record<string, string>; mimeType: string },
    body: string,
    log: (msg: string) => void,
  ): void {
    // Apply shouldCapture filter
    if (!shouldCapture({ url: req.url, status: resp.status, contentType: resp.mimeType })) {
      filteredRequests++;
      if (req.url.startsWith('chrome-extension://')) {
        log(`  [skip] ${req.url.slice(0, 50)}... (extension)`);
      }
      return;
    }

    // Apply domain glob filter
    let hostname: string;
    try {
      hostname = new URL(req.url).hostname;
    } catch { return; }

    if (!matchesDomainGlob(hostname, domainPatterns)) {
      filteredRequests++;
      return;
    }

    // Get or create generator for this domain
    if (!generators.has(hostname)) {
      generators.set(hostname, new SkillGenerator());
    }
    const gen = generators.get(hostname)!;

    const exchange: CapturedExchange = {
      request: {
        url: req.url,
        method: req.method,
        headers: req.headers,
        postData: req.postData,
      },
      response: {
        status: resp.status,
        headers: resp.headers,
        body,
        contentType: resp.mimeType,
      },
      timestamp: new Date().toISOString(),
    };

    const endpoint = gen.addExchange(exchange);
    if (endpoint) {
      log(`  [api] ${req.method} ${resp.status} ${hostname} ${endpoint.path}`);
    }

    // Clean up to avoid memory growth
    requests.delete(key);
    responses.delete(key);
  }

  // Phase 2: Attach to all existing page targets
  const { targetInfos } = await browser.send('Target.getTargets') as {
    targetInfos: Array<{ type: string; targetId: string }>;
  };
  for (const target of targetInfos) {
    if (target.type === 'page') {
      try {
        const result = await browser.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        enableNetworkForSession(result.sessionId as string);
      } catch {
        // Target may have navigated away
      }
    }
  }

  // Phase 3: Auto-attach to future targets (new tabs, popups, OAuth redirects)
  browser.on('Target.attachedToTarget', (params) => {
    const targetInfo = params.targetInfo as { type: string } | undefined;
    if (targetInfo?.type === 'page') {
      enableNetworkForSession(params.sessionId as string);
    }
  });

  await browser.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  // Phase 4: Wait for SIGINT or browser disconnect
  const result = await new Promise<AttachResult>((resolve) => {
    shutdownResolve = resolve;

    const shutdown = async () => {
      if (stopping) {
        // Second SIGINT — force exit immediately
        process.exit(1);
      }
      stopping = true;
      log('');

      const duration = Math.round((Date.now() - startTime) / 1000);

      if (generators.size === 0) {
        log('[attach] Nothing captured');
        browser.close();
        resolve({ domains: [], totalRequests, filteredRequests, duration });
        return;
      }

      log('[attach] Generating skill files...');

      const machineId = await getMachineId();
      const signingKey = deriveSigningKey(machineId);
      const domains: AttachResult['domains'] = [];

      for (const [domain, gen] of generators) {
        let skill = gen.toSkillFile(domain);
        if (skill.endpoints.length === 0) continue;

        skill = signSkillFile(skill, signingKey);
        const skillPath = await writeSkillFile(skill);

        const displayPath = skillPath.replace(homedir(), '~');
        const count = skill.endpoints.length;
        log(`  ${domain} — ${count} endpoint${count === 1 ? '' : 's'} → ${displayPath}`);

        domains.push({ domain, endpoints: count, skillFile: displayPath });
      }

      browser.close();
      resolve({ domains, totalRequests, filteredRequests, duration });
    };

    process.on('SIGINT', shutdown);

    // Handle browser disconnect (user closed Chrome)
    browser.on('close', () => {
      if (!stopping) shutdown();
    });
  });

  return result;
}
```

- [ ] **Step 2: Verify the module compiles**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/capture/cdp-attach.ts
git commit -m "feat(attach): CDP attach engine with multi-target network capture"
```

---

## Chunk 5: CLI Integration

### Task 5: Wire attach command into cli.ts

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add import at top of cli.ts**

After the existing imports, add:

```ts
import { attach, parseDomainPatterns } from './capture/cdp-attach.js';
```

- [ ] **Step 2: Add attach to printUsage()**

Add after the `capture` line in the usage text:

```
    apitap attach [--port 9222] [--domain *.github.com]
                               Attach to running Chrome and capture API traffic
```

- [ ] **Step 3: Add handleAttach function**

Add before the `main()` function:

```ts
async function handleAttach(_positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const port = typeof flags.port === 'string' ? parseInt(flags.port, 10) : 9222;
  const domainPatterns = parseDomainPatterns(
    typeof flags.domain === 'string' ? flags.domain : undefined
  );
  const json = flags.json === true;

  const result = await attach({ port, domainPatterns, json });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
}
```

- [ ] **Step 4: Add case to switch statement**

In the `switch (command)` block, add before `default`:

```ts
    case 'attach':
      await handleAttach(positional, flags);
      break;
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat(attach): wire attach command into CLI"
```

---

## Chunk 6: Export and Integration Test

### Task 6: Export from index.ts and add integration test

**Files:**
- Modify: `src/index.ts`
- Create: `test/capture/cdp-attach-integration.test.ts`

- [ ] **Step 1: Add export to src/index.ts**

```ts
export { attach, matchesDomainGlob, parseDomainPatterns } from './capture/cdp-attach.js';
```

- [ ] **Step 2: Write integration test**

Create `test/capture/cdp-attach-integration.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';

const TEST_PORT = 9333; // avoid conflicting with user's 9222

// Check if Chrome is installed (skip gracefully on CI without Chrome)
let chromeAvailable = false;
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('which', ['google-chrome'], { stdio: 'ignore' });
  chromeAvailable = true;
} catch { /* Chrome not installed */ }

function cdpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

describe('CDP attach integration', { skip: !chromeAvailable ? 'Chrome not installed' : undefined }, () => {
  let chrome: ChildProcess;

  before(async () => {
    chrome = spawn('google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      `--remote-debugging-port=${TEST_PORT}`,
      '--user-data-dir=/tmp/apitap-attach-test-chrome',
    ], { stdio: 'ignore' });

    // Wait for CDP to be ready
    for (let i = 0; i < 20; i++) {
      try {
        await cdpGet(`http://127.0.0.1:${TEST_PORT}/json/version`);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  });

  after(() => {
    if (chrome) chrome.kill();
  });

  it('discovers browser WebSocket URL and tab count', async () => {
    const { discoverBrowserWsUrl } = await import('../../src/capture/cdp-attach.js');

    const info = await discoverBrowserWsUrl(TEST_PORT);
    assert.ok(info.wsUrl.startsWith('ws://'));
    assert.ok(info.browser.includes('Chrome') || info.browser.includes('Headless'));
    assert.equal(typeof info.tabCount, 'number');
  });
});
```

- [ ] **Step 3: Run integration test**

Run: `node --import tsx --test test/capture/cdp-attach-integration.test.ts`
Expected: PASS (may skip if Chrome not installed on CI)

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: No new failures

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/capture/cdp-attach-integration.test.ts
git commit -m "feat(attach): export API and add integration test"
```

---

## Chunk 7: Manual Smoke Test and PR

### Task 7: End-to-end verification on a live browser

This is a manual verification step, not automated.

- [ ] **Step 1: Launch Chrome with remote debugging**

```bash
google-chrome --remote-debugging-port=9222
```

- [ ] **Step 2: Run attach**

```bash
npx tsx src/cli.ts attach --port 9222 --domain *.github.com
```

- [ ] **Step 3: Browse to a GitHub API endpoint in the Chrome instance**

Navigate to `https://api.github.com/repos/n1byn1kt/apitap` in Chrome.

- [ ] **Step 4: Verify stderr shows captured request**

Expected output:
```
[attach] Connected to Chrome 146 on :9222 (N tabs)
[attach] Watching domains: *.github.com
  [api] GET 200 api.github.com /repos/:owner/:repo
```

- [ ] **Step 5: Ctrl+C and verify skill file**

Expected:
```
[attach] Generating skill files...
  api.github.com — 1 endpoint → ~/.apitap/skills/api.github.com.json
```

- [ ] **Step 6: Verify skill file is signed and replayable**

```bash
npx tsx src/cli.ts show api.github.com
# Should show [signed ✓], not [unsigned]

npx tsx src/cli.ts replay api.github.com get-repos owner=n1byn1kt repo=apitap
# Should return 200 with JSON
```

- [ ] **Step 7: Push branch and create PR**

```bash
git push -u origin feat/cdp-attach-mode
```

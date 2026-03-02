# Agent-Browser Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let AI agents transparently access the user's authenticated browser sessions — when `apitap_browse` hits an auth wall, it escalates to the Chrome extension, captures API traffic from the user's real browser, and returns data in one round trip.

**Architecture:** The native messaging host becomes a bidirectional relay with a Unix domain socket (`~/.apitap/bridge.sock`) on the CLI side and persistent stdio on the extension side. The extension handles `capture_request` messages with per-site user consent, tab finding, and plateau-based capture duration. The `browse.ts` orchestration gains one new escalation step before its final fallback.

**Tech Stack:** TypeScript, Node.js `net.createServer` (Unix socket), Chrome `runtime.connectNative` (persistent port), `chrome.storage.local` (consent), `chrome.tabs.query` (tab finding), `chrome.notifications` (consent UI)

**Design doc:** `docs/plans/2026-03-02-agent-browser-bridge-design.md`

---

### Task 1: Add Unix socket server to native host

The native host currently reads one-shot messages from the extension via stdio. We add a Unix domain socket server so the CLI can connect and send requests that get relayed to the extension.

**Files:**
- Modify: `src/native-host.ts`
- Test: `test/native-host.test.ts`

**Step 1: Write the failing test**

Add to `test/native-host.test.ts`:
```typescript
import net from 'node:net';
import { startSocketServer, stopSocketServer } from '../src/native-host.js';

describe('unix socket relay', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-socket-test-'));
    socketPath = path.join(tmpDir, 'bridge.sock');
  });

  afterEach(async () => {
    await stopSocketServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts CLI connections and relays messages', async () => {
    // Mock extension handler — instead of relaying to extension, handle directly
    const mockHandler = async (msg: any) => {
      if (msg.action === 'ping') return { success: true, action: 'pong' };
      return { success: false, error: 'unknown' };
    };

    await startSocketServer(socketPath, mockHandler);

    // Connect as CLI client
    const response = await sendSocketMessage(socketPath, { action: 'ping' });
    assert.equal(response.success, true);
    assert.equal(response.action, 'pong');
  });

  it('handles concurrent CLI connections', async () => {
    const mockHandler = async (msg: any) => {
      // Simulate slow response
      await new Promise(r => setTimeout(r, 50));
      return { success: true, domain: msg.domain };
    };

    await startSocketServer(socketPath, mockHandler);

    const [r1, r2] = await Promise.all([
      sendSocketMessage(socketPath, { action: 'capture_request', domain: 'a.com' }),
      sendSocketMessage(socketPath, { action: 'capture_request', domain: 'b.com' }),
    ]);

    assert.equal(r1.domain, 'a.com');
    assert.equal(r2.domain, 'b.com');
  });

  it('cleans up stale socket on startup', async () => {
    // Create a stale socket file
    await fs.writeFile(socketPath, 'stale');

    const mockHandler = async () => ({ success: true });
    await startSocketServer(socketPath, mockHandler);

    const response = await sendSocketMessage(socketPath, { action: 'ping' });
    assert.equal(response.success, true);
  });

  it('returns error for invalid JSON', async () => {
    const mockHandler = async () => ({ success: true });
    await startSocketServer(socketPath, mockHandler);

    const response = await new Promise<any>((resolve) => {
      const client = net.createConnection(socketPath, () => {
        const msg = Buffer.from('not-json\n');
        client.write(msg);
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk; });
      client.on('end', () => { resolve(JSON.parse(data)); });
    });

    assert.equal(response.success, false);
    assert.ok(response.error?.includes('Invalid'));
  });
});

// Helper for tests — also used by the CLI bridge client
function sendSocketMessage(socketPath: string, message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(message) + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid response')); }
    });
    client.on('error', reject);
  });
}
```

**Step 2: Run test to verify it fails**

```bash
node --import tsx --test test/native-host.test.ts
```
Expected: FAIL — `startSocketServer` and `stopSocketServer` don't exist.

**Step 3: Implement the Unix socket server**

Add to `src/native-host.ts`:

```typescript
import net from 'node:net';

let socketServer: net.Server | null = null;

type MessageHandler = (message: any) => Promise<any>;

export async function startSocketServer(
  socketPath: string,
  handler: MessageHandler,
): Promise<void> {
  // Clean up stale socket
  try { await fs.unlink(socketPath); } catch { /* doesn't exist — fine */ }

  return new Promise((resolve, reject) => {
    socketServer = net.createServer((conn) => {
      let buffer = '';

      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) return;

        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        let request: any;
        try {
          request = JSON.parse(line);
        } catch {
          conn.end(JSON.stringify({ success: false, error: 'Invalid JSON' }) + '\n');
          return;
        }

        handler(request).then(
          (response) => conn.end(JSON.stringify(response) + '\n'),
          (err) => conn.end(JSON.stringify({ success: false, error: String(err) }) + '\n'),
        );
      });

      conn.on('error', () => { /* client disconnect — ignore */ });
    });

    socketServer.on('error', reject);
    socketServer.listen(socketPath, () => resolve());
  });
}

export async function stopSocketServer(): Promise<void> {
  if (!socketServer) return;
  return new Promise((resolve) => {
    socketServer!.close(() => resolve());
    socketServer = null;
  });
}
```

Also update the `NativeRequest` type to include the new action:

```typescript
export interface NativeRequest {
  action: 'save_skill' | 'save_batch' | 'ping' | 'capture_request';
  domain?: string;
  skillJson?: string;
  skills?: Array<{ domain: string; skillJson: string }>;
}
```

**Step 4: Run test to verify it passes**

```bash
node --import tsx --test test/native-host.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/native-host.ts test/native-host.test.ts
git commit -m "feat: unix socket server in native host for CLI relay"
```

---

### Task 2: Wire socket server into native host main loop with extension relay

The socket server needs to relay CLI requests to the extension via the stdio channel (Chrome native messaging), and forward extension responses back to the CLI.

**Files:**
- Modify: `src/native-host.ts`
- Test: `test/native-host.test.ts`

**Step 1: Write the failing test**

Add to `test/native-host.test.ts`:

```typescript
import { createRelayHandler } from '../src/native-host.js';

describe('relay handler', () => {
  it('routes save_skill to local handler', async () => {
    let relayedToExtension = false;
    const sendToExtension = async (msg: any) => {
      relayedToExtension = true;
      return { success: true };
    };

    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-relay-test-'));
    const handler = createRelayHandler(sendToExtension, tmpDir2);

    const result = await handler({
      action: 'save_skill',
      domain: 'test.com',
      skillJson: JSON.stringify({ domain: 'test.com', endpoints: [] }),
    });

    assert.equal(result.success, true);
    assert.equal(relayedToExtension, false); // save_skill handled locally
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });

  it('routes capture_request to extension', async () => {
    let relayedMessage: any = null;
    const sendToExtension = async (msg: any) => {
      relayedMessage = msg;
      return { success: true, skillFiles: [{ domain: 'x.com', endpoints: [] }] };
    };

    const handler = createRelayHandler(sendToExtension);
    const result = await handler({ action: 'capture_request', domain: 'x.com' });

    assert.equal(result.success, true);
    assert.deepEqual(relayedMessage, { action: 'capture_request', domain: 'x.com' });
  });

  it('returns error when extension relay fails', async () => {
    const sendToExtension = async () => {
      throw new Error('extension disconnected');
    };

    const handler = createRelayHandler(sendToExtension);
    const result = await handler({ action: 'capture_request', domain: 'x.com' });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('extension disconnected'));
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --import tsx --test test/native-host.test.ts
```
Expected: FAIL — `createRelayHandler` doesn't exist.

**Step 3: Implement the relay handler**

Add to `src/native-host.ts`:

```typescript
// Actions handled locally by the native host (filesystem operations)
const LOCAL_ACTIONS = new Set(['save_skill', 'save_batch', 'ping']);

// Actions relayed to the extension (browser operations)
const EXTENSION_ACTIONS = new Set(['capture_request']);

export function createRelayHandler(
  sendToExtension: (msg: any) => Promise<any>,
  skillsDir: string = SKILLS_DIR,
): MessageHandler {
  return async (message: any) => {
    if (LOCAL_ACTIONS.has(message.action)) {
      return handleNativeMessage(message, skillsDir);
    }

    if (EXTENSION_ACTIONS.has(message.action)) {
      try {
        return await sendToExtension(message);
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    return { success: false, error: `Unknown action: ${message.action}` };
  };
}
```

Update the main loop to start the socket server and use the relay handler:

```typescript
if (isMainModule) {
  const bridgeDir = path.join(os.homedir(), '.apitap');
  const socketPath = path.join(bridgeDir, 'bridge.sock');

  // Pending CLI requests waiting for extension responses
  const pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let requestCounter = 0;

  // Send a message to the extension via stdout and wait for response
  function sendToExtension(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = String(++requestCounter);
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        resolve({ success: false, error: 'approval_timeout' });
      }, 60_000);

      pendingRequests.set(id, { resolve, timer });

      // Tag message with ID so we can match the response
      sendMessage({ ...message, _relayId: id });
    });
  }

  const handler = createRelayHandler(sendToExtension);

  (async () => {
    // Ensure bridge directory exists
    await fs.mkdir(bridgeDir, { recursive: true });

    // Start socket server for CLI connections
    await startSocketServer(socketPath, handler);

    // Read messages from extension via stdin
    while (true) {
      const message = await readMessage();
      if (!message) break;

      // Check if this is a response to a relayed request
      if (message._relayId && pendingRequests.has(message._relayId)) {
        const pending = pendingRequests.get(message._relayId)!;
        clearTimeout(pending.timer);
        pendingRequests.delete(message._relayId);
        const { _relayId, ...response } = message;
        pending.resolve(response);
        continue;
      }

      // Otherwise, handle as a direct extension message (save_skill, etc.)
      const response = await handleNativeMessage(message);
      sendMessage(response);
    }

    // Extension disconnected — clean up
    await stopSocketServer();
    try { await fs.unlink(socketPath); } catch { /* already gone */ }
  })();
}
```

**Step 4: Run test to verify it passes**

```bash
node --import tsx --test test/native-host.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/native-host.ts test/native-host.test.ts
git commit -m "feat: relay handler routes CLI requests to extension via stdio"
```

---

### Task 3: Switch extension to persistent native port

The extension currently uses `chrome.runtime.sendNativeMessage()` (one-shot). Switch to `chrome.runtime.connectNative()` (persistent port) so it can receive messages initiated by the CLI.

**Files:**
- Modify: `extension/src/background.ts`
- Modify: `extension/src/types.ts`

**Step 1: Update types to include agent messages**

Replace `extension/src/types.ts` with:

```typescript
export interface CaptureState {
  active: boolean;
  tabId: number | null;
  domain: string | null;
  requestCount: number;
  endpointCount: number;
  authDetected: { type: string; header: string } | null;
  bridgeConnected: boolean;
  autoSaved: string[] | null;
}

// Messages from popup → background
export interface CaptureMessage {
  type: 'START_CAPTURE' | 'STOP_CAPTURE' | 'GET_STATE' | 'DOWNLOAD_SKILL';
}

// Responses from background → popup
export interface CaptureResponse {
  type: 'STATE_UPDATE' | 'CAPTURE_COMPLETE' | 'ERROR';
  state?: CaptureState;
  skillJson?: string;
  error?: string;
}

// Messages from native host → extension (CLI-initiated requests)
export interface AgentRequest {
  action: 'capture_request';
  domain: string;
  _relayId?: string;
}

// Responses from extension → native host (back to CLI)
export interface AgentResponse {
  success: boolean;
  skillFiles?: any[];
  error?: string;
  _relayId?: string;
}
```

**Step 2: Replace one-shot messaging with persistent port**

In `extension/src/background.ts`, replace the native messaging bridge section (lines 11-65) with:

```typescript
import type { CaptureState, CaptureMessage, CaptureResponse, AgentRequest, AgentResponse } from './types.js';

// --- Native messaging bridge (persistent port) ---

const NATIVE_HOST = 'com.apitap.native';

let bridgeAvailable = false;
let nativePort: chrome.runtime.Port | null = null;

// Pending responses for one-shot messages (save_skill, ping)
const pendingPortMessages = new Map<string, {
  resolve: (value: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let portMsgCounter = 0;

function connectNativePort(): void {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    bridgeAvailable = true;

    nativePort.onMessage.addListener((message: any) => {
      // Check if this is a response to a message we sent
      if (message._portMsgId && pendingPortMessages.has(message._portMsgId)) {
        const pending = pendingPortMessages.get(message._portMsgId)!;
        clearTimeout(pending.timer);
        pendingPortMessages.delete(message._portMsgId);
        const { _portMsgId, ...response } = message;
        pending.resolve(response);
        return;
      }

      // Otherwise, this is a CLI-initiated request relayed through the native host
      if (message.action === 'capture_request') {
        handleAgentCapture(message as AgentRequest).then((response) => {
          // Send response back with the relay ID so native host can route it
          nativePort?.postMessage({ ...response, _relayId: message._relayId });
        });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      bridgeAvailable = false;
      nativePort = null;
      // Reject all pending messages
      for (const [id, pending] of pendingPortMessages) {
        clearTimeout(pending.timer);
        pending.resolve({ success: false, error: 'native host disconnected' });
      }
      pendingPortMessages.clear();

      // Reconnect after a delay
      setTimeout(connectNativePort, 5000);
    });
  } catch {
    bridgeAvailable = false;
    nativePort = null;
  }
}

// Send a message to the native host and wait for response
function sendNativePortMessage(message: any, timeout = 10_000): Promise<any> {
  return new Promise((resolve) => {
    if (!nativePort) {
      resolve({ success: false, error: 'native host not connected' });
      return;
    }

    const id = String(++portMsgCounter);
    const timer = setTimeout(() => {
      pendingPortMessages.delete(id);
      resolve({ success: false, error: 'timeout' });
    }, timeout);

    pendingPortMessages.set(id, { resolve, timer });
    nativePort.postMessage({ ...message, _portMsgId: id });
  });
}

// Convenience wrappers (replace old checkBridge/saveViaBridge)
async function checkBridge(): Promise<boolean> {
  if (!nativePort) {
    connectNativePort();
    // Give it a moment to connect
    await new Promise(r => setTimeout(r, 100));
  }
  return bridgeAvailable;
}

async function saveViaBridge(skills: Array<{ domain: string; skillJson: string }>): Promise<{ success: boolean; paths?: string[]; error?: string }> {
  if (skills.length === 1) {
    return sendNativePortMessage({
      action: 'save_skill',
      domain: skills[0].domain,
      skillJson: skills[0].skillJson,
    });
  }
  return sendNativePortMessage({ action: 'save_batch', skills });
}
```

**Step 3: Add placeholder for handleAgentCapture**

Add to `extension/src/background.ts` (we'll implement it fully in Task 5):

```typescript
// --- Agent-initiated capture ---
// Placeholder — full implementation in Task 5

async function handleAgentCapture(request: AgentRequest): Promise<AgentResponse> {
  return { success: false, error: 'not_implemented' };
}
```

**Step 4: Update startup code**

Replace the startup code at the bottom of `background.ts`:

```typescript
// Connect to native messaging host on startup
connectNativePort();
```

Remove the old `checkBridge().then(...)` block.

**Step 5: Build and verify**

```bash
cd extension && npm run build
```
Expected: "Extension built successfully"

**Step 6: Commit**

```bash
git add extension/src/background.ts extension/src/types.ts
git commit -m "feat: persistent native port for bidirectional messaging"
```

---

### Task 4: Per-site consent management

The extension needs to check, store, and revoke per-site consent for agent-initiated captures.

**Files:**
- Create: `extension/src/consent.ts`
- Test: `test/extension/consent.test.ts`

**Step 1: Write the failing test**

Create `test/extension/consent.test.ts`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isApproved,
  addApprovedDomain,
  removeApprovedDomain,
  getApprovedDomains,
} from '../../extension/src/consent.js';

// Mock chrome.storage.local for Node.js tests
const mockStorage: Record<string, any> = {};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (result: any) => void) => {
        const result: Record<string, any> = {};
        for (const k of keys) {
          if (k in mockStorage) result[k] = mockStorage[k];
        }
        cb(result);
      },
      set: (items: Record<string, any>, cb?: () => void) => {
        Object.assign(mockStorage, items);
        cb?.();
      },
    },
  },
};

describe('consent management', () => {
  beforeEach(() => {
    // Clear mock storage
    for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  });

  it('returns false for unapproved domain', async () => {
    assert.equal(await isApproved('discord.com'), false);
  });

  it('returns true after domain is approved', async () => {
    await addApprovedDomain('discord.com');
    assert.equal(await isApproved('discord.com'), true);
  });

  it('returns empty list initially', async () => {
    const domains = await getApprovedDomains();
    assert.deepEqual(domains, []);
  });

  it('removes a domain', async () => {
    await addApprovedDomain('discord.com');
    await removeApprovedDomain('discord.com');
    assert.equal(await isApproved('discord.com'), false);
  });

  it('does not duplicate domains', async () => {
    await addApprovedDomain('discord.com');
    await addApprovedDomain('discord.com');
    const domains = await getApprovedDomains();
    assert.equal(domains.length, 1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --import tsx --test test/extension/consent.test.ts
```
Expected: FAIL — `consent.js` doesn't exist.

**Step 3: Implement consent.ts**

Create `extension/src/consent.ts`:

```typescript
const STORAGE_KEY = 'approvedAgentDomains';

function getStorage(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] ?? []);
    });
  });
}

function setStorage(domains: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: domains }, resolve);
  });
}

export async function isApproved(domain: string): Promise<boolean> {
  const domains = await getStorage();
  return domains.includes(domain);
}

export async function addApprovedDomain(domain: string): Promise<void> {
  const domains = await getStorage();
  if (!domains.includes(domain)) {
    domains.push(domain);
    await setStorage(domains);
  }
}

export async function removeApprovedDomain(domain: string): Promise<void> {
  const domains = await getStorage();
  await setStorage(domains.filter(d => d !== domain));
}

export async function getApprovedDomains(): Promise<string[]> {
  return getStorage();
}
```

**Step 4: Run test to verify it passes**

```bash
node --import tsx --test test/extension/consent.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add extension/src/consent.ts test/extension/consent.test.ts
git commit -m "feat: per-site consent management for agent captures"
```

---

### Task 5: Implement agent capture handler in extension

The full `handleAgentCapture` — consent check, tab finding, plateau capture, skill file return.

**Files:**
- Modify: `extension/src/background.ts`

**Step 1: Implement tab finder**

Add to `extension/src/background.ts`:

```typescript
async function findOrOpenTab(domain: string): Promise<chrome.tabs.Tab> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: `*://${domain}/*` }, (tabs) => {
      if (tabs.length > 0) {
        // Prefer active tab, then most recently accessed
        const active = tabs.find(t => t.active) ?? tabs[0];
        resolve(active);
      } else {
        // No matching tab — open a new one
        chrome.tabs.create({ url: `https://${domain}`, active: false }, (tab) => {
          resolve(tab);
        });
      }
    });
  });
}
```

**Step 2: Implement plateau capture**

This is similar to the existing capture flow but with auto-stop based on endpoint plateau.

Add to `extension/src/background.ts`:

```typescript
function captureWithPlateau(
  tabId: number,
  options: { idleTimeout: number; maxDuration: number },
): Promise<string[]> {
  return new Promise((resolve) => {
    // Reset state for agent capture
    generators = new DomainGeneratorMap();
    allSkillFiles = [];
    capturedDomains = [];
    lastSkillJson = null;

    let lastEndpointCount = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;

    function checkPlateau() {
      const current = generators.totalEndpoints;
      if (current > lastEndpointCount) {
        lastEndpointCount = current;
        // Reset idle timer — new endpoints found
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finishCapture, options.idleTimeout);
      }
    }

    function finishCapture() {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      if (plateauInterval) clearInterval(plateauInterval);

      chrome.debugger.onEvent.removeListener(onCdpEvent);
      chrome.debugger.detach({ tabId }, () => {
        if (chrome.runtime.lastError) { /* tab may be closed */ }
      });

      // Generate skill files
      const primaryDomain = pickPrimaryDomain(capturedDomains);
      if (primaryDomain && generators.domains.length > 0) {
        const skills = generators.toSkillFiles(state.requestCount);
        allSkillFiles = skills.map(s => scrubAuthFromSkillJson(JSON.stringify(s)));
      }

      state.active = false;
      state.tabId = null;
      pendingRequests.clear();
      pendingResponses.clear();
      generators.clear();
      capturedDomains = [];

      broadcastState();
      resolve(allSkillFiles);
    }

    // Set up state
    state = {
      active: true,
      tabId,
      domain: null,
      requestCount: 0,
      endpointCount: 0,
      authDetected: null,
      bridgeConnected: bridgeAvailable,
      autoSaved: null,
    };
    pendingRequests.clear();
    pendingResponses.clear();

    // Hard timeout
    maxTimer = setTimeout(finishCapture, options.maxDuration);

    // Start idle timer (first endpoints must appear within idleTimeout)
    idleTimer = setTimeout(finishCapture, options.idleTimeout);

    // Check for plateau every second
    const plateauInterval = setInterval(checkPlateau, 1000);

    // Attach debugger and start capture
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        clearInterval(plateauInterval);
        state.active = false;
        resolve([]);
        return;
      }

      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, () => {
        chrome.debugger.onEvent.addListener(onCdpEvent);
        broadcastState();
      });
    });
  });
}
```

**Step 3: Implement the full handleAgentCapture**

Replace the placeholder in `extension/src/background.ts`:

```typescript
import { isApproved, addApprovedDomain } from './consent.js';

async function handleAgentCapture(request: AgentRequest): Promise<AgentResponse> {
  const { domain } = request;

  if (!domain) {
    return { success: false, error: 'missing_domain' };
  }

  // Don't start a capture if one is already active
  if (state.active) {
    return { success: false, error: 'capture_in_progress' };
  }

  // Check per-site consent
  const approved = await isApproved(domain);
  if (!approved) {
    // Show consent notification — click opens popup with consent UI
    const granted = await requestConsentUI(domain);
    if (!granted) {
      return { success: false, error: 'user_denied' };
    }
    await addApprovedDomain(domain);
  }

  // Find or open a tab for the domain
  const tab = await findOrOpenTab(domain);
  if (!tab.id) {
    return { success: false, error: 'no_tab' };
  }

  // Capture with plateau detection
  const skillFiles = await captureWithPlateau(tab.id, {
    idleTimeout: 10_000,   // 10s no new endpoints → stop
    maxDuration: 120_000,  // 2 minute hard cap
  });

  if (skillFiles.length === 0) {
    return { success: false, error: 'no_endpoints_captured' };
  }

  // Parse skill files for the response
  const parsed = skillFiles.map(json => {
    try { return JSON.parse(json); }
    catch { return null; }
  }).filter(Boolean);

  return { success: true, skillFiles: parsed };
}
```

**Step 4: Implement consent UI via notification**

Add to `extension/src/background.ts`:

```typescript
// Pending consent callbacks — keyed by domain
const pendingConsent = new Map<string, {
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function requestConsentUI(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    const notifId = `consent-${domain}`;

    // 60 second timeout for user response
    const timer = setTimeout(() => {
      pendingConsent.delete(domain);
      chrome.notifications.clear(notifId);
      resolve(false);
    }, 60_000);

    pendingConsent.set(domain, { resolve, timer });

    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: 'icons/48.png',
      title: 'ApiTap Agent Request',
      message: `An agent wants to capture API traffic from ${domain}. Click to allow or deny.`,
      requireInteraction: true,
    });
  });
}

// Handle notification click → open popup with consent info
chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('consent-')) return;
  const domain = notifId.replace('consent-', '');

  // For now, clicking the notification means "Allow"
  // Future: open popup with Allow/Deny buttons
  const pending = pendingConsent.get(domain);
  if (pending) {
    clearTimeout(pending.timer);
    pendingConsent.delete(domain);
    chrome.notifications.clear(notifId);
    pending.resolve(true);
  }
});

// Handle notification closed without clicking → deny
chrome.notifications.onClosed.addListener((notifId, byUser) => {
  if (!notifId.startsWith('consent-')) return;
  const domain = notifId.replace('consent-', '');

  const pending = pendingConsent.get(domain);
  if (pending) {
    clearTimeout(pending.timer);
    pendingConsent.delete(domain);
    pending.resolve(false);
  }
});
```

**Step 5: Add `notifications` permission to manifest**

In `extension/manifest.json`, add `"notifications"` to permissions:

```json
"permissions": ["debugger", "activeTab", "storage", "downloads", "nativeMessaging", "notifications"],
```

Also add a `"tabs"` permission (needed for `chrome.tabs.query` with URL filter):

```json
"permissions": ["debugger", "activeTab", "tabs", "storage", "downloads", "nativeMessaging", "notifications"],
```

**Step 6: Build and verify**

```bash
cd extension && npm run build
```
Expected: "Extension built successfully"

**Step 7: Commit**

```bash
git add extension/src/background.ts extension/src/consent.ts extension/manifest.json
git commit -m "feat: agent-initiated capture with consent and plateau detection"
```

---

### Task 6: CLI bridge client

Create a client module the CLI uses to connect to the Unix socket and send requests.

**Files:**
- Create: `src/bridge/client.ts`
- Test: `test/bridge/client.test.ts`

**Step 1: Write the failing test**

Create `test/bridge/client.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { bridgeAvailable, requestBridgeCapture } from '../../src/bridge/client.js';

describe('bridge client', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: net.Server;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-client-test-'));
    socketPath = path.join(tmpDir, 'bridge.sock');
  });

  afterEach(async () => {
    server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function startMockServer(handler: (msg: any) => any): Promise<void> {
    return new Promise((resolve) => {
      server = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf('\n');
          if (idx === -1) return;
          const msg = JSON.parse(buf.slice(0, idx));
          const response = handler(msg);
          conn.end(JSON.stringify(response) + '\n');
        });
      });
      server.listen(socketPath, resolve);
    });
  }

  it('returns false when socket does not exist', async () => {
    assert.equal(await bridgeAvailable(socketPath), false);
  });

  it('returns true when socket exists and is connectable', async () => {
    await startMockServer(() => ({ success: true }));
    assert.equal(await bridgeAvailable(socketPath), true);
  });

  it('sends capture_request and returns skill files', async () => {
    await startMockServer((msg) => ({
      success: true,
      skillFiles: [{ domain: msg.domain, endpoints: [] }],
    }));

    const result = await requestBridgeCapture('discord.com', socketPath);
    assert.equal(result.success, true);
    assert.equal(result.skillFiles?.length, 1);
    assert.equal(result.skillFiles?.[0].domain, 'discord.com');
  });

  it('handles connection refused gracefully', async () => {
    // Socket file exists but nothing listening (stale)
    await fs.writeFile(socketPath, 'stale');

    const result = await requestBridgeCapture('discord.com', socketPath);
    assert.equal(result.success, false);
  });

  it('handles timeout', async () => {
    // Server that never responds
    await new Promise<void>((resolve) => {
      server = net.createServer(() => { /* no response */ });
      server.listen(socketPath, resolve);
    });

    const result = await requestBridgeCapture('discord.com', socketPath, { timeout: 500 });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timeout'));
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --import tsx --test test/bridge/client.test.ts
```
Expected: FAIL — `bridge/client.js` doesn't exist.

**Step 3: Implement the bridge client**

Create `src/bridge/client.ts`:

```typescript
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_SOCKET = path.join(os.homedir(), '.apitap', 'bridge.sock');

export interface BridgeCaptureResult {
  success: boolean;
  skillFiles?: any[];
  error?: string;
}

/**
 * Fast check: does the bridge socket exist?
 * Returns false if the file doesn't exist (costs ~0.1ms).
 * Returns true if the file exists (doesn't verify it's connectable).
 */
export async function bridgeAvailable(socketPath: string = DEFAULT_SOCKET): Promise<boolean> {
  try {
    await fs.access(socketPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a capture_request to the extension via the native host bridge.
 * Returns skill files on success, or a structured error.
 */
export async function requestBridgeCapture(
  domain: string,
  socketPath: string = DEFAULT_SOCKET,
  options: { timeout?: number } = {},
): Promise<BridgeCaptureResult> {
  const timeout = options.timeout ?? 120_000; // 2 minutes (capture can take time)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.destroy();
      resolve({ success: false, error: 'timeout' });
    }, timeout);

    const client = net.createConnection(socketPath, () => {
      const message = JSON.stringify({ action: 'capture_request', domain }) + '\n';
      client.write(message);
    });

    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });

    client.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ success: false, error: 'invalid response from bridge' });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `bridge connection failed: ${err.message}` });
    });
  });
}
```

**Step 4: Run test to verify it passes**

```bash
node --import tsx --test test/bridge/client.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/bridge/client.ts test/bridge/client.test.ts
git commit -m "feat: bridge client for CLI-to-extension communication"
```

---

### Task 7: Integrate bridge escalation into browse.ts

The final piece — add the extension bridge as an escalation step in the browse orchestration.

**Files:**
- Modify: `src/orchestration/browse.ts`
- Test: `test/orchestration/browse.test.ts`

**Step 1: Write the failing test**

Add to `test/orchestration/browse.test.ts`:

```typescript
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('browse with bridge escalation', () => {
  it('escalates to bridge when all paths fail and bridge is available', async () => {
    // This test mocks the bridge client to return a skill file
    // and verifies that browse() auto-replays after receiving it

    // Mock bridgeAvailable to return true
    // Mock requestBridgeCapture to return skill files
    // Mock writeSkillFile to capture what gets saved
    // Call browse() for a domain with no existing skill file
    // Assert: skill file was saved, replay was attempted, data returned

    // Full integration test — implement after wiring
  });

  it('skips bridge when socket does not exist', async () => {
    // Mock bridgeAvailable to return false
    // Call browse()
    // Assert: returns suggestion: 'capture_needed' (existing behavior)
  });

  it('handles bridge timeout gracefully', async () => {
    // Mock requestBridgeCapture to return timeout error
    // Assert: returns actionable suggestion string
  });

  it('handles user denial gracefully', async () => {
    // Mock requestBridgeCapture to return user_denied
    // Assert: returns suggestion about apitap auth request
  });
});
```

**Step 2: Add bridge escalation to browse.ts**

Read the current `browse.ts` to find the exact insertion point. The pattern: before every `return { success: false, suggestion: 'capture_needed' ... }`, try the bridge.

Add imports at top of `src/orchestration/browse.ts`:

```typescript
import { bridgeAvailable, requestBridgeCapture } from '../bridge/client.js';
import { signSkillFile } from '../skill/signing.js';
import { writeSkillFile } from '../skill/store.js';
import { getMachineId, deriveKey } from '../skill/signing.js';
```

Add a helper function:

```typescript
async function tryBridgeCapture(
  domain: string,
  url: string,
  task?: string,
): Promise<BrowseResult | null> {
  if (!await bridgeAvailable()) return null;

  const result = await requestBridgeCapture(domain);

  if (result.success && result.skillFiles?.length > 0) {
    // Sign and save each skill file
    try {
      const machineId = await getMachineId();
      const key = deriveKey(machineId);
      for (const skill of result.skillFiles) {
        const signed = signSkillFile(skill, key);
        await writeSkillFile(signed);
      }
    } catch {
      // Signing/saving failed — still have the data in memory
    }

    // Find the skill file matching the requested domain
    const primarySkill = result.skillFiles.find((s: any) => s.domain === domain)
      ?? result.skillFiles[0];

    if (primarySkill?.endpoints?.length > 0) {
      // Pick the best endpoint and replay it
      const endpoint = primarySkill.endpoints[0]; // simplest: first endpoint
      try {
        const { replayEndpoint } = await import('../replay/engine.js');
        const replayResult = await replayEndpoint(primarySkill, endpoint.id);
        if (replayResult.status >= 200 && replayResult.status < 300) {
          return {
            success: true,
            data: replayResult.data,
            domain,
            endpointId: endpoint.id,
            tier: endpoint.replayability?.tier ?? 'unknown',
            source: 'bridge',
            task,
          };
        }
      } catch {
        // Replay failed — but skill file is saved for next time
      }
    }

    // Skill file saved but replay didn't work — still a partial success
    return {
      success: false,
      reason: 'bridge_capture_saved',
      suggestion: `Captured ${result.skillFiles.length} skill file(s) from browser. Replay failed — try 'apitap replay ${domain}'.`,
      domain,
      url,
      task,
    };
  }

  // Bridge returned an error
  if (result.error === 'user_denied') {
    return {
      success: false,
      reason: 'user_denied',
      suggestion: `User denied browser access to ${domain}. Use 'apitap auth request ${domain}' for manual login instead.`,
      domain,
      url,
      task,
    };
  }

  if (result.error === 'approval_timeout') {
    return {
      success: false,
      reason: 'approval_timeout',
      suggestion: `User approval pending for ${domain}. Click Allow in the ApiTap extension and try again.`,
      domain,
      url,
      task,
    };
  }

  // Other bridge errors — fall through to existing fallback
  return null;
}
```

Then, before each `return { success: false, suggestion: 'capture_needed' ... }` in `browse()`, add:

```typescript
// Try extension bridge before giving up
const bridgeResult = await tryBridgeCapture(domain, fullUrl, task);
if (bridgeResult) return bridgeResult;
```

**Step 3: Run all tests to verify nothing breaks**

```bash
npm test
```
Expected: All tests pass.

**Step 4: Build extension**

```bash
cd extension && npm run build
```
Expected: "Extension built successfully"

**Step 5: Commit**

```bash
git add src/orchestration/browse.ts test/orchestration/browse.test.ts
git commit -m "feat: browse escalates to extension bridge on auth wall"
```

---

### Task 8: End-to-end integration test

Full round trip: CLI sends browse request → native host relays → extension captures → skill file signed and saved → replay returns data.

**Step 1: Run all unit tests**

```bash
npm test
```
Expected: All pass.

**Step 2: Build everything**

```bash
npm run build && cd extension && npm run build
```

**Step 3: Reload extension in Chrome**

1. `chrome://extensions` → Reload ApiTap
2. Note the extension ID

**Step 4: Install native messaging host**

```bash
npx tsx src/cli.ts extension install --extension-id <YOUR_EXTENSION_ID>
```

**Step 5: Verify bridge socket appears**

The native host starts when Chrome connects to it. Verify:
```bash
ls -la ~/.apitap/bridge.sock
```

**Step 6: Test manual capture still works**

1. Navigate to `https://jsonplaceholder.typicode.com/`
2. Click ApiTap → Start Capture → browse → Stop
3. Verify popup shows "Auto-saved" status

**Step 7: Test agent bridge flow**

```bash
# This should trigger the bridge:
npx tsx src/cli.ts browse https://www.reddit.com
```

Expected flow:
1. browse tries cache/disk/discover — fails (auth wall or no skill file)
2. Checks `~/.apitap/bridge.sock` — exists
3. Sends `capture_request` for `www.reddit.com`
4. Extension shows consent notification (first time)
5. User clicks Allow
6. Extension captures from existing Reddit tab (10s plateau)
7. Skill file returned, signed, saved to `~/.apitap/skills/www.reddit.com.json`
8. Replay returns data

```bash
# Verify skill file was saved:
npx tsx src/cli.ts show www.reddit.com

# Second call should be instant (from disk):
npx tsx src/cli.ts browse https://www.reddit.com
```

**Step 8: Test denial flow**

1. Remove Reddit from approved domains (clear `chrome.storage.local` or add a revoke mechanism)
2. Run `npx tsx src/cli.ts browse https://www.reddit.com` again
3. Close the notification without clicking
4. Verify: returns suggestion about manual auth

**Step 9: Test bridge unavailable flow**

1. Close Chrome (kills native host, removes socket)
2. Run `npx tsx src/cli.ts browse https://www.reddit.com`
3. Verify: returns existing "capture_needed" guidance (no bridge attempt)

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: agent-browser bridge — full integration verified"
```

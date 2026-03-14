// Import Buffer shim first — provides globalThis.Buffer for entropy.ts / oauth-detector.ts
import './shim.js';

import { shouldCapture } from '../../src/capture/filter.js';
import type { CapturedExchange } from '../../src/types.js';
import type { CaptureState, CaptureMessage, CaptureResponse, AgentRequest, AgentResponse } from './types.js';
import { extractDomain, pickPrimaryDomain } from './domain-utils.js';
import { DomainGeneratorMap } from './multi-domain.js';
import { isAllowedUrl, scrubAuthFromSkillJson } from './security.js';
import { processCompletedRequest, detectAuthType, extractAuthTokens } from './observer.js';
import { mergeObservation, createEmptyIndex } from './index-store.js';
import { markPromoted } from './promotion.js';
import { applyLifecycle } from './lifecycle.js';
import { encrypt, decrypt } from './crypto.js';
import type { IndexFile, IndexEntry } from './types.js';

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
    console.log('[apitap] native host connected');

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
      const err = chrome.runtime.lastError;
      console.warn('[apitap] native host disconnected:', err?.message ?? 'no error');
      bridgeAvailable = false;
      nativePort = null;
      // Reject all pending messages
      for (const [, pending] of pendingPortMessages) {
        clearTimeout(pending.timer);
        pending.resolve({ success: false, error: 'native host disconnected' });
      }
      pendingPortMessages.clear();

      // Update banner status
      void chrome.storage.local.set({ nativeHostConnected: false });

      // Reconnect after a delay
      setTimeout(connectNativePort, 5000);
    });
  } catch (e) {
    console.warn('[apitap] connectNativePort failed:', e);
    bridgeAvailable = false;
    nativePort = null;
  }
}

// Send a message to the native host and wait for response
function sendNativePortMessage(message: any, timeout = 30_000): Promise<any> {
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
  // Send each skill individually to avoid giant batch messages timing out
  const paths: string[] = [];
  for (const skill of skills) {
    const timeout = Math.max(30_000, Math.ceil(skill.skillJson.length / 50_000) * 5_000);
    const result = await sendNativePortMessage({
      action: 'save_skill',
      domain: skill.domain,
      skillJson: skill.skillJson,
    }, timeout);
    if (result.success && result.path) paths.push(result.path);
    else if (!result.success) console.warn('[apitap] save_skill failed for', skill.domain, ':', result.error);
  }
  return { success: paths.length > 0, paths };
}

// --- Agent-initiated capture ---

import { isApproved, addApprovedDomain } from './consent.js';

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

// Handle notification click → Allow
chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('consent-')) return;
  const domain = notifId.replace('consent-', '');

  const pending = pendingConsent.get(domain);
  if (pending) {
    clearTimeout(pending.timer);
    pendingConsent.delete(domain);
    chrome.notifications.clear(notifId);
    pending.resolve(true);
  }
});

// Handle notification closed without clicking → Deny
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

async function findOrOpenTab(domain: string): Promise<chrome.tabs.Tab> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: `*://${domain}/*` }, (tabs) => {
      // Filter out phantom tabs (about:blank, chrome://)
      const valid = tabs.filter(t => t.url && t.url !== 'about:blank' && !t.url.startsWith('chrome://'));
      if (valid.length > 0) {
        const active = valid.find(t => t.active) ?? valid[0];
        resolve(active);
      } else {
        chrome.tabs.create({ url: `https://${domain}`, active: false }, (tab) => {
          resolve(tab);
        });
      }
    });
  });
}

// Like findOrOpenTab but NEVER creates a tab — used by auto-learn to avoid phantom tabs
function findExistingTab(domain: string): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: `*://${domain}/*` }, (tabs) => {
      const valid = tabs.filter(t => t.url && t.url !== 'about:blank' && !t.url.startsWith('chrome://'));
      if (valid.length > 0) {
        resolve(valid.find(t => t.active) ?? valid[0]);
      } else {
        resolve(null);
      }
    });
  });
}

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
    let plateauInterval: ReturnType<typeof setInterval> | null = null;

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
    plateauInterval = setInterval(checkPlateau, 1000);

    // Attach debugger and start capture
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (plateauInterval) clearInterval(plateauInterval);
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

function isValidDomain(domain: string): boolean {
  try {
    const u = new URL(`https://${domain}`);
    return u.hostname === domain && !domain.includes('/') && !domain.includes('\\');
  } catch { return false; }
}

async function handleAgentCapture(request: AgentRequest): Promise<AgentResponse> {
  const { domain } = request;

  if (!domain) {
    return { success: false, error: 'missing_domain' };
  }

  if (!isValidDomain(domain)) {
    return { success: false, error: 'invalid_domain' };
  }

  // Don't start a capture if one is already active
  if (state.active) {
    return { success: false, error: 'capture_in_progress' };
  }

  // Check per-site consent
  const approved = await isApproved(domain);
  if (!approved) {
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

// --- State ---

let state: CaptureState = {
  active: false,
  tabId: null,
  domain: null,
  requestCount: 0,
  endpointCount: 0,
  authDetected: null,
  bridgeConnected: false,
  autoSaved: null,
};

let generators = new DomainGeneratorMap();
let lastSkillJson: string | null = null;
let allSkillFiles: string[] = [];
let capturedDomains: string[] = [];
let captureTimeout: ReturnType<typeof setTimeout> | null = null;

const MAX_CAPTURE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BODY_SIZE = 512 * 1024; // 512KB

// Pending requests: requestId → partial data
interface PendingRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}

interface PendingResponse {
  status: number;
  headers: Record<string, string>;
  contentType: string;
}

const pendingRequests = new Map<string, PendingRequest>();
const pendingResponses = new Map<string, PendingResponse>();

// --- CDP Event Handling ---

function headersToRecord(headers: Array<{ name: string; value: string }> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const { name, value } of headers) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

function detectAuth(headers: Record<string, string>): void {
  if (state.authDetected) return;

  const authHeader = headers['authorization'];
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      state.authDetected = { type: 'Bearer', header: 'Authorization' };
    } else if (authHeader.startsWith('Basic ')) {
      state.authDetected = { type: 'Basic', header: 'Authorization' };
    } else {
      state.authDetected = { type: 'Other', header: 'Authorization' };
    }
    return;
  }

  const apiKey = headers['x-api-key'];
  if (apiKey) {
    state.authDetected = { type: 'API Key', header: 'x-api-key' };
  }
}

// CDP event listener — attached when capture starts
function onCdpEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, any>,
) {
  if (!params || source.tabId !== state.tabId) return;

  if (method === 'Network.requestWillBeSent') {
    const { requestId, request } = params;
    const reqHeaders = headersToRecord(request.headers ? Object.entries(request.headers).map(([name, value]) => ({ name, value: value as string })) : []);

    pendingRequests.set(requestId, {
      url: request.url,
      method: request.method,
      headers: reqHeaders,
      postData: request.postData,
    });

    detectAuth(reqHeaders);
  }

  if (method === 'Network.responseReceived') {
    const { requestId, response } = params;
    const respHeaders = headersToRecord(response.headers ? Object.entries(response.headers).map(([name, value]) => ({ name, value: value as string })) : []);

    pendingResponses.set(requestId, {
      status: response.status,
      headers: respHeaders,
      contentType: response.mimeType || respHeaders['content-type'] || '',
    });
  }

  if (method === 'Network.loadingFinished') {
    const { requestId } = params;
    const req = pendingRequests.get(requestId);
    const resp = pendingResponses.get(requestId);
    if (!req || !resp) {
      pendingRequests.delete(requestId);
      pendingResponses.delete(requestId);
      return;
    }

    state.requestCount++;

    // Block non-http(s) schemes, internal URLs, and dev tooling noise
    if (!isAllowedUrl(req.url)) {
      pendingRequests.delete(requestId);
      pendingResponses.delete(requestId);
      return;
    }

    // Filter: only capture JSON API responses
    if (!shouldCapture({ url: req.url, status: resp.status, contentType: resp.contentType })) {
      const filteredDomain = extractDomain(req.url);
      if (filteredDomain) generators.getOrCreate(filteredDomain).recordFiltered();
      pendingRequests.delete(requestId);
      pendingResponses.delete(requestId);
      broadcastState();
      return;
    }

    // Fetch the response body via CDP
    chrome.debugger.sendCommand(
      { tabId: state.tabId! },
      'Network.getResponseBody',
      { requestId },
      (result) => {
        pendingRequests.delete(requestId);
        pendingResponses.delete(requestId);

        if (chrome.runtime.lastError || !result) return;

        let body: string;
        try {
          body = (result as any).base64Encoded
            ? atob((result as any).body)
            : (result as any).body;
        } catch {
          // Invalid base64 — skip this response
          return;
        }

        // Cap response body size to prevent memory bloat
        if (body.length > MAX_BODY_SIZE) {
          body = body.slice(0, MAX_BODY_SIZE);
        }

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
            contentType: resp.contentType,
          },
          timestamp: new Date().toISOString(),
        };

        const reqDomain = extractDomain(req.url);
        if (reqDomain) {
          capturedDomains.push(reqDomain);
          state.domain = pickPrimaryDomain(capturedDomains);

          const gen = generators.getOrCreate(reqDomain);
          const endpoint = gen.addExchange(exchange);
          if (endpoint) {
            state.endpointCount = generators.totalEndpoints;
          }
        }

        broadcastState();
      },
    );
  }
}

// --- Broadcast state to popup ---

function broadcastState() {
  const response: CaptureResponse = { type: 'STATE_UPDATE', state: { ...state } };
  chrome.runtime.sendMessage(response).catch(() => {
    // Popup not open — that's fine
  });
  persistState();
}

function persistState() {
  chrome.storage.session.set({
    captureState: state,
    lastSkillJson,
  });
}

// Restore state on service worker startup
chrome.storage.session.get(['captureState', 'lastSkillJson'], (result) => {
  if (result.captureState) state = result.captureState;
  if (result.lastSkillJson) lastSkillJson = result.lastSkillJson;
});

// --- Passive Index state ---

let passiveIndex: IndexFile = createEmptyIndex();
let indexDirty = false; // tracks whether index has unsaved changes

// --- Excluded domains (cached in memory, synced from chrome.storage.local) ---
let excludedDomains: Set<string> = new Set();

chrome.storage.local.get(['excludedDomains'], (result) => {
  excludedDomains = new Set(result.excludedDomains ?? []);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.excludedDomains) {
    excludedDomains = new Set(changes.excludedDomains.newValue ?? []);
  }
});

// Pending auth types for auth detection (store only type, never raw header values)
const pendingObserverAuthTypes = new Map<string, string | undefined>();
// Pending auth tokens for auth capture (raw header+value, stored in session storage)
const pendingObserverAuthTokens = new Map<string, Array<{ header: string; value: string }>>();

// Load index from chrome.storage.local on startup
chrome.storage.local.get(['passiveIndex'], (result) => {
  if (result.passiveIndex) {
    passiveIndex = result.passiveIndex;
  }
});

// --- webRequest listeners for passive indexing ---

// Capture request headers (for auth detection) — fires before request is sent
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore non-tab requests
    const headers: Record<string, string> = {};
    for (const h of details.requestHeaders ?? []) {
      if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
    }
    const reqId = String(details.requestId);
    pendingObserverAuthTypes.set(reqId, detectAuthType(headers));
    const tokens = extractAuthTokens(headers);
    if (tokens.length > 0) pendingObserverAuthTokens.set(reqId, tokens);
    // Clean up if maps grow too large (prevent memory leak)
    if (pendingObserverAuthTypes.size > 1000) {
      const keys = [...pendingObserverAuthTypes.keys()];
      for (const k of keys.slice(0, 500)) {
        pendingObserverAuthTypes.delete(k);
        pendingObserverAuthTokens.delete(k);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'],
);

// Process completed requests — this is the main observation point
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore non-tab requests

    // Check exclusion list
    try {
      const urlDomain = new URL(details.url).hostname;
      if (excludedDomains.has(urlDomain)) return;
    } catch { /* invalid URL, let observer filter it */ }

    const reqId = String(details.requestId);
    const authTypeOverride = pendingObserverAuthTypes.get(reqId);
    const authTokensOverride = pendingObserverAuthTokens.get(reqId);
    pendingObserverAuthTypes.delete(reqId);
    pendingObserverAuthTokens.delete(reqId);

    // Build response headers record
    const responseHeaders: Record<string, string> = {};
    for (const h of details.responseHeaders ?? []) {
      if (h.name && h.value) responseHeaders[h.name.toLowerCase()] = h.value;
    }

    const contentType = responseHeaders['content-type'] ?? '';

    const obs = processCompletedRequest({
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      responseContentType: contentType,
      requestHeaders: {},
      responseHeaders,
      authTypeOverride,
      authTokensOverride,
    });

    if (obs) {
      passiveIndex = mergeObservation(passiveIndex, obs);
      indexDirty = true;

      // Store auth tokens encrypted in session storage (cleared on browser close)
      if (obs.authTokens && obs.authTokens.length > 0) {
        void storeAuthTokens(obs.domain, obs.authTokens);
      }

      // Auto-learn check
      void checkAutoLearn(obs.domain);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'],
);

// --- Index flush scheduling ---

const INDEX_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function flushIndex(): Promise<void> {
  if (!indexDirty) return;

  // Apply lifecycle rules before flushing
  const { index: cleaned } = applyLifecycle(passiveIndex);
  passiveIndex = cleaned;

  // Persist to chrome.storage.local first (survives service worker restart)
  await chrome.storage.local.set({ passiveIndex });
  indexDirty = false;

  // Send to native host for disk persistence (if bridge connected)
  if (nativePort && bridgeAvailable) {
    try {
      await sendNativePortMessage({
        action: 'save_index',
        indexJson: JSON.stringify(passiveIndex),
      }, 15_000);
    } catch {
      // Native host not available — index stays in chrome.storage.local
    }
  }
}

// Periodic flush timer
setInterval(flushIndex, INDEX_FLUSH_INTERVAL_MS);

// Flush on tab close
chrome.tabs.onRemoved.addListener(() => {
  void flushIndex();
});

// Best-effort flush on service worker suspend (MV3)
chrome.runtime.onSuspend.addListener(() => {
  // Synchronous chrome.storage.local.set as last resort
  chrome.storage.local.set({ passiveIndex });
});

// --- Auth token session storage ---
// Auth tokens are encrypted with AES-256-GCM before storing in chrome.storage.session.
// Key is per-session (generated on first use, cleared on browser close).
// Provides defense-in-depth against memory dumps or co-resident extensions.

async function storeAuthTokens(domain: string, newTokens: Array<{ header: string; value: string }>): Promise<void> {
  const result = await chrome.storage.session.get(['authTokens']);
  const store: Record<string, string> = result.authTokens ?? {};

  // Decrypt existing tokens for this domain to merge
  let existing: Array<{ header: string; value: string }> = [];
  if (store[domain]) {
    try {
      existing = JSON.parse(await decrypt(store[domain]));
    } catch {
      existing = []; // Key rotated or corrupt — start fresh
    }
  }

  // Merge: update existing headers, add new ones
  for (const t of newTokens) {
    const idx = existing.findIndex(e => e.header === t.header);
    if (idx >= 0) {
      existing[idx] = t; // update value
    } else {
      existing.push(t);
    }
  }

  // Encrypt and store
  store[domain] = await encrypt(JSON.stringify(existing));
  await chrome.storage.session.set({ authTokens: store });
}

async function getAuthTokens(domain: string): Promise<Array<{ header: string; value: string }>> {
  const result = await chrome.storage.session.get(['authTokens']);
  const store: Record<string, string> = result.authTokens ?? {};
  if (!store[domain]) return [];
  try {
    return JSON.parse(await decrypt(store[domain]));
  } catch {
    return []; // Key rotated or corrupt
  }
}

// --- Skeleton skill file generation (v1.5.1) ---

function generateSkeletonSkillFile(entry: IndexEntry): Record<string, unknown> {
  // Deduplicate by method+parameterizedPath
  const seen = new Set<string>();
  const endpoints: Array<Record<string, string>> = [];
  for (const ep of entry.endpoints) {
    for (const method of ep.methods) {
      const key = `${method} ${ep.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({
        method,
        path: ep.path,
        parameterizedPath: ep.path,
        queryParams: '{}',
      });
    }
  }
  return {
    version: 2,
    domain: entry.domain,
    provenance: 'passive-index',
    capturedAt: entry.firstSeen,
    endpoints: endpoints.map(ep => ({
      method: ep.method,
      path: ep.path,
      parameterizedPath: ep.parameterizedPath,
      queryParams: {},
    })),
  };
}

// --- Auto-learn ---

let autoLearnInProgress = false;

async function checkAutoLearn(domain: string): Promise<void> {
  if (autoLearnInProgress) return;  // prevent concurrent auto-learn captures

  // v1.5.1: check autoLearnEnabled flag (default true)
  const settings = await chrome.storage.local.get(['autoLearn', 'autoLearnEnabled', 'revisitThreshold']);
  if (!settings.autoLearn) return;
  if (settings.autoLearnEnabled === false) return;

  const threshold = Math.max(2, Math.min(20, settings.revisitThreshold ?? 3));
  const entry = passiveIndex.entries.find(e => e.domain === domain);
  if (!entry || entry.promoted) return;

  // v1.5.1: 30-minute backoff between auto-learn attempts
  if (entry.lastAutoLearnAttempt && Date.now() - entry.lastAutoLearnAttempt < 30 * 60 * 1000) return;

  // Use totalHits as a proxy for revisit frequency
  if (entry.totalHits >= threshold && !state.active) {
    // Record attempt timestamp before trying
    entry.lastAutoLearnAttempt = Date.now();
    indexDirty = true;

    autoLearnInProgress = true;
    try {
      // Only attempt CDP capture if a tab for this domain is already open.
      // NEVER open new tabs for auto-learn — causes phantom tabs for CDN/tracker domains.
      const existingTab = await findExistingTab(domain);
      let skillFiles: string[] = [];

      if (existingTab?.id) {
        skillFiles = await captureWithPlateau(existingTab.id, {
          idleTimeout: 10_000,
          maxDuration: 120_000,
        });
      }

      if (skillFiles.length > 0 && bridgeAvailable && nativePort) {
        const skills = skillFiles.map(json => {
          const parsed = JSON.parse(json);
          return { domain: parsed.domain, skillJson: json };
        });
        await saveViaBridge(skills);
        // Save stored auth tokens to native host encrypted storage
        const tokens = await getAuthTokens(domain);
        if (tokens.length > 0) {
          await sendNativePortMessage({
            action: 'save_auth',
            domain,
            headers: tokens,
          });
        }
        passiveIndex = markPromoted(passiveIndex, domain, 'extension');
        indexDirty = true;
        await flushIndex();
      } else {
        // No existing tab or CDP capture failed — generate skeleton skill file from index
        if (bridgeAvailable && nativePort && entry.endpoints.length > 0) {
          const skeleton = generateSkeletonSkillFile(entry);
          const skeletonJson = JSON.stringify(skeleton);
          await saveViaBridge([{ domain, skillJson: skeletonJson }]);
          // Save stored auth tokens
          const tokens = await getAuthTokens(domain);
          if (tokens.length > 0) {
            await sendNativePortMessage({
              action: 'save_auth',
              domain,
              headers: tokens,
            });
          }
          passiveIndex = markPromoted(passiveIndex, domain, 'extension');
          indexDirty = true;
          await flushIndex();
        }
      }
    } finally {
      autoLearnInProgress = false;
    }
  }
}

// --- Start / Stop ---

function startCapture(tabId: number) {
  generators = new DomainGeneratorMap();
  lastSkillJson = null;
  allSkillFiles = [];
  capturedDomains = [];
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

  // Safety timeout — auto-stop capture after 10 minutes
  captureTimeout = setTimeout(() => {
    void stopCapture();
  }, MAX_CAPTURE_MS);

  chrome.debugger.attach({ tabId }, '1.3', () => {
    if (chrome.runtime.lastError) {
      state.active = false;
      state.tabId = null;
      if (captureTimeout) { clearTimeout(captureTimeout); captureTimeout = null; }
      broadcastState();
      return;
    }

    chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, () => {
      chrome.debugger.onEvent.addListener(onCdpEvent);
      broadcastState();
    });
  });
}

async function stopCapture() {
  if (!state.active || state.tabId === null) return;
  state.active = false; // prevent re-entry while async saves run

  // Clear capture timeout
  if (captureTimeout) {
    clearTimeout(captureTimeout);
    captureTimeout = null;
  }

  chrome.debugger.onEvent.removeListener(onCdpEvent);
  chrome.debugger.detach({ tabId: state.tabId }, () => {
    if (chrome.runtime.lastError) {
      // Tab may already be closed
    }
  });

  // Generate skill files — one per domain, primary domain is the most frequent
  const primaryDomain = pickPrimaryDomain(capturedDomains);
  if (primaryDomain && generators.domains.length > 0) {
    state.domain = primaryDomain;
    const skills = generators.toSkillFiles(state.requestCount);
    allSkillFiles = skills.map(s => scrubAuthFromSkillJson(JSON.stringify(s)));
    // Primary domain's skill file is the default for download
    const primarySkill = skills.find(s => s.domain === primaryDomain);
    lastSkillJson = primarySkill
      ? scrubAuthFromSkillJson(JSON.stringify(primarySkill))
      : allSkillFiles[0] ?? null;
  }

  // Auto-save via native messaging if bridge is available
  state.autoSaved = null;
  const capturedSkills = allSkillFiles.map(json => {
    const parsed = JSON.parse(json);
    return { domain: parsed.domain, skillJson: json };
  });

  if (bridgeAvailable && capturedSkills.length > 0) {
    const result = await saveViaBridge(capturedSkills);
    if (result.success) {
      state.autoSaved = result.paths ?? capturedSkills.map(s => s.domain);
    }
  }

  // Save auth tokens — runs even if skill save failed (auth is small)
  if (bridgeAvailable) {
    const domains = new Set(capturedSkills.map(s => s.domain));
    for (const domain of domains) {
      const tokens = await getAuthTokens(domain);
      if (tokens.length > 0) {
        await sendNativePortMessage({
          action: 'save_auth',
          domain,
          headers: tokens,
        });
      }
    }
  }

  state.tabId = null;

  // Clear sensitive data (auth headers, POST bodies)
  pendingRequests.clear();
  pendingResponses.clear();
  generators.clear();
  capturedDomains = [];

  broadcastState();
}

// --- Handle debugger detach (user dismissed infobar) ---

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === state.tabId) {
    state.active = false;
    state.tabId = null;
    pendingRequests.clear();
    pendingResponses.clear();
    broadcastState();
  }
});

// --- Message handling from popup ---

chrome.runtime.onMessage.addListener(
  (message: CaptureMessage, sender, sendResponse) => {
    // Only accept messages from this extension's own pages
    if (sender.id !== chrome.runtime.id) return;
    switch (message.type) {
      case 'START_CAPTURE': {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          if (!tab?.id || !tab.url || tab.url === 'about:blank' || tab.url.startsWith('chrome://')) {
            sendResponse({ type: 'ERROR', error: 'No active tab' } as CaptureResponse);
            return;
          }
          try {
            startCapture(tab.id);
            sendResponse({ type: 'STATE_UPDATE', state: { ...state } } as CaptureResponse);
          } catch (err) {
            sendResponse({ type: 'ERROR', error: String(err) } as CaptureResponse);
          }
        });
        return true; // async sendResponse
      }

      case 'STOP_CAPTURE': {
        stopCapture().then(() => {
          sendResponse({
            type: 'CAPTURE_COMPLETE',
            state: { ...state },
            skillJson: lastSkillJson ?? undefined,
          } as CaptureResponse);
        });
        return true; // async sendResponse
      }

      case 'GET_STATE': {
        sendResponse({ type: 'STATE_UPDATE', state: { ...state } } as CaptureResponse);
        break;
      }

      case 'DOWNLOAD_SKILL': {
        if (lastSkillJson) {
          // Download from background — popup blob URLs die when popup closes
          const skill = JSON.parse(lastSkillJson);
          const filename = `${skill.domain || 'skill'}.json`;
          const bytes = new TextEncoder().encode(lastSkillJson);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const dataUrl = 'data:application/json;base64,' + btoa(binary);
          chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, () => {
            sendResponse({ type: 'CAPTURE_COMPLETE', skillJson: lastSkillJson! } as CaptureResponse);
          });
          return true; // async sendResponse
        } else {
          sendResponse({ type: 'ERROR', error: 'No skill file available' } as CaptureResponse);
        }
        break;
      }

      case 'PROMOTE_DOMAIN': {
        const promoteDomain = message.domain;
        if (!promoteDomain || !isValidDomain(promoteDomain)) {
          sendResponse({ type: 'ERROR', error: 'Invalid domain' } as CaptureResponse);
          break;
        }
        if (state.active) {
          sendResponse({ type: 'ERROR', error: 'Capture already in progress' } as CaptureResponse);
          break;
        }

        findOrOpenTab(promoteDomain).then(async (tab) => {
          if (!tab.id) {
            sendResponse({ type: 'ERROR', error: 'No tab available' } as CaptureResponse);
            return;
          }

          const skillFiles = await captureWithPlateau(tab.id, {
            idleTimeout: 10_000,
            maxDuration: 120_000,
          });

          if (skillFiles.length > 0) {
            // Save via bridge
            if (bridgeAvailable && nativePort) {
              const skills = skillFiles.map(json => {
                const parsed = JSON.parse(json);
                return { domain: parsed.domain, skillJson: json };
              });
              await saveViaBridge(skills);

              // Save stored auth tokens to native host encrypted storage
              const tokens = await getAuthTokens(promoteDomain);
              if (tokens.length > 0) {
                await sendNativePortMessage({
                  action: 'save_auth',
                  domain: promoteDomain,
                  headers: tokens,
                });
              }
            }

            // Mark promoted in index
            passiveIndex = markPromoted(passiveIndex, promoteDomain, 'extension');
            indexDirty = true;
            await flushIndex();
          }

          sendResponse({
            type: 'CAPTURE_COMPLETE',
            state: { ...state },
            skillJson: lastSkillJson ?? undefined,
          } as CaptureResponse);
        });
        return true; // async sendResponse
      }

      case 'GET_INDEX': {
        sendResponse({ type: 'STATE_UPDATE', index: passiveIndex } as any);
        break;
      }
    }
  },
);

// Connect to native messaging host on startup and ping
connectNativePort();
state.bridgeConnected = bridgeAvailable;
persistState();

// Ping native host and store connection status for popup banner
(async () => {
  const connected = await checkBridge();
  await chrome.storage.local.set({ nativeHostConnected: connected });
})();

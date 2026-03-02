// Import Buffer shim first — provides globalThis.Buffer for entropy.ts / oauth-detector.ts
import './shim.js';

import { shouldCapture } from '../../src/capture/filter.js';
import type { CapturedExchange } from '../../src/types.js';
import type { CaptureState, CaptureMessage, CaptureResponse } from './types.js';
import { extractDomain, pickPrimaryDomain } from './domain-utils.js';
import { DomainGeneratorMap } from './multi-domain.js';
import { isAllowedUrl, scrubAuthFromSkillJson } from './security.js';

// --- Native messaging bridge ---

const NATIVE_HOST = 'com.apitap.native';

let bridgeAvailable = false;

async function checkBridge(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          bridgeAvailable = false;
          resolve(false);
          return;
        }
        bridgeAvailable = true;
        resolve(true);
      });
    } catch {
      bridgeAvailable = false;
      resolve(false);
    }
  });
}

async function saveViaBridge(skills: Array<{ domain: string; skillJson: string }>): Promise<{ success: boolean; paths?: string[]; error?: string }> {
  if (skills.length === 1) {
    return new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        action: 'save_skill',
        domain: skills[0].domain,
        skillJson: skills[0].skillJson,
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      action: 'save_batch',
      skills,
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
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
  if (bridgeAvailable && allSkillFiles.length > 0) {
    const skills = allSkillFiles.map(json => {
      const parsed = JSON.parse(json);
      return { domain: parsed.domain, skillJson: json };
    });

    const result = await saveViaBridge(skills);
    if (result.success) {
      state.autoSaved = result.paths ?? skills.map(s => s.domain);
    }
  }

  state.active = false;
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
    switch (message.type) {
      case 'START_CAPTURE': {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          if (!tab?.id || !tab.url) {
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
          const dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(lastSkillJson)));
          chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, () => {
            sendResponse({ type: 'CAPTURE_COMPLETE', skillJson: lastSkillJson! } as CaptureResponse);
          });
          return true; // async sendResponse
        } else {
          sendResponse({ type: 'ERROR', error: 'No skill file available' } as CaptureResponse);
        }
        break;
      }
    }
  },
);

// Check if native messaging bridge is available on startup
checkBridge().then(() => {
  state.bridgeConnected = bridgeAvailable;
  persistState();
});

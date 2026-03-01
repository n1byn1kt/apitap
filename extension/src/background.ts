// Import Buffer shim first — provides globalThis.Buffer for entropy.ts / oauth-detector.ts
import './shim.js';

import { SkillGenerator } from '../../src/skill/generator.js';
import { shouldCapture } from '../../src/capture/filter.js';
import type { CapturedExchange } from '../../src/types.js';
import type { CaptureState, CaptureMessage, CaptureResponse } from './types.js';

// --- State ---

let state: CaptureState = {
  active: false,
  tabId: null,
  domain: null,
  requestCount: 0,
  endpointCount: 0,
  authDetected: null,
};

let generator: SkillGenerator | null = null;
let lastSkillJson: string | null = null;

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

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

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

    // Filter: only capture JSON API responses
    if (!shouldCapture({ url: req.url, status: resp.status, contentType: resp.contentType })) {
      generator?.recordFiltered();
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

        const body = (result as any).base64Encoded
          ? atob((result as any).body)
          : (result as any).body;

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

        const endpoint = generator?.addExchange(exchange);
        if (endpoint) {
          state.endpointCount = generator!.endpointCount;
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
}

// --- Start / Stop ---

function startCapture(tabId: number, url: string) {
  const domain = extractDomain(url);
  if (!domain) throw new Error(`Invalid URL: ${url}`);

  generator = new SkillGenerator();
  lastSkillJson = null;
  state = {
    active: true,
    tabId,
    domain,
    requestCount: 0,
    endpointCount: 0,
    authDetected: null,
  };
  pendingRequests.clear();
  pendingResponses.clear();

  chrome.debugger.attach({ tabId }, '1.3', () => {
    if (chrome.runtime.lastError) {
      state.active = false;
      state.tabId = null;
      broadcastState();
      return;
    }

    chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, () => {
      chrome.debugger.onEvent.addListener(onCdpEvent);
      broadcastState();
    });
  });
}

function stopCapture() {
  if (!state.active || state.tabId === null) return;

  chrome.debugger.onEvent.removeListener(onCdpEvent);
  chrome.debugger.detach({ tabId: state.tabId }, () => {
    if (chrome.runtime.lastError) {
      // Tab may already be closed
    }
  });

  // Generate skill file
  if (generator && state.domain) {
    const skillFile = generator.toSkillFile(state.domain, {
      totalRequests: state.requestCount,
    });
    lastSkillJson = JSON.stringify(skillFile, null, 2);
  }

  state.active = false;
  state.tabId = null;
  pendingRequests.clear();
  pendingResponses.clear();

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
            startCapture(tab.id, tab.url);
            sendResponse({ type: 'STATE_UPDATE', state: { ...state } } as CaptureResponse);
          } catch (err) {
            sendResponse({ type: 'ERROR', error: String(err) } as CaptureResponse);
          }
        });
        return true; // async sendResponse
      }

      case 'STOP_CAPTURE': {
        stopCapture();
        sendResponse({
          type: 'CAPTURE_COMPLETE',
          state: { ...state },
          skillJson: lastSkillJson ?? undefined,
        } as CaptureResponse);
        break;
      }

      case 'GET_STATE': {
        sendResponse({ type: 'STATE_UPDATE', state: { ...state } } as CaptureResponse);
        break;
      }

      case 'DOWNLOAD_SKILL': {
        if (lastSkillJson) {
          sendResponse({
            type: 'CAPTURE_COMPLETE',
            skillJson: lastSkillJson,
          } as CaptureResponse);
        } else {
          sendResponse({ type: 'ERROR', error: 'No skill file available' } as CaptureResponse);
        }
        break;
      }
    }
  },
);

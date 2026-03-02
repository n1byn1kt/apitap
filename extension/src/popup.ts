import type { CaptureMessage, CaptureResponse, CaptureState } from './types.js';

// --- DOM Elements ---

const statusEl = document.getElementById('status')!;
const statsEl = document.getElementById('stats')!;
const endpointCountEl = document.getElementById('endpoint-count')!;
const requestCountEl = document.getElementById('request-count')!;
const authStatusEl = document.getElementById('auth-status')!;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const exportEl = document.getElementById('export')!;
const endpointListEl = document.getElementById('endpoint-list')!;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
const saveStatusEl = document.getElementById('save-status')!;

let lastSkillJson: string | null = null;

// --- UI Updates ---

function updateUI(state: CaptureState) {
  if (state.active) {
    statusEl.textContent = `Recording ${state.domain ?? ''}`;
    statusEl.className = 'recording';
    statsEl.hidden = false;
    btnStart.hidden = true;
    btnStop.hidden = false;
    exportEl.hidden = true;
  } else {
    statusEl.textContent = lastSkillJson ? 'Capture complete' : 'Ready';
    statusEl.className = '';
    btnStart.hidden = false;
    btnStop.hidden = true;
    if (lastSkillJson) {
      exportEl.hidden = false;
    }
  }

  endpointCountEl.textContent = String(state.endpointCount);
  requestCountEl.textContent = String(state.requestCount);

  if (state.authDetected) {
    authStatusEl.textContent = `Auth: ${state.authDetected.type} (${state.authDetected.header})`;
  } else {
    authStatusEl.textContent = '';
  }

  // Save status
  if (state.autoSaved) {
    saveStatusEl.hidden = false;
    saveStatusEl.className = 'success';
    saveStatusEl.textContent = `Auto-saved to ~/.apitap/skills/ (${state.autoSaved.length} file${state.autoSaved.length > 1 ? 's' : ''})`;
    btnDownload.textContent = 'Download copy';
  } else if (!state.active && lastSkillJson && !state.bridgeConnected) {
    saveStatusEl.hidden = false;
    saveStatusEl.className = 'fallback';
    saveStatusEl.textContent = 'CLI not connected. Run: apitap extension install';
  } else {
    saveStatusEl.hidden = true;
  }
}

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function renderEndpoints(skillJson: string) {
  endpointListEl.textContent = '';
  try {
    const skill = JSON.parse(skillJson);
    if (!Array.isArray(skill.endpoints)) return;
    for (const ep of skill.endpoints) {
      if (typeof ep.method !== 'string' || typeof ep.path !== 'string') continue;
      const div = document.createElement('div');
      div.className = 'endpoint';
      const method = document.createElement('span');
      method.className = VALID_METHODS.has(ep.method) ? `method ${ep.method}` : 'method';
      method.textContent = ep.method;
      div.appendChild(method);
      div.appendChild(document.createTextNode(` ${ep.path}`));
      endpointListEl.appendChild(div);
    }
  } catch {
    endpointListEl.textContent = 'Error parsing skill data';
  }
}

// --- Message Helpers ---

function sendMessage(msg: CaptureMessage): Promise<CaptureResponse> {
  return chrome.runtime.sendMessage(msg);
}

// --- Event Handlers ---

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  const response = await sendMessage({ type: 'START_CAPTURE' });
  btnStart.disabled = false;
  if (response.type === 'ERROR') {
    statusEl.textContent = response.error ?? 'Error';
    return;
  }
  if (response.state) updateUI(response.state);
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  const response = await sendMessage({ type: 'STOP_CAPTURE' });
  btnStop.disabled = false;
  if (response.skillJson) {
    lastSkillJson = response.skillJson;
    renderEndpoints(response.skillJson);
  }
  if (response.state) updateUI(response.state);
});

btnDownload.addEventListener('click', async () => {
  if (!lastSkillJson) return;
  // Download happens in background service worker (popup blob URLs die when popup closes)
  await sendMessage({ type: 'DOWNLOAD_SKILL' });
});

// --- Listen for state broadcasts from background ---

chrome.runtime.onMessage.addListener((message: CaptureResponse) => {
  if (message.type === 'STATE_UPDATE' && message.state) {
    updateUI(message.state);
  }
});

// --- Init: restore state from session storage, then sync with background ---

(async () => {
  // Restore skill JSON from session storage (survives popup close/reopen)
  const stored = await chrome.storage.session.get(['lastSkillJson']);
  if (stored.lastSkillJson) {
    lastSkillJson = stored.lastSkillJson;
    renderEndpoints(stored.lastSkillJson);
  }

  // Get live state from background service worker
  const response = await sendMessage({ type: 'GET_STATE' });
  if (response.state) updateUI(response.state);
})();

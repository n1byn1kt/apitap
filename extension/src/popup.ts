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

// --- Tab switching ---

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    tab.classList.add('active');
    const target = tab.getAttribute('data-tab')!;
    document.getElementById('tab-' + target)!.classList.remove('hidden');
    if (target === 'index') loadIndex();
  });
});

// --- Index tab ---

function loadIndex() {
  chrome.runtime.sendMessage({ type: 'GET_INDEX' }, (response: any) => {
    const index = response?.index;
    const list = document.getElementById('index-list')!;
    const empty = document.getElementById('index-empty')!;

    // Clear previous entries
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!index || index.entries.length === 0) {
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    // Sort by totalHits descending
    const sorted = [...index.entries].sort((a: any, b: any) => b.totalHits - a.totalHits);

    for (const entry of sorted) {
      const card = document.createElement('div');
      card.className = 'index-entry';

      const header = document.createElement('div');
      header.className = 'index-header';
      const domainEl = document.createElement('strong');
      domainEl.textContent = entry.domain;
      const hitsEl = document.createElement('span');
      hitsEl.className = 'hit-count';
      hitsEl.textContent = entry.totalHits + ' hits';
      header.appendChild(domainEl);
      header.appendChild(hitsEl);

      const meta = document.createElement('div');
      meta.className = 'index-meta';
      const authBadge = entry.endpoints.find((ep: any) => ep.authType)?.authType ?? '';
      meta.textContent = entry.endpoints.length + ' endpoints' + (authBadge ? ' | ' + authBadge : '');

      const actions = document.createElement('div');
      actions.className = 'index-actions';
      if (entry.promoted) {
        const badge = document.createElement('span');
        badge.className = 'badge promoted';
        badge.textContent = 'Skill file exists';
        actions.appendChild(badge);
      } else {
        const btn = document.createElement('button');
        btn.className = 'btn-promote';
        btn.textContent = 'Generate skill file';
        btn.addEventListener('click', () => {
          btn.textContent = 'Capturing...';
          btn.disabled = true;
          chrome.runtime.sendMessage({ type: 'PROMOTE_DOMAIN', domain: entry.domain });
        });
        actions.appendChild(btn);
      }

      card.appendChild(header);
      card.appendChild(meta);
      card.appendChild(actions);
      list.appendChild(card);
    }
  });
}

// --- Auto-learn toggle in Capture tab ---

const autolearnCaptureToggle = document.getElementById('autolearn-capture-toggle') as HTMLInputElement;

chrome.storage.local.get(['autoLearnEnabled'], (result) => {
  autolearnCaptureToggle.checked = result.autoLearnEnabled !== false; // default true
});

autolearnCaptureToggle.addEventListener('change', (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  chrome.storage.local.set({ autoLearnEnabled: enabled });
});

// --- Settings tab ---

chrome.storage.local.get(['autoLearn', 'revisitThreshold'], (result) => {
  (document.getElementById('auto-learn-toggle') as HTMLInputElement).checked = result.autoLearn ?? false;
  (document.getElementById('revisit-threshold') as HTMLInputElement).value = String(result.revisitThreshold ?? 3);
});

document.getElementById('auto-learn-toggle')!.addEventListener('change', (e) => {
  chrome.storage.local.set({ autoLearn: (e.target as HTMLInputElement).checked });
});
document.getElementById('revisit-threshold')!.addEventListener('change', (e) => {
  chrome.storage.local.set({ revisitThreshold: parseInt((e.target as HTMLInputElement).value, 10) });
});

// --- Exclusion list ---

function renderExcludedDomains(domains: string[]) {
  const list = document.getElementById('excluded-domains-list')!;
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const domain of domains) {
    const item = document.createElement('div');
    item.className = 'excluded-item';
    const name = document.createElement('span');
    name.textContent = domain;
    const btn = document.createElement('button');
    btn.className = 'btn-remove';
    btn.textContent = '\u00d7';
    btn.addEventListener('click', () => {
      chrome.storage.local.get(['excludedDomains'], (result) => {
        const list = (result.excludedDomains ?? []).filter((d: string) => d !== domain);
        chrome.storage.local.set({ excludedDomains: list }, () => renderExcludedDomains(list));
      });
    });
    item.appendChild(name);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

chrome.storage.local.get(['excludedDomains'], (result) => {
  renderExcludedDomains(result.excludedDomains ?? []);
});

// --- Approved-domain consent list ---

interface ApprovedDomainEntry {
  domain: string;
  approvedAt: string;
  expiresAt: string;
}

function formatTimeAgo(iso: string): string {
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return 'unknown';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function formatExpiry(iso: string): string {
  const deltaMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(deltaMs)) return 'unknown';
  if (deltaMs <= 0) return 'expired';
  const min = Math.floor(deltaMs / (60 * 1000));
  if (min < 60) return `expires in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `expires in ${hr}h`;
  const days = Math.floor(hr / 24);
  return `expires in ${days}d`;
}

function renderApprovedDomains(entries: ApprovedDomainEntry[]) {
  const list = document.getElementById('approved-domains-list')!;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'current-site-empty';
    empty.textContent = 'No active approvals.';
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'excluded-item';

    const left = document.createElement('div');
    const domain = document.createElement('div');
    domain.textContent = entry.domain;
    const meta = document.createElement('div');
    meta.className = 'index-meta';
    meta.textContent = `approved ${formatTimeAgo(entry.approvedAt)} · ${formatExpiry(entry.expiresAt)}`;
    left.appendChild(domain);
    left.appendChild(meta);

    const btn = document.createElement('button');
    btn.className = 'btn-remove';
    btn.textContent = '×';
    btn.title = 'Revoke approval';
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'REMOVE_APPROVED_DOMAIN', domain: entry.domain }, (response: any) => {
        const approved = response?.approvedDomains as ApprovedDomainEntry[] | undefined;
        renderApprovedDomains(approved ?? []);
      });
    });

    item.appendChild(left);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

chrome.runtime.sendMessage({ type: 'GET_APPROVED_DOMAINS' }, (response: any) => {
  renderApprovedDomains((response?.approvedDomains ?? []) as ApprovedDomainEntry[]);
});

document.getElementById('btn-exclude-domain')!.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.url) return;
    try {
      const domain = new URL(tab.url).hostname;
      if (!domain) return;
      chrome.storage.local.get(['excludedDomains'], (result) => {
        const list: string[] = result.excludedDomains ?? [];
        if (!list.includes(domain)) {
          list.push(domain);
          chrome.storage.local.set({ excludedDomains: list }, () => renderExcludedDomains(list));
        }
      });
    } catch { /* invalid URL */ }
  });
});

// --- Native host banner ---

chrome.storage.local.get(['nativeHostConnected', 'bannerDismissed'], (result) => {
  const banner = document.getElementById('native-banner')!;
  if (result.nativeHostConnected === false && !result.bannerDismissed) {
    banner.classList.remove('hidden');
  }
});

document.getElementById('dismiss-banner')!.addEventListener('click', () => {
  document.getElementById('native-banner')!.classList.add('hidden');
  chrome.storage.local.set({ bannerDismissed: true });
});

// --- Current site display (Capture tab) ---

function renderCurrentSite(index: any, domain: string) {
  const container = document.getElementById('current-site')!;
  container.textContent = '';

  if (!index || !domain) {
    const empty = document.createElement('div');
    empty.className = 'current-site-empty';
    empty.textContent = 'No API traffic for this site yet.';
    container.appendChild(empty);
    return;
  }

  const baseDomain = domain.replace(/^www\./, '');
  const entry = index.entries?.find((e: any) => e.domain === domain || e.domain === baseDomain);
  // Also find entries for subdomains (api.example.com when on example.com)
  const entryDomain = entry?.domain;
  const related = index.entries?.filter((e: any) =>
    e.domain !== domain && e.domain !== baseDomain &&
    (e.domain.endsWith('.' + baseDomain) || baseDomain.endsWith('.' + e.domain))
  ) ?? [];

  if (!entry && related.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'current-site-empty';
    empty.textContent = 'No API traffic for this site yet.';
    container.appendChild(empty);
    return;
  }

  const all = entry ? [entry, ...related] : related;

  for (const e of all) {
    const section = document.createElement('div');
    section.className = 'current-site-section';

    const header = document.createElement('div');
    header.className = 'current-site-domain';
    const statusIcon = e.promoted ? '\u2705 ' : '';
    header.textContent = statusIcon + e.domain;

    const meta = document.createElement('div');
    meta.className = 'current-site-meta';
    const authTypes = [...new Set(e.endpoints.map((ep: any) => ep.authType).filter(Boolean))];
    meta.textContent = e.endpoints.length + ' endpoint' + (e.endpoints.length !== 1 ? 's' : '')
      + ' \u00b7 ' + e.totalHits + ' hits'
      + (authTypes.length > 0 ? ' \u00b7 ' + authTypes.join(', ') : '')
      + (e.promoted ? ' \u00b7 skill file saved' : '');

    const epList = document.createElement('div');
    epList.className = 'current-site-endpoints';
    for (const ep of e.endpoints) {
      for (const method of (ep.methods ?? ['?'])) {
        const div = document.createElement('div');
        div.className = 'endpoint';
        const m = document.createElement('span');
        m.className = VALID_METHODS.has(method) ? 'method ' + method : 'method';
        m.textContent = method;
        div.appendChild(m);
        div.appendChild(document.createTextNode(' ' + ep.path));
        epList.appendChild(div);
      }
    }

    section.appendChild(header);
    section.appendChild(meta);
    if (e.promoted) {
      const badge = document.createElement('div');
      badge.className = 'badge promoted';
      badge.textContent = 'Skill file exists';
      section.appendChild(badge);
    }
    section.appendChild(epList);
    container.appendChild(section);
  }
}

function loadCurrentSite() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.url) return;
    let domain: string;
    try {
      domain = new URL(tab.url).hostname;
    } catch { return; }

    chrome.runtime.sendMessage({ type: 'GET_INDEX' }, (response: any) => {
      if (response?.index) {
        renderCurrentSite(response.index, domain);
      }
    });
  });
}

// --- Init: restore state from session storage, then sync with background ---

(async () => {
  // Load current site's index data
  loadCurrentSite();

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

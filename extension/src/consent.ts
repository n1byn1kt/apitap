const STORAGE_KEY = 'approvedAgentDomains';
export const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovedDomainEntry {
  domain: string;
  approvedAt: string;
  expiresAt: string;
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

interface NormalizeResult {
  entries: ApprovedDomainEntry[];
  changed: boolean;
}

function normalizeEntries(raw: unknown): NormalizeResult {
  if (!Array.isArray(raw)) {
    return { entries: [], changed: raw !== undefined };
  }

  const now = Date.now();
  const defaultApprovedAt = new Date(now).toISOString();
  const defaultExpiresAt = new Date(now + CONSENT_TTL_MS).toISOString();
  const deduped = new Map<string, ApprovedDomainEntry>();
  let changed = false;

  for (const item of raw) {
    let entry: ApprovedDomainEntry | null = null;

    // Backward compatibility: legacy format was string[]
    if (typeof item === 'string' && item.length > 0) {
      changed = true;
      entry = {
        domain: item,
        approvedAt: defaultApprovedAt,
        expiresAt: defaultExpiresAt,
      };
    } else if (item && typeof item === 'object' && typeof (item as any).domain === 'string') {
      const domain = (item as any).domain as string;
      if (domain.length === 0) {
        changed = true;
        continue;
      }
      const hasApprovedAt = isValidIsoDate((item as any).approvedAt);
      const approvedAt = hasApprovedAt
        ? (item as any).approvedAt
        : defaultApprovedAt;
      const hasExpiresAt = isValidIsoDate((item as any).expiresAt);
      const expiresAt = hasExpiresAt
        ? (item as any).expiresAt
        : new Date(Date.parse(approvedAt) + CONSENT_TTL_MS).toISOString();
      if (!hasApprovedAt || !hasExpiresAt) changed = true;
      entry = { domain, approvedAt, expiresAt };
    } else {
      changed = true;
    }

    if (!entry) continue;
    const existing = deduped.get(entry.domain);
    if (!existing) {
      deduped.set(entry.domain, entry);
      continue;
    }
    changed = true;
    if (Date.parse(entry.expiresAt) > Date.parse(existing.expiresAt)) {
      deduped.set(entry.domain, entry);
    }
  }

  if (deduped.size !== raw.length) changed = true;
  return { entries: [...deduped.values()], changed };
}

function isExpired(entry: ApprovedDomainEntry, nowMs: number): boolean {
  return Date.parse(entry.expiresAt) <= nowMs;
}

function getStorageEntries(): Promise<NormalizeResult> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(normalizeEntries(result[STORAGE_KEY]));
    });
  });
}

function setStorageEntries(entries: ApprovedDomainEntry[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: entries }, resolve);
  });
}

async function getActiveEntries(): Promise<ApprovedDomainEntry[]> {
  const normalized = await getStorageEntries();
  const entries = normalized.entries;
  const nowMs = Date.now();
  const active = entries.filter(entry => !isExpired(entry, nowMs));
  if (normalized.changed || active.length !== entries.length) {
    await setStorageEntries(active);
  }
  return active;
}

export async function isApproved(domain: string): Promise<boolean> {
  const entries = await getActiveEntries();
  return entries.some(entry => entry.domain === domain);
}

export async function addApprovedDomain(domain: string): Promise<void> {
  const entries = await getActiveEntries();
  const now = Date.now();
  const updated: ApprovedDomainEntry = {
    domain,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONSENT_TTL_MS).toISOString(),
  };

  const existingIndex = entries.findIndex(entry => entry.domain === domain);
  if (existingIndex >= 0) {
    entries[existingIndex] = updated;
  } else {
    entries.push(updated);
  }

  await setStorageEntries(entries);
}

export async function removeApprovedDomain(domain: string): Promise<void> {
  const entries = await getActiveEntries();
  await setStorageEntries(entries.filter(entry => entry.domain !== domain));
}

export async function getApprovedDomains(): Promise<string[]> {
  const entries = await getActiveEntries();
  return entries.map(entry => entry.domain);
}

export async function getApprovedDomainEntries(): Promise<ApprovedDomainEntry[]> {
  const entries = await getActiveEntries();
  return [...entries].sort((a, b) => Date.parse(b.approvedAt) - Date.parse(a.approvedAt));
}

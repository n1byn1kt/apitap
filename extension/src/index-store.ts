import type { IndexFile, IndexEntry, IndexEndpoint } from './types.js';
import type { Observation } from './observer.js';

/** Create an empty index */
export function createEmptyIndex(): IndexFile {
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

/** Merge a single observation into the index. Returns a new index (immutable). */
export function mergeObservation(index: IndexFile, obs: Observation): IndexFile {
  const entries = [...index.entries];
  const now = obs.endpoint.lastSeen;

  let domainEntry = entries.find(e => e.domain === obs.domain);
  if (!domainEntry) {
    domainEntry = {
      domain: obs.domain,
      firstSeen: now,
      lastSeen: now,
      totalHits: 0,
      promoted: false,
      endpoints: [],
    };
    entries.push(domainEntry);
  } else {
    // Clone to avoid mutating the original
    const idx = entries.indexOf(domainEntry);
    domainEntry = { ...domainEntry, endpoints: [...domainEntry.endpoints] };
    entries[idx] = domainEntry;
  }

  domainEntry.totalHits++;
  domainEntry.lastSeen = now;

  // Find or create endpoint
  const existingEp = domainEntry.endpoints.find(ep => ep.path === obs.endpoint.path);
  if (existingEp) {
    const epIdx = domainEntry.endpoints.indexOf(existingEp);
    const merged: IndexEndpoint = {
      ...existingEp,
      hits: existingEp.hits + 1,
      lastSeen: now,
      hasBody: existingEp.hasBody || obs.endpoint.hasBody,
    };

    // Merge methods without duplicates
    const methodSet = new Set([...existingEp.methods, ...obs.endpoint.methods]);
    merged.methods = [...methodSet];

    // Merge auth type (keep first detected)
    if (!existingEp.authType && obs.endpoint.authType) {
      merged.authType = obs.endpoint.authType;
    }

    // Merge pagination (keep first detected)
    if (!existingEp.pagination && obs.endpoint.pagination) {
      merged.pagination = obs.endpoint.pagination;
    }

    // Merge type (keep first detected)
    if (!existingEp.type && obs.endpoint.type) {
      merged.type = obs.endpoint.type;
    }

    // Merge query param names without duplicates
    if (obs.endpoint.queryParamNames || existingEp.queryParamNames) {
      const paramSet = new Set([
        ...(existingEp.queryParamNames ?? []),
        ...(obs.endpoint.queryParamNames ?? []),
      ]);
      merged.queryParamNames = [...paramSet].sort();
    }

    domainEntry.endpoints[epIdx] = merged;
  } else {
    domainEntry.endpoints.push({ ...obs.endpoint });
  }

  return {
    v: 1,
    updatedAt: now,
    entries,
  };
}

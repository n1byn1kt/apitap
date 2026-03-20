// src/skill/apis-guru.ts
import { resolveAndValidateUrl } from '../skill/ssrf.js';

export interface ApisGuruEntry {
  apiId: string;           // e.g., "twilio.com:api"
  providerName: string;    // e.g., "twilio.com"
  title: string;
  specUrl: string;         // direct URL to OpenAPI JSON spec
  openapiVer: string;
  updated: string;
}

const APIS_GURU_LIST_URL = 'https://api.apis.guru/v2/list.json';

/**
 * Parse raw APIs.guru list.json response into ApisGuruEntry array.
 * For each API, use the preferred version's data.
 */
export function parseApisGuruList(raw: Record<string, any>): ApisGuruEntry[] {
  const entries: ApisGuruEntry[] = [];

  for (const apiId of Object.keys(raw)) {
    const apiData = raw[apiId];
    if (!apiData || typeof apiData !== 'object') continue;

    const preferred: string = apiData.preferred;
    if (!preferred) continue;

    const versions = apiData.versions;
    if (!versions || typeof versions !== 'object') continue;

    const versionData = versions[preferred];
    if (!versionData || typeof versionData !== 'object') continue;

    const swaggerUrl: string | undefined = versionData.swaggerUrl;
    if (!swaggerUrl) continue;

    const info = versionData.info ?? {};
    const title: string = info.title ?? '';
    const openapiVer: string = versionData.openapiVer ?? '';
    const updated: string = versionData.updated ?? '';

    // providerName: prefer info.x-providerName, else split apiId on ':', else use apiId
    let providerName: string;
    if (info['x-providerName']) {
      providerName = info['x-providerName'];
    } else {
      const colonIdx = apiId.indexOf(':');
      providerName = colonIdx >= 0 ? apiId.slice(0, colonIdx) : apiId;
    }

    entries.push({
      apiId,
      providerName,
      title,
      specUrl: swaggerUrl,
      openapiVer,
      updated,
    });
  }

  return entries;
}

export interface FilterOptions {
  search?: string;
  limit?: number;
  noAuthOnly?: boolean;
  preferOpenapi3?: boolean;
}

/**
 * Filter and sort ApisGuruEntry array.
 * - search: substring match (case-insensitive) on providerName or title
 * - preferOpenapi3: sort 3.x entries before 2.x, then by recency within groups
 * - default sort: by recency (updated desc)
 * - limit: cap result count
 */
export function filterEntries(
  entries: ApisGuruEntry[],
  options: FilterOptions,
): ApisGuruEntry[] {
  const { search, limit, preferOpenapi3 } = options;

  let result = entries;

  // Filter by search term
  if (search) {
    const lower = search.toLowerCase();
    result = result.filter(
      e =>
        e.providerName.toLowerCase().includes(lower) ||
        e.title.toLowerCase().includes(lower),
    );
  }

  // Sort
  result = [...result].sort((a, b) => {
    if (preferOpenapi3) {
      const aIs3 = a.openapiVer.startsWith('3') ? 0 : 1;
      const bIs3 = b.openapiVer.startsWith('3') ? 0 : 1;
      if (aIs3 !== bIs3) return aIs3 - bIs3;
    }
    // Within same group (or when not preferring 3.x), sort by recency desc
    return b.updated.localeCompare(a.updated);
  });

  // Apply limit
  if (typeof limit === 'number' && limit > 0) {
    result = result.slice(0, limit);
  }

  return result;
}

/**
 * Fetch the APIs.guru list.json and parse it into ApisGuruEntry array.
 */
export async function fetchApisGuruList(): Promise<ApisGuruEntry[]> {
  const ssrf = await resolveAndValidateUrl(APIS_GURU_LIST_URL);
  if (!ssrf.safe) {
    throw new Error(`SSRF check failed for APIs.guru list URL: ${ssrf.reason}`);
  }
  const response = await fetch(APIS_GURU_LIST_URL, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch APIs.guru list: ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  try {
    return parseApisGuruList(JSON.parse(text) as Record<string, any>);
  } catch {
    throw new Error(`Invalid JSON from ${APIS_GURU_LIST_URL}: ${text.slice(0, 100)}`);
  }
}

/**
 * Fetch a single OpenAPI spec by URL and return the parsed JSON.
 */
export async function fetchSpec(specUrl: string): Promise<Record<string, any>> {
  const ssrf = await resolveAndValidateUrl(specUrl);
  if (!ssrf.safe) {
    throw new Error(`SSRF check failed for spec URL ${specUrl}: ${ssrf.reason}`);
  }
  const response = await fetch(specUrl, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch spec at ${specUrl}: ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error(`Invalid JSON from ${specUrl}: ${text.slice(0, 100)}`);
  }
}

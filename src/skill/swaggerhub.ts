// src/skill/swaggerhub.ts
import { resolveAndValidateUrl } from './ssrf.js';

const MAX_SPEC_SIZE = 10 * 1024 * 1024; // 10 MB per spec
const SWAGGERHUB_API = 'https://api.swaggerhub.com';

async function fetchWithSizeLimit(url: string, maxBytes: number, options?: RequestInit): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
    ...options,
    headers: { 'User-Agent': 'apitap-import/1.0', Accept: 'application/json', ...(options?.headers as Record<string, string> || {}) },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Response too large: ${contentLength} bytes (limit: ${maxBytes})`);
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new Error(`Response body too large: ${text.length} bytes (limit: ${maxBytes})`);
  }
  return text;
}

export interface SwaggerHubEntry {
  owner: string;
  name: string;
  title: string;
  specUrl: string;
  openapiVer: string;
  updated: string;
}

export interface SwaggerHubSearchOptions {
  query: string;
  limit?: number;
  sort?: 'BEST_MATCH' | 'NAME' | 'UPDATED';
}

/**
 * Search SwaggerHub for public API specs.
 * Returns entries with spec download URLs.
 */
export async function searchSwaggerHub(options: SwaggerHubSearchOptions): Promise<{ entries: SwaggerHubEntry[]; totalCount: number }> {
  const { query, limit = 20, sort = 'BEST_MATCH' } = options;
  const url = `${SWAGGERHUB_API}/apis?query=${encodeURIComponent(query)}&limit=${limit}&sort=${sort}`;

  const ssrf = await resolveAndValidateUrl(url);
  if (!ssrf.safe) {
    throw new Error(`SSRF check failed for SwaggerHub URL: ${ssrf.reason}`);
  }

  const text = await fetchWithSizeLimit(url, 5 * 1024 * 1024);
  const data = JSON.parse(text);

  const entries: SwaggerHubEntry[] = [];
  const totalCount: number = data.totalCount ?? 0;

  for (const api of (data.apis ?? [])) {
    const props = api.properties ?? [];
    const getProperty = (type: string): string | undefined =>
      props.find((p: any) => p.type === type)?.value ?? props.find((p: any) => p.type === type)?.url;

    const specUrl = getProperty('Swagger');
    if (!specUrl) continue;

    // Skip private APIs
    if (getProperty('X-Private') === 'true') continue;

    const oasVersion = getProperty('X-OASVersion') ?? getProperty('X-Specification') ?? '';
    const updated = getProperty('X-Modified') ?? getProperty('X-Created') ?? '';
    const name = api.name ?? '';
    const title = api.description ?? name;

    // Extract owner from spec URL: https://api.swaggerhub.com/apis/{owner}/{name}/{version}
    const urlParts = specUrl.replace(`${SWAGGERHUB_API}/apis/`, '').split('/');
    const owner = urlParts[0] ?? '';

    entries.push({
      owner,
      name,
      title,
      specUrl,
      openapiVer: oasVersion,
      updated,
    });
  }

  return { entries, totalCount };
}

/**
 * Fetch an OpenAPI spec from SwaggerHub by URL.
 */
export async function fetchSwaggerHubSpec(specUrl: string): Promise<Record<string, any>> {
  const ssrf = await resolveAndValidateUrl(specUrl);
  if (!ssrf.safe) {
    throw new Error(`SSRF check failed for spec URL ${specUrl}: ${ssrf.reason}`);
  }

  const text = await fetchWithSizeLimit(specUrl, MAX_SPEC_SIZE);
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    // Some specs may be YAML
    try {
      const yaml = await import('js-yaml');
      const parsed = yaml.load(text);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('YAML parsed to non-object');
      }
      return parsed as Record<string, any>;
    } catch {
      throw new Error(`Invalid JSON/YAML from ${specUrl}: ${text.slice(0, 100)}`);
    }
  }
}

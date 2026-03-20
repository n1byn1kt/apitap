// src/discovery/openapi.ts
import type { SkillEndpoint, SkillFile, DiscoveredSpec } from '../types.js';
import { safeFetch } from './fetch.js';
import { convertOpenAPISpec } from '../skill/openapi-converter.js';

/** Paths to check for API specs, in priority order */
const SPEC_PATHS = [
  '/openapi.json',
  '/swagger.json',
  '/api-docs',
  '/api/docs',
  '/.well-known/openapi',
  '/v1/openapi.json',
  '/v2/openapi.json',
  '/v3/openapi.json',
  '/docs/api.json',
  '/api/swagger.json',
];

interface OpenApiSpec {
  openapi?: string;    // "3.x.x"
  swagger?: string;    // "2.0"
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  servers?: { url: string }[];
  host?: string;       // Swagger 2.0
  basePath?: string;   // Swagger 2.0
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, unknown>;
}

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: { type?: string };
}

export interface SpecDiscoveryOptions {
  skipSsrf?: boolean;
}

/**
 * Check for API specs at common paths and in Link headers.
 * Returns discovered specs with their URLs.
 */
export async function discoverSpecs(
  baseUrl: string,
  homepageHeaders?: Record<string, string>,
  options: SpecDiscoveryOptions = {},
): Promise<DiscoveredSpec[]> {
  const specs: DiscoveredSpec[] = [];
  const origin = new URL(baseUrl).origin;

  // Check Link header from homepage for rel="describedby"
  if (homepageHeaders) {
    const linkHeader = homepageHeaders['link'] || homepageHeaders['Link'];
    if (linkHeader) {
      const describedBy = parseLinkHeader(linkHeader, 'describedby');
      if (describedBy) {
        const specUrl = describedBy.startsWith('http') ? describedBy : `${origin}${describedBy}`;
        const result = await tryFetchSpec(specUrl, options);
        if (result) specs.push(result);
      }
    }
  }

  // Probe common spec paths in parallel
  const checks = SPEC_PATHS.map(async (path) => {
    const specUrl = `${origin}${path}`;
    return tryFetchSpec(specUrl, options);
  });

  const results = await Promise.all(checks);
  for (const result of results) {
    if (result && !specs.some(s => s.url === result.url)) {
      specs.push(result);
    }
  }

  return specs;
}

async function tryFetchSpec(url: string, options: SpecDiscoveryOptions = {}): Promise<DiscoveredSpec | null> {
  const result = await safeFetch(url, { timeout: 5000, skipSsrf: options.skipSsrf });
  if (!result || result.status !== 200) return null;

  // Must look like JSON
  const ct = result.contentType.toLowerCase();
  if (!ct.includes('json') && !ct.includes('yaml') && !ct.includes('text/plain')) return null;

  try {
    const spec = JSON.parse(result.body) as OpenApiSpec;
    if (spec.openapi || spec.swagger) {
      const endpointCount = spec.paths ? Object.keys(spec.paths).reduce((sum, path) => {
        return sum + Object.keys(spec.paths![path]).filter(m => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length;
      }, 0) : 0;

      return {
        type: spec.openapi ? 'openapi' : 'swagger',
        url,
        version: spec.openapi || spec.swagger,
        endpointCount,
      };
    }
  } catch {
    // Not valid JSON or not an API spec
  }
  return null;
}

/**
 * Parse an OpenAPI/Swagger spec into a SkillFile.
 */
export async function parseSpecToSkillFile(
  specUrl: string,
  domain: string,
  baseUrl: string,
  options: SpecDiscoveryOptions = {},
): Promise<SkillFile | null> {
  const result = await safeFetch(specUrl, { timeout: 10000, skipSsrf: options.skipSsrf });
  if (!result || result.status !== 200) return null;

  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(result.body);
  } catch {
    return null;
  }

  if (!spec.paths) return null;

  // Determine API base URL (discovery uses the passed-in baseUrl as starting point)
  let apiBase = baseUrl;
  if (spec.servers?.[0]?.url) {
    const serverUrl = spec.servers[0].url;
    apiBase = serverUrl.startsWith('http') ? serverUrl : `${baseUrl}${serverUrl}`;
  } else if (spec.host) {
    const scheme = specUrl.startsWith('https') ? 'https' : 'http';
    apiBase = `${scheme}://${spec.host}${spec.basePath || ''}`;
  }

  // Delegate endpoint extraction to the shared converter
  const { endpoints: convertedEndpoints } = convertOpenAPISpec(spec, specUrl);

  if (convertedEndpoints.length === 0) return null;

  // Post-process: add replayability signal and fix example URLs to use apiBase
  const endpoints: SkillEndpoint[] = convertedEndpoints.map(ep => {
    // Rebuild example URL using apiBase (converter uses https://<domain> but discovery
    // should use the baseUrl passed in, which may be http:// or a different host)
    const exampleUrl = ep.examples.request.url.replace(/^https?:\/\/[^/]+/, apiBase.replace(/\/$/, ''));
    return {
      ...ep,
      examples: {
        ...ep.examples,
        request: { ...ep.examples.request, url: exampleUrl },
      },
      replayability: {
        tier: 'unknown',
        verified: false,
        signals: ['discovered-from-spec'],
      },
    };
  });

  return {
    version: '1.2',
    domain,
    capturedAt: new Date().toISOString(),
    baseUrl: apiBase,
    endpoints,
    metadata: {
      captureCount: 0,
      filteredCount: 0,
      toolVersion: '1.0.0',
    },
    provenance: 'unsigned',
  };
}

function parseLinkHeader(header: string, rel: string): string | null {
  const parts = header.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>.*rel\s*=\s*"?([^",;]+)"?/);
    if (match && match[2].trim() === rel) {
      return match[1];
    }
  }
  return null;
}

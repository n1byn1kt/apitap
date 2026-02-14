// src/discovery/openapi.ts
import type { SkillEndpoint, SkillFile, DiscoveredSpec } from '../types.js';
import { safeFetch } from './fetch.js';

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

  // Determine API base URL
  let apiBase = baseUrl;
  if (spec.servers?.[0]?.url) {
    const serverUrl = spec.servers[0].url;
    apiBase = serverUrl.startsWith('http') ? serverUrl : `${baseUrl}${serverUrl}`;
  } else if (spec.host) {
    const scheme = specUrl.startsWith('https') ? 'https' : 'http';
    apiBase = `${scheme}://${spec.host}${spec.basePath || ''}`;
  }

  const endpoints: SkillEndpoint[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const op = operation as OpenApiOperation;

      // Parameterize path: {id} → :id
      const paramPath = path.replace(/\{([^}]+)\}/g, ':$1');

      // Extract query params
      const queryParams: Record<string, { type: string; example: string }> = {};
      if (op.parameters) {
        for (const param of op.parameters) {
          if (param.in === 'query') {
            queryParams[param.name] = {
              type: param.schema?.type || 'string',
              example: '',
            };
          }
        }
      }

      // Generate endpoint ID
      const id = op.operationId
        ? method.toLowerCase() + '-' + op.operationId.replace(/[^a-z0-9]/gi, '-').toLowerCase()
        : generateId(method, paramPath);

      endpoints.push({
        id,
        method: method.toUpperCase(),
        path: paramPath,
        queryParams,
        headers: {},
        responseShape: { type: 'unknown' },
        examples: {
          request: { url: `${apiBase}${path}`, headers: {} },
          responsePreview: null,
        },
        replayability: {
          tier: 'unknown',
          verified: false,
          signals: ['discovered-from-spec'],
        },
      });
    }
  }

  if (endpoints.length === 0) return null;

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

function generateId(method: string, path: string): string {
  const segments = path.split('/').filter(s => s !== '' && !s.startsWith(':'));
  const slug = segments.join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'root';
  return `${method.toLowerCase()}-${slug}`;
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

// src/skill/generator.ts
import type { CapturedExchange, SkillEndpoint, SkillFile } from '../types.js';

const KEEP_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'x-api-key',
  'x-csrf-token',
  'x-requested-with',
]);

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (KEEP_HEADERS.has(lower) || (lower.startsWith('x-') && !lower.startsWith('x-forwarded'))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function generateEndpointId(method: string, path: string): string {
  const slug = path
    .replace(/^\//, '')
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
  return `${method.toLowerCase()}-${slug || 'root'}`;
}

function detectResponseShape(body: string): { type: string; fields?: string[] } {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      return {
        type: 'array',
        fields: first && typeof first === 'object' && first !== null
          ? Object.keys(first)
          : undefined,
      };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return { type: 'object', fields: Object.keys(parsed) };
    }
    return { type: typeof parsed };
  } catch {
    return { type: 'unknown' };
  }
}

function truncatePreview(body: string, maxItems = 2): unknown {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed.slice(0, maxItems);
    }
    return parsed;
  } catch {
    return body.slice(0, 500);
  }
}

function extractQueryParams(url: URL): Record<string, { type: string; example: string }> {
  const params: Record<string, { type: string; example: string }> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = { type: 'string', example: value };
  }
  return params;
}

export class SkillGenerator {
  private endpoints = new Map<string, SkillEndpoint>();
  private captureCount = 0;
  private filteredCount = 0;
  private baseUrl: string | null = null;

  /** Add a captured exchange. Returns the new endpoint if first seen, null if duplicate. */
  addExchange(exchange: CapturedExchange): SkillEndpoint | null {
    this.captureCount++;

    const url = new URL(exchange.request.url);

    // Track baseUrl from the first captured exchange
    if (!this.baseUrl) {
      this.baseUrl = url.origin;
    }
    const key = `${exchange.request.method} ${url.pathname}`;

    if (this.endpoints.has(key)) {
      return null;
    }

    const endpoint: SkillEndpoint = {
      id: generateEndpointId(exchange.request.method, url.pathname),
      method: exchange.request.method,
      path: url.pathname,
      queryParams: extractQueryParams(url),
      headers: filterHeaders(exchange.request.headers),
      responseShape: detectResponseShape(exchange.response.body),
      examples: {
        request: {
          url: exchange.request.url,
          headers: filterHeaders(exchange.request.headers),
        },
        responsePreview: truncatePreview(exchange.response.body),
      },
    };

    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  /** Record a filtered-out request (for metadata tracking). */
  recordFiltered(): void {
    this.filteredCount++;
  }

  /** Generate the complete skill file for a domain. */
  toSkillFile(domain: string): SkillFile {
    return {
      version: '1.1',
      domain,
      capturedAt: new Date().toISOString(),
      baseUrl: this.baseUrl ?? `https://${domain}`,
      endpoints: Array.from(this.endpoints.values()),
      metadata: {
        captureCount: this.captureCount,
        filteredCount: this.filteredCount,
        toolVersion: '0.2.0',
      },
      provenance: 'unsigned' as const,
    };
  }
}

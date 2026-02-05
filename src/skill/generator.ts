// src/skill/generator.ts
import type { CapturedExchange, SkillEndpoint, SkillFile, StoredAuth } from '../types.js';
import { scrubPII } from '../capture/scrubber.js';

const KEEP_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'x-api-key',
  'x-csrf-token',
  'x-requested-with',
]);

const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
]);

export interface GeneratorOptions {
  enablePreview?: boolean;
  scrub?: boolean;
}

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

function stripAuth(headers: Record<string, string>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (AUTH_HEADERS.has(lower)) {
      stripped[key] = '[stored]';
    } else {
      stripped[key] = value;
    }
  }
  return stripped;
}

function extractAuth(headers: Record<string, string>): StoredAuth[] {
  const auth: StoredAuth[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' && value) {
      auth.push({
        type: value.toLowerCase().startsWith('bearer') ? 'bearer' : 'custom',
        header: lower,
        value,
      });
    } else if (lower === 'x-api-key' && value) {
      auth.push({ type: 'api-key', header: lower, value });
    }
  }
  return auth;
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

function scrubQueryParams(
  params: Record<string, { type: string; example: string }>,
): Record<string, { type: string; example: string }> {
  const scrubbed: Record<string, { type: string; example: string }> = {};
  for (const [key, val] of Object.entries(params)) {
    scrubbed[key] = { type: val.type, example: scrubPII(val.example) };
  }
  return scrubbed;
}

export class SkillGenerator {
  private endpoints = new Map<string, SkillEndpoint>();
  private captureCount = 0;
  private filteredCount = 0;
  private baseUrl: string | null = null;
  private extractedAuthList: StoredAuth[] = [];
  private options: Required<GeneratorOptions>;

  constructor(options: GeneratorOptions = {}) {
    this.options = {
      enablePreview: options.enablePreview ?? false,
      scrub: options.scrub ?? true,
    };
  }

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

    // Extract auth before filtering headers
    const auth = extractAuth(exchange.request.headers);
    this.extractedAuthList.push(...auth);

    // Filter headers, then strip auth values
    const filtered = filterHeaders(exchange.request.headers);
    const safeHeaders = stripAuth(filtered);

    // Build query params, optionally scrub PII
    let queryParams = extractQueryParams(url);
    if (this.options.scrub) {
      queryParams = scrubQueryParams(queryParams);
    }

    // Build example URL, optionally scrub PII
    let exampleUrl = exchange.request.url;
    if (this.options.scrub) {
      exampleUrl = scrubPII(exampleUrl);
    }

    // Response preview: null by default, populated with --preview
    let responsePreview: unknown = null;
    if (this.options.enablePreview) {
      const preview = truncatePreview(exchange.response.body);
      responsePreview = this.options.scrub && typeof preview === 'string'
        ? scrubPII(preview)
        : preview;
    }

    const endpoint: SkillEndpoint = {
      id: generateEndpointId(exchange.request.method, url.pathname),
      method: exchange.request.method,
      path: url.pathname,
      queryParams,
      headers: safeHeaders,
      responseShape: detectResponseShape(exchange.response.body),
      examples: {
        request: {
          url: exampleUrl,
          headers: stripAuth(filterHeaders(exchange.request.headers)),
        },
        responsePreview,
      },
    };

    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  /** Record a filtered-out request (for metadata tracking). */
  recordFiltered(): void {
    this.filteredCount++;
  }

  /** Get auth credentials extracted during capture. */
  getExtractedAuth(): StoredAuth[] {
    return this.extractedAuthList;
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

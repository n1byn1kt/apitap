// src/types.ts

/** A captured HTTP request/response pair from the browser */
export interface CapturedExchange {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    contentType: string;
  };
  timestamp: string;
}

/** Stored auth credentials for a domain */
export interface StoredAuth {
  type: 'bearer' | 'api-key' | 'cookie' | 'custom';
  header: string;
  value: string;
}

/** A single API endpoint in a skill file */
export interface SkillEndpoint {
  id: string;
  method: string;
  path: string;
  queryParams: Record<string, { type: string; example: string }>;
  headers: Record<string, string>;
  responseShape: { type: string; fields?: string[] };
  examples: {
    request: { url: string; headers: Record<string, string> };
    responsePreview: unknown;
  };
}

/** The full skill file written to disk */
export interface SkillFile {
  version: string;
  domain: string;
  capturedAt: string;
  baseUrl: string;
  endpoints: SkillEndpoint[];
  metadata: {
    captureCount: number;
    filteredCount: number;
    toolVersion: string;
  };
  provenance: 'self' | 'imported' | 'unsigned';
  signature?: string;
}

/** Summary returned by `apitap list` */
export interface SkillSummary {
  domain: string;
  skillFile: string;
  endpointCount: number;
  capturedAt: string;
  provenance: 'self' | 'imported' | 'unsigned';
}

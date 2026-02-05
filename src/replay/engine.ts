// src/replay/engine.ts
import type { SkillFile } from '../types.js';

export interface ReplayResult {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

export async function replayEndpoint(
  skill: SkillFile,
  endpointId: string,
  params?: Record<string, string>,
): Promise<ReplayResult> {
  const endpoint = skill.endpoints.find(e => e.id === endpointId);
  if (!endpoint) {
    throw new Error(
      `Endpoint "${endpointId}" not found in skill for ${skill.domain}. ` +
      `Available: ${skill.endpoints.map(e => e.id).join(', ')}`,
    );
  }

  const url = new URL(endpoint.path, skill.baseUrl);

  // Apply query params: start with captured defaults, override with provided params
  for (const [key, val] of Object.entries(endpoint.queryParams)) {
    url.searchParams.set(key, val.example);
  }
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
  }

  const response = await fetch(url.toString(), {
    method: endpoint.method,
    headers: endpoint.headers,
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let data: unknown;
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return { status: response.status, headers: responseHeaders, data };
}

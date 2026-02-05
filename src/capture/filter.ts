// src/capture/filter.ts
import { isBlocklisted } from './blocklist.js';

export interface FilterableResponse {
  url: string;
  status: number;
  contentType: string;
}

const JSON_CONTENT_TYPES = [
  'application/json',
  'application/vnd.api+json',
  'text/json',
];

export function shouldCapture(response: FilterableResponse): boolean {
  // Only keep 2xx success responses
  if (response.status < 200 || response.status >= 300) return false;

  // Content-type must indicate JSON
  const ct = response.contentType.toLowerCase().split(';')[0].trim();
  if (!JSON_CONTENT_TYPES.some(t => ct === t)) return false;

  // Check domain against blocklist
  try {
    const hostname = new URL(response.url).hostname;
    if (isBlocklisted(hostname)) return false;
  } catch {
    return false;
  }

  return true;
}

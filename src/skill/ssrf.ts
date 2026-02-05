// src/skill/ssrf.ts
import type { SkillFile } from '../types.js';

export interface ValidationResult {
  safe: boolean;
  reason?: string;
}

const INTERNAL_HOSTNAMES = ['localhost'];
const INTERNAL_SUFFIXES = ['.local', '.internal'];

/**
 * Check if a URL is safe to replay (not targeting internal infrastructure).
 */
export function validateUrl(urlString: string): ValidationResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Scheme check
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: `Non-HTTP scheme: ${url.protocol}` };
  }

  const hostname = url.hostname;

  // Exact internal hostnames
  if (INTERNAL_HOSTNAMES.includes(hostname)) {
    return { safe: false, reason: `URL targets internal hostname: ${hostname}` };
  }

  // Internal domain suffixes
  for (const suffix of INTERNAL_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { safe: false, reason: `URL targets internal domain: ${hostname}` };
    }
  }

  // IPv6 loopback
  if (hostname === '[::1]' || hostname === '::1') {
    return { safe: false, reason: 'URL targets IPv6 loopback' };
  }

  // IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    const first = Number(a);
    const second = Number(b);

    // 127.x.x.x — loopback
    if (first === 127) {
      return { safe: false, reason: `URL targets loopback address: ${hostname}` };
    }
    // 10.x.x.x — private
    if (first === 10) {
      return { safe: false, reason: `URL targets private IP: ${hostname}` };
    }
    // 172.16-31.x.x — private
    if (first === 172 && second >= 16 && second <= 31) {
      return { safe: false, reason: `URL targets private IP: ${hostname}` };
    }
    // 192.168.x.x — private
    if (first === 192 && second === 168) {
      return { safe: false, reason: `URL targets private IP: ${hostname}` };
    }
    // 169.254.x.x — link-local
    if (first === 169 && second === 254) {
      return { safe: false, reason: `URL targets link-local address: ${hostname}` };
    }
  }

  return { safe: true };
}

/**
 * Validate all URLs in a skill file.
 * Checks baseUrl and all endpoint example URLs.
 */
export function validateSkillFileUrls(skill: SkillFile): ValidationResult {
  // Check baseUrl
  const baseResult = validateUrl(skill.baseUrl);
  if (!baseResult.safe) {
    return { safe: false, reason: `baseUrl: ${baseResult.reason}` };
  }

  // Check endpoint example URLs
  for (const ep of skill.endpoints) {
    const exUrl = ep.examples?.request?.url;
    if (exUrl) {
      const result = validateUrl(exUrl);
      if (!result.safe) {
        return { safe: false, reason: `endpoint ${ep.id}: ${result.reason}` };
      }
    }
  }

  return { safe: true };
}

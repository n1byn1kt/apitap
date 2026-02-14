// src/skill/ssrf.ts
import { lookup } from 'node:dns/promises';
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

  // IPv4-mapped IPv6 — dotted-quad form (e.g. [::ffff:127.0.0.1])
  const v4MappedMatch = hostname.match(/^\[?::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]?$/i);
  if (v4MappedMatch) {
    return validateUrl(`${url.protocol}//${v4MappedMatch[1]}${url.port ? ':' + url.port : ''}${url.pathname}`);
  }

  // IPv4-mapped IPv6 — hex form (e.g. [::ffff:7f00:1], Node normalizes to this)
  const v4MappedHexMatch = hostname.match(/^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/i);
  if (v4MappedHexMatch) {
    const hi = parseInt(v4MappedHexMatch[1], 16);
    const lo = parseInt(v4MappedHexMatch[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return validateUrl(`${url.protocol}//${ipv4}${url.port ? ':' + url.port : ''}${url.pathname}`);
  }

  // IPv6 link-local (fe80::/10)
  if (/^\[?fe[89ab][0-9a-f]:/i.test(hostname)) {
    return { safe: false, reason: `URL targets IPv6 link-local address: ${hostname}` };
  }

  // IPv6 unique local (fc00::/7 — includes fd00::/8)
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(hostname)) {
    return { safe: false, reason: `URL targets IPv6 unique-local address: ${hostname}` };
  }

  // IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    const first = Number(a);
    const second = Number(b);

    // 0.0.0.0 — unspecified
    if (first === 0) {
      return { safe: false, reason: `URL targets unspecified address: ${hostname}` };
    }
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
 * Check if a resolved IP address is in a private/reserved range.
 */
function isPrivateIp(ip: string): string | null {
  // IPv6 loopback
  if (ip === '::1') return 'IPv6 loopback';

  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return 'IPv6 link-local';

  // IPv6 unique local (fc00::/7 — includes fd00::/8)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return 'IPv6 unique-local';

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const v4mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const ipv4 = v4mapped ? v4mapped[1] : ip;

  const parts = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!parts) return null; // Not an IPv4 — let it pass (non-private IPv6)

  const [, a, b] = parts;
  const first = Number(a);
  const second = Number(b);

  if (first === 127) return 'loopback';
  if (first === 10) return 'private (10.x)';
  if (first === 172 && second >= 16 && second <= 31) return 'private (172.16-31.x)';
  if (first === 192 && second === 168) return 'private (192.168.x)';
  if (first === 169 && second === 254) return 'link-local';
  if (first === 0) return 'unspecified';

  return null;
}

/**
 * Resolve hostname and validate the resolved IP against private ranges.
 * Prevents DNS rebinding attacks where a domain resolves to 127.0.0.1.
 */
export async function resolveAndValidateUrl(urlString: string): Promise<ValidationResult> {
  // First run the sync hostname-based checks
  const syncResult = validateUrl(urlString);
  if (!syncResult.safe) return syncResult;

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  const hostname = url.hostname;

  // Skip DNS resolution for raw IPs (already checked by validateUrl)
  if (hostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/) || hostname.startsWith('[')) {
    return { safe: true };
  }

  // Resolve DNS and check the actual IP
  try {
    const { address } = await lookup(hostname);
    const privateReason = isPrivateIp(address);
    if (privateReason) {
      return { safe: false, reason: `DNS rebinding: ${hostname} resolves to ${address} (${privateReason})` };
    }
  } catch {
    // DNS resolution failed — hostname doesn't exist
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }

  return { safe: true };
}

/**
 * Validate all URLs in a skill file with DNS resolution.
 * Checks baseUrl and all endpoint example URLs.
 */
export async function resolveAndValidateSkillFileUrls(skill: SkillFile): Promise<ValidationResult> {
  const baseResult = await resolveAndValidateUrl(skill.baseUrl);
  if (!baseResult.safe) {
    return { safe: false, reason: `baseUrl: ${baseResult.reason}` };
  }

  for (const ep of skill.endpoints) {
    const exUrl = ep.examples?.request?.url;
    if (exUrl) {
      const result = await resolveAndValidateUrl(exUrl);
      if (!result.safe) {
        return { safe: false, reason: `endpoint ${ep.id}: ${result.reason}` };
      }
    }
  }

  return { safe: true };
}

/**
 * Validate all URLs in a skill file (sync, hostname-based only).
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

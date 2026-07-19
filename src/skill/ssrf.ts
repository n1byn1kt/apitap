// src/skill/ssrf.ts
import { lookup } from 'node:dns/promises';
import { isIPv6 } from 'node:net';
import type { SkillFile } from '../types.js';

export interface ValidationResult {
  safe: boolean;
  reason?: string;
  resolvedUrl?: string;
  resolvedIp?: string;
  originalHost?: string;
}

/**
 * Test-only escape-hatch guard (issue #64). The skipSsrf/_skipSsrfCheck
 * options exist so hermetic tests can hit loopback servers; outside a test
 * run they must be inert. Called at every public ingress that accepts the
 * flag — internal redirect re-validation (which passes skipSsrf after its
 * own check) is deliberately not routed through this.
 */
export function assertSsrfBypassAllowed(flag: unknown): void {
  if (!flag) return;
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
  // Operator path: the CLI's --danger-disable-ssrf flag exports this after
  // printing its warning. Deliberate and visible, unlike a silent option.
  if (process.env.APITAP_DANGER_DISABLE_SSRF === '1') return;
  throw new Error(
    'SSRF bypass (skipSsrf/_skipSsrfCheck) is test-only and refused outside a test run ' +
    '(use --danger-disable-ssrf for the warned operator override)',
  );
}

const INTERNAL_HOSTNAMES = ['localhost'];
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost', '.corp', '.intranet', '.lan', '.test', '.invalid', '.example'];

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

  // IPv6 literal hosts: delegate to the comprehensive isPrivateIp check,
  // which covers ::, ::1, multicast, documentation, NAT64, IPv4-mapped, and
  // link/site/unique-local. This closes literals (e.g. [::]) that the
  // pattern checks below miss, and unifies literal handling in one place.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    const reason = isPrivateIp(inner);
    if (reason) {
      return { safe: false, reason: `URL targets reserved IPv6 address: ${inner} (${reason})` };
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

  // Normalize IP representations: decimal integer, octal, hex → dotted-decimal (M17 fix)
  const normalizedIp = normalizeIpv4(hostname);
  const ipToCheck = normalizedIp ?? hostname;

  // IPv4 private/reserved ranges (M16: added CGNAT, IETF, benchmarking, reserved)
  const ipv4Match = ipToCheck.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
    // 100.64.0.0/10 — CGNAT (RFC 6598), used in cloud/Tailscale
    if (first === 100 && second >= 64 && second <= 127) {
      return { safe: false, reason: `URL targets CGNAT address: ${hostname}` };
    }
    // 192.0.0.0/24 — IETF Protocol Assignments (RFC 6890)
    if (first === 192 && second === 0 && Number(ipv4Match[3]) === 0) {
      return { safe: false, reason: `URL targets IETF reserved address: ${hostname}` };
    }
    // 198.18.0.0/15 — Benchmarking (RFC 2544)
    if (first === 198 && (second === 18 || second === 19)) {
      return { safe: false, reason: `URL targets benchmarking address: ${hostname}` };
    }
    // 240.0.0.0/4 — Reserved/future use
    if (first >= 240) {
      return { safe: false, reason: `URL targets reserved address: ${hostname}` };
    }
  }

  return { safe: true };
}

/**
 * Normalize alternative IPv4 representations to dotted-decimal.
 * Handles decimal integer (2130706433), octal (0177.0.0.1), and hex (0x7f.0.0.1).
 * Returns null if hostname is not an IP address or can't be parsed.
 */
function normalizeIpv4(hostname: string): string | null {
  // Already standard dotted-decimal
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return hostname;
  }

  // Pure decimal integer (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xFFFFFFFF) {
      return `${(num >>> 24) & 0xFF}.${(num >>> 16) & 0xFF}.${(num >>> 8) & 0xFF}.${num & 0xFF}`;
    }
  }

  // Dotted with octal (0-prefixed) or hex (0x-prefixed) octets
  const parts = hostname.split('.');
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let val: number;
      if (/^0x[0-9a-f]+$/i.test(part)) {
        val = parseInt(part, 16);
      } else if (/^0[0-7]+$/.test(part)) {
        val = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        val = parseInt(part, 10);
      } else {
        return null; // Not an IP
      }
      if (val < 0 || val > 255) return null;
      octets.push(val);
    }
    return octets.join('.');
  }

  return null;
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

  // IPv4-mapped IPv6 hex form (e.g. ::ffff:7f00:1)
  const v4mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIp(reconstructed);
  }

  // After IPv4-mapped unwrapping: if `ipv4` still looks like IPv6 (contains
  // a colon), treat it as a raw IPv6 address. Previously we fell through
  // to the IPv4 regex and returned 'unrecognized IP format', which blocked
  // every public IPv6 host (Cloudflare, Wikipedia, GitHub — all AAAA).
  if (ipv4.includes(':')) {
    // Reserved / non-routable IPv6 ranges beyond the ones already checked:
    if (ipv4 === '::') return 'IPv6 unspecified';
    if (/^ff[0-9a-f]{2}:/i.test(ipv4)) return 'IPv6 multicast';
    if (/^2001:db8:/i.test(ipv4)) return 'IPv6 documentation (2001:db8::/32)';
    if (/^100::/i.test(ipv4)) return 'IPv6 discard prefix (100::/64)';
    // NAT64 translation prefix — embeds an IPv4 address in the low 32 bits,
    // so it can reach internal IPv4 hosts (e.g. 64:ff9b::7f00:1 → 127.0.0.1).
    if (/^64:ff9b:/i.test(ipv4)) return 'IPv6 NAT64 (64:ff9b::/96)';
    // Deprecated site-local fec0::/10 (fec0–feff); link-local fe80::/10 is
    // handled above by the fe[89ab] check.
    if (/^fe[c-f][0-9a-f]:/i.test(ipv4)) return 'IPv6 site-local (deprecated fec0::/10)';
    // Validate textual format with Node's own IPv6 parser. Rejects
    // malformed input (too many colons, out-of-range groups, etc.).
    if (!isIPv6(ipv4)) return 'unrecognized IP format';
    // Valid public IPv6 address — safe for SSRF purposes.
    return null;
  }

  const parts = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!parts) return 'unrecognized IP format'; // Fail closed for unrecognized formats

  const [, a, b] = parts;
  const first = Number(a);
  const second = Number(b);

  if (first === 127) return 'loopback';
  if (first === 10) return 'private (10.x)';
  if (first === 172 && second >= 16 && second <= 31) return 'private (172.16-31.x)';
  if (first === 192 && second === 168) return 'private (192.168.x)';
  if (first === 169 && second === 254) return 'link-local';
  if (first === 0) return 'unspecified';
  // M16: additional reserved ranges
  if (first === 100 && second >= 64 && second <= 127) return 'CGNAT (100.64/10)';
  if (first === 198 && (second === 18 || second === 19)) return 'benchmarking (198.18/15)';
  if (first >= 240) return 'reserved (240/4)';

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

  // Skip DNS resolution for raw IPv4 literals (already range-checked by validateUrl).
  if (hostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
    return { safe: true };
  }

  // IPv6 literals have no DNS to resolve, but must still be range-checked
  // here rather than short-circuited to safe — validateUrl already ran, but
  // re-assert via isPrivateIp so a reserved literal can never slip through.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    const reason = isPrivateIp(inner);
    if (reason) {
      return { safe: false, reason: `URL targets reserved IPv6 address: ${inner} (${reason})` };
    }
    return { safe: true };
  }

  // Resolve DNS and check the actual IP
  try {
    const { address } = await lookup(hostname);
    const privateReason = isPrivateIp(address);
    if (privateReason) {
      return { safe: false, reason: `DNS rebinding: ${hostname} resolves to ${address} (${privateReason})` };
    }

    // Return the resolved URL with IP pinned to prevent DNS rebinding.
    // IPv6 addresses MUST be bracketed when assigned to URL.hostname —
    // otherwise the assignment silently fails and the hostname is left
    // unchanged (Node URL API behavior).
    const pinnedUrl = new URL(urlString);
    pinnedUrl.hostname = isIPv6(address) ? `[${address}]` : address;
    return {
      safe: true,
      resolvedUrl: pinnedUrl.toString(),
      resolvedIp: address,
      originalHost: hostname
    };
  } catch {
    // DNS resolution failed — hostname doesn't exist
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }
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

// src/capture/domain.ts

/**
 * Check if a hostname matches the target domain.
 * Uses dot-prefix matching to prevent evil-example.com matching example.com.
 *
 * @param hostname - The hostname to check (e.g. "api.example.com")
 * @param target - The target domain or URL (e.g. "example.com" or "https://example.com/path")
 */
export function isDomainMatch(hostname: string, target: string): boolean {
  // Extract hostname from URL if target looks like a URL
  let targetHost: string;
  try {
    if (target.includes('://')) {
      targetHost = new URL(target).hostname;
    } else {
      targetHost = target;
    }
  } catch {
    targetHost = target;
  }

  // Strip www. prefix from target for broader matching
  if (targetHost.startsWith('www.')) {
    targetHost = targetHost.slice(4);
  }

  // Exact match
  if (hostname === targetHost) return true;

  // Dot-prefix suffix match: hostname must end with ".targetHost"
  // This prevents evil-example.com from matching example.com
  return hostname.endsWith('.' + targetHost);
}

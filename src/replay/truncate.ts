// src/replay/truncate.ts

export interface TruncateOptions {
  maxBytes?: number; // default 50000 (50KB)
}

export interface TruncateResult {
  data: unknown;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 50_000;
const STRING_CAP = 500;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

/**
 * Truncate long string fields in an object, largest-first, until
 * the serialized size is under maxBytes.
 */
function truncateObjectStrings(obj: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const result = { ...obj };

  // Collect string fields with their lengths
  const stringFields: { key: string; len: number }[] = [];
  for (const [key, val] of Object.entries(result)) {
    if (typeof val === 'string' && val.length > STRING_CAP) {
      stringFields.push({ key, len: val.length });
    }
  }

  // Sort largest first
  stringFields.sort((a, b) => b.len - a.len);

  for (const { key } of stringFields) {
    const val = result[key] as string;
    result[key] = val.slice(0, STRING_CAP) + '... [truncated]';
    if (byteLength(JSON.stringify(result)) <= maxBytes) break;
  }

  return result;
}

/**
 * Truncate a response to fit within maxBytes when serialized as JSON.
 *
 * - Arrays: remove items from the end until it fits. If a single item
 *   exceeds the limit, truncate long string fields within that item.
 * - Objects: truncate long string fields largest-first.
 * - Primitives/strings: returned as-is (or sliced if string).
 */
export function truncateResponse(data: unknown, options?: TruncateOptions): TruncateResult {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  if (data === null || data === undefined) {
    return { data, truncated: false };
  }

  const serialized = JSON.stringify(data);
  if (byteLength(serialized) <= maxBytes) {
    return { data, truncated: false };
  }

  // Array truncation
  if (Array.isArray(data)) {
    const arr = [...data];

    // Remove items from the end until it fits
    while (arr.length > 1 && byteLength(JSON.stringify(arr)) > maxBytes) {
      arr.pop();
    }

    // If single item still exceeds limit, truncate strings within it
    if (arr.length === 1 && byteLength(JSON.stringify(arr)) > maxBytes) {
      const item = arr[0];
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        arr[0] = truncateObjectStrings(item as Record<string, unknown>, maxBytes);
      }
    }

    // If still over (e.g. array of primitives), return empty array
    if (arr.length === 1 && byteLength(JSON.stringify(arr)) > maxBytes) {
      return { data: [], truncated: true };
    }

    return { data: arr, truncated: true };
  }

  // Object truncation
  if (typeof data === 'object') {
    const result = truncateObjectStrings(data as Record<string, unknown>, maxBytes);
    return { data: result, truncated: true };
  }

  // String truncation as last resort
  if (typeof data === 'string') {
    // Binary search for the right length
    let lo = 0;
    let hi = data.length;
    const suffix = '... [truncated]';
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (byteLength(JSON.stringify(data.slice(0, mid) + suffix)) <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { data: data.slice(0, lo) + suffix, truncated: true };
  }

  // Numbers, booleans — can't truncate further
  return { data, truncated: false };
}

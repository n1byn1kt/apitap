// src/replay/truncate.ts

export interface TruncateOptions {
  maxBytes?: number; // default 50000 (50KB)
}

/** Structured truncation report. Present (truthy) only when data was cut. */
export interface TruncationInfo {
  originalBytes: number;
  finalBytes: number;
  /** Total array items removed, summed across all nesting levels. */
  droppedItems: number;
  /** Items surviving in the largest truncated array. */
  keptItems: number;
  note?: string;
}

export interface TruncateResult {
  data: unknown;
  truncated: TruncationInfo | false;
}

const DEFAULT_MAX_BYTES = 50_000;
const STRING_CAP = 500;
const MAX_DEPTH = 32;
const MIN_FIELD_BUDGET = 64;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function size(value: unknown): number {
  const s = JSON.stringify(value);
  return byteLength(s === undefined ? 'null' : s);
}

interface WalkStats {
  droppedItems: number;
  keptItems: number;
  note?: string;
}

function capString(value: string): string {
  return value.length > STRING_CAP ? value.slice(0, STRING_CAP) + '... [truncated]' : value;
}

/** Largest array length found anywhere in a value (schemaSample caps every array to <= 1). */
function maxArrayLength(value: unknown): number {
  if (Array.isArray(value)) {
    let max = value.length;
    for (const item of value) max = Math.max(max, maxArrayLength(item));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, maxArrayLength(v));
    }
    return max;
  }
  return 0;
}

/** Aggressive last-resort shape sample: structure survives, bulk does not. */
function schemaSample(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated: depth]';
  if (typeof value === 'string') return value.length > 100 ? value.slice(0, 100) + '... [truncated]' : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [schemaSample(value[0], depth + 1)];
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = schemaSample(v, depth + 1);
  }
  return out;
}

function truncateValue(value: unknown, budget: number, depth: number, stats: WalkStats): unknown {
  if (typeof value === 'string') return capString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[truncated: depth]';
  if (size(value) <= budget) return value;

  if (Array.isArray(value)) {
    // Largest prefix (>= 1 item) fitting the budget. Serialize each item
    // once and walk the exact cost down — JSON.stringify of an array is
    // '[' + items joined by ',' + ']', so prefix cost is computable without
    // re-serializing per drop (issue #61: the old pop loop was O(n²)).
    const itemSizes = value.map((item) => size(item));
    let keep = value.length;
    let cost = 2 + itemSizes.reduce((a, b) => a + b, 0) + Math.max(value.length - 1, 0);
    while (keep > 1 && cost > budget) {
      keep--;
      cost -= itemSizes[keep] + 1; // dropped item + its comma
    }
    const arr = value.slice(0, keep);
    stats.droppedItems += value.length - keep;
    if (arr.length >= 1 && size(arr) > budget) {
      // Single item still over budget: recurse into it, never drop to [].
      arr[0] = truncateValue(arr[0], Math.max(budget - 2, MIN_FIELD_BUDGET), depth + 1, stats);
      if (!stats.note) stats.note = 'single item exceeded budget; strings capped';
    }
    stats.keptItems = Math.max(stats.keptItems, arr.length);
    return arr;
  }

  // Object: recurse into dominant fields, largest first. Small scalar
  // fields are never dropped — they are the schema the agent needs.
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };
  const fields = Object.entries(record)
    .map(([k, v]) => ({ k, v, s: size(v) }))
    .sort((a, b) => b.s - a.s);
  for (const field of fields) {
    if (size(result) <= budget) break;
    if (typeof field.v === 'string') {
      result[field.k] = capString(field.v);
    } else if (field.v !== null && typeof field.v === 'object') {
      const others = size(result) - field.s;
      const fieldBudget = Math.max(budget - others, MIN_FIELD_BUDGET);
      result[field.k] = truncateValue(field.v, fieldBudget, depth + 1, stats);
    }
    // numbers/booleans/null: nothing to shrink
  }
  return result;
}

/**
 * Truncate a response to fit within maxBytes when serialized as JSON.
 *
 * Recursive budget-spending walk: recurses into whichever fields dominate
 * serialized size, drops array items from the end at any depth, and caps
 * long strings. Never returns an empty container for non-empty input —
 * worst case the caller gets one shape-sample item with capped strings.
 *
 * The result may overshoot maxBytes by per-level overhead; if it exceeds
 * 2 x maxBytes a schema-sample fallback replaces it. The fallback keeps
 * every key of a flat object, so a very wide object of small scalars can
 * still exceed the bound. Exact byte fitting is not a goal — honesty and
 * order-of-magnitude correctness are.
 */
export function truncateResponse(data: unknown, options?: TruncateOptions): TruncateResult {
  let maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) maxBytes = DEFAULT_MAX_BYTES;

  if (data === null || data === undefined) {
    return { data, truncated: false };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(data) ?? 'null';
  } catch {
    // Cyclic input (impossible for JSON.parse output) — return unmodified.
    return { data, truncated: false };
  }
  const originalBytes = byteLength(serialized);
  if (originalBytes <= maxBytes) {
    return { data, truncated: false };
  }

  // Top-level string: binary-search slice (cheap and exact).
  if (typeof data === 'string') {
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
    const sliced = data.slice(0, lo) + suffix;
    return {
      data: sliced,
      truncated: {
        originalBytes,
        finalBytes: byteLength(JSON.stringify(sliced)),
        droppedItems: 0,
        keptItems: 0,
      },
    };
  }

  if (typeof data !== 'object') {
    // Oversized number/boolean cannot exist; nothing to do.
    return { data, truncated: false };
  }

  const stats: WalkStats = { droppedItems: 0, keptItems: 0 };
  let result = truncateValue(data, maxBytes, 0, stats);

  // Safety net: bounded overshoot guarantee.
  if (size(result) > 2 * maxBytes) {
    result = schemaSample(data, 0);
    stats.note = 'response exceeded budget after truncation; schema sample returned';
    // The walk's dropped/kept counts describe the discarded truncateValue
    // attempt, not this sample — recompute honestly for the sample we
    // actually return. keptItems is the largest array surviving anywhere
    // in the sample (schemaSample caps every array to <= 1 element), not
    // just a top-level array — a nested array can survive even when the
    // top level is an object.
    stats.keptItems = maxArrayLength(result);
    if (Array.isArray(data)) {
      stats.droppedItems = Math.max(data.length - stats.keptItems, 0);
    }
  }

  return {
    data: result,
    truncated: {
      originalBytes,
      finalBytes: size(result),
      droppedItems: stats.droppedItems,
      keptItems: stats.keptItems,
      ...(stats.note ? { note: stats.note } : {}),
    },
  };
}

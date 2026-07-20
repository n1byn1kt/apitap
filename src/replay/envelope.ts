// src/replay/envelope.ts
import { truncateResponse, type TruncationInfo } from './truncate.js';

export interface CappedEnvelope<T> { envelope: T; envelopeBytes: number }

const MIN_DATA_BUDGET = 512;
/** Cap on truncate/build/serialize rounds during the budget bisection. */
const MAX_ROUNDS = 8;

/** Synthetic truncation info used only to size the skeleton (I2): the final
 * envelope always carries a `truncated` block once we start capping, so the
 * skeleton must include one or skeletonBytes under-counts the wrapper. */
const SKELETON_INFO: TruncationInfo = {
  originalBytes: 0,
  finalBytes: 0,
  droppedItems: 0,
  keptItems: 0,
  note: 'reduced to fit envelope budget',
};

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function appendNote(note: string | undefined, extra: string): string {
  if (!extra) return note ?? '';
  if (!note) return extra;
  // Dedupe: multi-signal notes must carry each phrase once.
  if (note === extra || note.endsWith(`; ${extra}`)) return note;
  return `${note}; ${extra}`;
}

function mergeInfo(first: TruncationInfo | false, second: TruncationInfo): TruncationInfo {
  const ENVELOPE_NOTE = 'reduced to fit envelope budget';
  if (!first) {
    // M3: keep second.note (e.g. schema-sample "fields dropped" signals).
    return { ...second, note: appendNote(second.note, ENVELOPE_NOTE) };
  }
  // M3: combine BOTH notes, then append the dedupe phrase to the combined text.
  const combined = second.note ? appendNote(first.note, second.note) : first.note;
  return {
    originalBytes: first.originalBytes,
    finalBytes: second.finalBytes,
    droppedItems: first.droppedItems + second.droppedItems,
    keptItems: second.keptItems,
    ...(first.droppedFields || second.droppedFields
      ? { droppedFields: (first.droppedFields ?? 0) + (second.droppedFields ?? 0) }
      : {}),
    note: appendNote(combined, ENVELOPE_NOTE),
  };
}

/**
 * Ensure the SERIALIZED envelope fits maxBytes by re-truncating data.
 *
 * The envelope skeleton (status, metadata, truncation info) is never dropped:
 * the data budget floors at MIN_DATA_BUDGET, so a pathological maxBytes smaller
 * than the skeleton itself yields a slightly-over envelope with honest metadata.
 *
 * Convergence is by BISECTION on the data budget, measured against the REAL
 * serialized output — not a fixed budget shave. A fixed shave caps out at a
 * bounded reduction (e.g. 40%), but indented serialization inflates the data
 * span 2-4x over the compact bytes truncateResponse targets, so a fixed shave
 * exits still over budget on ordinary payloads. Bisection searches
 * [MIN_DATA_BUDGET, maxBytes - skeletonBytes] for the largest data budget whose
 * serialized envelope fits maxBytes: truncate from the original data, build,
 * serialize, measure; if over, search lower; if under, keep the best-fitting
 * result and search higher (retain as much data as possible). Bounded to
 * MAX_ROUNDS truncate/serialize passes.
 *
 * The ONLY documented exception is the floor: if even MIN_DATA_BUDGET's
 * envelope overshoots (skeleton alone exceeds maxBytes), that overshooting
 * envelope is returned with honest metadata rather than dropping the skeleton.
 *
 * Placeholder caveat (grok P1-1): callers that patch a numeric `envelopeBytes`
 * field into the envelope after this returns should seed a placeholder at least
 * as wide as the final value's digit count. envelopeBytes here is the measured
 * width of what `serialize` produced; a 9-digit placeholder (e.g. 999_999_999)
 * only guarantees no width growth for maxBytes < 1e9 — fine in practice.
 */
export function capEnvelope<T>(
  build: (data: unknown, truncated: TruncationInfo | false) => T,
  data: unknown,
  firstTruncation: TruncationInfo | false,
  maxBytes: number | undefined,
  serialize: (envelope: T) => string,
): CappedEnvelope<T> {
  const passthrough = build(data, firstTruncation);
  const passthroughBytes = bytes(serialize(passthrough));
  if (!maxBytes || passthroughBytes <= maxBytes) {
    return { envelope: passthrough, envelopeBytes: passthroughBytes };
  }

  // Skeleton overhead: same serializer, data nulled out, truncated block
  // present (I2). Exact for the wrapper (indent included) — no compact-vs-
  // indented hybrid math (grok P1-1). The truncated block is always present
  // in the final capped envelope, so include it here.
  const skeletonBytes = bytes(serialize(build(null, SKELETON_INFO)));

  interface Candidate { envelope: T; size: number }
  const truncateAt = (budget: number): Candidate => {
    const result = truncateResponse(data, { maxBytes: budget });
    const info = result.truncated ? mergeInfo(firstTruncation, result.truncated) : firstTruncation;
    const envelope = build(result.data, info);
    return { envelope, size: bytes(serialize(envelope)) };
  };

  // Guaranteed fallback: the floor budget. May overshoot (documented exception).
  let best = truncateAt(MIN_DATA_BUDGET);
  let rounds = 1;

  // Bisect for the largest data budget that still fits, keeping more data.
  let lo = MIN_DATA_BUDGET + 1;
  let hi = maxBytes - skeletonBytes;
  while (lo <= hi && rounds < MAX_ROUNDS) {
    const mid = Math.floor((lo + hi) / 2);
    const cand = truncateAt(mid);
    rounds++;
    if (cand.size <= maxBytes) {
      best = cand;      // fits — retain more data by searching higher
      lo = mid + 1;
    } else {
      hi = mid - 1;     // over budget — search lower
    }
  }

  return { envelope: best.envelope, envelopeBytes: best.size };
}

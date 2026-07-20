import { describe, it } from 'node:test';
import assert from 'node:assert';
import { capEnvelope } from '../../src/replay/envelope.js';
import type { TruncationInfo } from '../../src/replay/truncate.js';

type Env = { status: number; data: unknown; truncated?: TruncationInfo | false; meta: string };
const build = (data: unknown, truncated: TruncationInfo | false): Env =>
  ({ status: 200, data, ...(truncated ? { truncated } : {}), meta: 'x'.repeat(200) });
const ser = (e: Env) => JSON.stringify(e, null, 2);
const serCompact = (e: Env) => JSON.stringify(e);

describe('capEnvelope', () => {
  it('no maxBytes: passes through and reports envelopeBytes', () => {
    const { envelope, envelopeBytes } = capEnvelope(build, { a: 1 }, false, undefined, ser);
    assert.deepEqual(envelope.data, { a: 1 });
    assert.equal(envelopeBytes, Buffer.byteLength(ser(envelope)));
  });

  it('under budget: unchanged data, accurate envelopeBytes', () => {
    const { envelope, envelopeBytes } = capEnvelope(build, { a: 1 }, false, 10_000, ser);
    assert.deepEqual(envelope.data, { a: 1 });
    assert.ok(envelopeBytes <= 10_000);
  });

  it('over budget: re-truncates data until serialized envelope fits', () => {
    const bigData = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'y'.repeat(100) }));
    const { envelope, envelopeBytes } = capEnvelope(build, bigData, false, 4_000, ser);
    assert.ok(envelopeBytes <= 4_000, `envelope ${envelopeBytes} > 4000`);
    assert.equal(Buffer.byteLength(ser(envelope)), envelopeBytes);
    assert.ok(envelope.truncated && envelope.truncated.droppedItems > 0);
  });

  it('merges first-pass truncation info: originalBytes preserved, note appended', () => {
    const first: TruncationInfo = { originalBytes: 4_624_971, finalBytes: 7_000, droppedItems: 68, keptItems: 1 };
    const stillBig = Array.from({ length: 60 }, (_, i) => ({ i, pad: 'z'.repeat(100) }));
    const { envelope } = capEnvelope(build, stillBig, first, 3_000, ser);
    assert.ok(envelope.truncated);
    assert.equal(envelope.truncated.originalBytes, 4_624_971);
    assert.match(envelope.truncated.note ?? '', /envelope/);
  });

  it('floors data budget at 512: tiny maxBytes yields envelope skeleton, may overshoot', () => {
    const bigData = Array.from({ length: 100 }, () => 'w'.repeat(200));
    const { envelope } = capEnvelope(build, bigData, false, 200, ser);
    // skeleton fields survive even though 200 bytes is impossible
    assert.equal(envelope.status, 200);
    assert.ok(envelope.truncated);
  });

  // Test addendum (grok P1-1): the cap must hold under BOTH serializers — the
  // indented CLI form (JSON.stringify(e, null, 2)) and the compact MCP form
  // (JSON.stringify(e)) — for a nested-array (gamma-class) payload. The
  // indented form is the adversarial case: skeletonBytes cannot see indent
  // inflation inside the data span, so this proves the shave-per-iteration and
  // no-progress terminator actually converge.
  describe('both serializers hold the cap (nested-array payload)', () => {
    // Gamma-class nested-array payload: full envelope is ~46 KB, ~6x the 8 KB
    // budget, forcing heavy re-truncation. The indented form is the adversarial
    // case (indent inflates the data span that skeletonBytes cannot see).
    const MAX = 8_000;
    const nested = Array.from({ length: 40 }, (_, i) => ({
      i,
      rows: Array.from({ length: 10 }, (_, j) => ({ j, pad: 'q'.repeat(50) })),
    }));

    for (const [name, s] of [['indented', ser], ['compact', serCompact]] as const) {
      it(`${name}: envelopeBytes <= maxBytes`, () => {
        const { envelope, envelopeBytes } = capEnvelope(build, nested, false, MAX, s);
        assert.ok(envelopeBytes <= MAX, `${name} envelope ${envelopeBytes} > ${MAX}`);
        assert.equal(Buffer.byteLength(s(envelope)), envelopeBytes);
        assert.ok(envelope.truncated && envelope.truncated.droppedItems > 0);
      });
    }

    it('indented: merge path also holds the cap', () => {
      const first: TruncationInfo = { originalBytes: 9_000_000, finalBytes: 40_000, droppedItems: 500, keptItems: 3 };
      const { envelope, envelopeBytes } = capEnvelope(build, nested, first, MAX, ser);
      assert.ok(envelopeBytes <= MAX, `indented merge envelope ${envelopeBytes} > ${MAX}`);
      assert.equal(envelope.truncated && envelope.truncated.originalBytes, 9_000_000);
      assert.match(envelope.truncated ? (envelope.truncated.note ?? '') : '', /envelope/);
    });
  });

  // Plateau case: this payload/budget combo tripped the (now-removed) eager
  // no-progress break and overshot the cap by ~6% under the indented serializer.
  // With the escalating-budget loop it must now fit — the harder budget of a
  // later iteration breaks through truncateResponse's step-function plateau.
  it('plateau payload that once overshot ~6% now fits under indented serializer', () => {
    const plateau = Array.from({ length: 80 }, (_, i) => ({ i, rows: Array.from({ length: 20 }, (_, j) => ({ j, pad: 'q'.repeat(60) })) }));
    const { envelope, envelopeBytes } = capEnvelope(build, plateau, false, 5_000, ser);
    assert.ok(envelopeBytes <= 5_000, `plateau envelope ${envelopeBytes} > 5000`);
    assert.equal(Buffer.byteLength(ser(envelope)), envelopeBytes);
    assert.ok(envelope.truncated && envelope.truncated.droppedItems > 0);
  });

  it('merged note carries the envelope-budget phrase exactly once after multiple rounds', () => {
    const first: TruncationInfo = { originalBytes: 9_000_000, finalBytes: 40_000, droppedItems: 500, keptItems: 3 };
    const stillBig = Array.from({ length: 80 }, (_, i) => ({ i, rows: Array.from({ length: 20 }, (_, j) => ({ j, pad: 'q'.repeat(60) })) }));
    const { envelope } = capEnvelope(build, stillBig, first, 5_000, ser);
    const note = envelope.truncated ? (envelope.truncated.note ?? '') : '';
    const occurrences = note.match(/reduced to fit envelope budget/g) ?? [];
    assert.equal(occurrences.length, 1, `phrase appeared ${occurrences.length}x in note: ${note}`);
  });

  // M4: adversarial payloads the fixed-shave loop failed to cap. Indented
  // serialization inflates the data span 2-4x over the compact bytes
  // truncateResponse targets, so a bounded shave exited over budget. Bisection
  // on measured serialized bytes must hold the cap for all three.
  describe('adversarial indent-inflation payloads hold the cap (indented serializer)', () => {
    const deepNest = (depth: number, breadth: number): unknown =>
      depth === 0
        ? { pad: 'q'.repeat(40) }
        : { k: Array.from({ length: breadth }, () => deepNest(depth - 1, breadth)) };

    const cases: [string, unknown, number][] = [
      ['flat 3000-int array @ 3000', Array.from({ length: 3000 }, (_, i) => i), 3_000],
      ['depth-6 breadth-3 nest @ 6000', deepNest(6, 3), 6_000],
      ['depth-5 breadth-4 nest @ 5000', deepNest(5, 4), 5_000],
    ];

    for (const [name, payload, max] of cases) {
      it(`${name}: envelopeBytes <= maxBytes`, () => {
        const { envelope, envelopeBytes } = capEnvelope(build, payload, false, max, ser);
        assert.ok(envelopeBytes <= max, `${name} envelope ${envelopeBytes} > ${max}`);
        assert.equal(Buffer.byteLength(ser(envelope)), envelopeBytes);
      });
    }
  });
});

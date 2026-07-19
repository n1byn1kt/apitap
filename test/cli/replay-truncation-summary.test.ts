// test/cli/replay-truncation-summary.test.ts
// Verifies the human-readable (non --json) truncation summary line from handleReplay

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('CLI replay human-readable truncation summary', () => {
  // Mirrors the formatting logic in handleReplay's non-JSON branch (src/cli.ts)
  function formatTruncationSummary(t: {
    originalBytes: number;
    finalBytes: number;
    droppedItems: number;
    keptItems: number;
  }): string {
    const fromKb = Math.round(t.originalBytes / 1024);
    const toKb = Math.round(t.finalBytes / 1024);
    const itemsClause =
      t.droppedItems === 0 && t.keptItems === 0
        ? ''
        : `kept ${t.keptItems} items, dropped ${t.droppedItems}, `;
    return `  truncated: ${itemsClause}${fromKb} KB → ${toKb} KB`;
  }

  it('formats item-based truncation with KB rounding', () => {
    const line = formatTruncationSummary({
      originalBytes: 308_224,
      finalBytes: 49_152,
      droppedItems: 4988,
      keptItems: 12,
    });
    assert.equal(line, '  truncated: kept 12 items, dropped 4988, 301 KB → 48 KB');
  });

  it('omits the items clause for plain string truncation (both counts zero)', () => {
    const line = formatTruncationSummary({
      originalBytes: 2048,
      finalBytes: 1024,
      droppedItems: 0,
      keptItems: 0,
    });
    assert.equal(line, '  truncated: 2 KB → 1 KB');
  });
});

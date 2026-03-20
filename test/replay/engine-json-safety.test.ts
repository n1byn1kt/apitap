import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeParseJson } from '../../src/replay/engine.js';

describe('safeParseJson', () => {
  it('parses valid JSON correctly', () => {
    const result = safeParseJson('{"key":"value","num":42}');
    assert.deepStrictEqual(result, { key: 'value', num: 42 });
  });

  it('returns raw text for invalid JSON (no throw)', () => {
    const bad = '{not valid json}';
    assert.strictEqual(safeParseJson(bad), bad);
  });

  it('returns raw text for truncated JSON', () => {
    const truncated = '{"key":"val';
    assert.strictEqual(safeParseJson(truncated), truncated);
  });

  it('parses empty array', () => {
    assert.deepStrictEqual(safeParseJson('[]'), []);
  });

  it('returns empty string as-is', () => {
    assert.strictEqual(safeParseJson(''), '');
  });
});

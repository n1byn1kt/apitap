import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfidenceHint, shouldOmitQueryParam } from '../../src/replay/engine.js';

describe('getConfidenceHint', () => {
  it('returns null for confidence >= 0.85', () => {
    assert.strictEqual(getConfidenceHint(0.85), null);
    assert.strictEqual(getConfidenceHint(1.0), null);
    assert.strictEqual(getConfidenceHint(undefined), null);
  });
  it('returns subtle hint for 0.7-0.84', () => {
    const hint = getConfidenceHint(0.75);
    assert.ok(hint && hint.includes('params may need adjustment'));
  });
  it('returns clear hint for < 0.7', () => {
    const hint = getConfidenceHint(0.6);
    assert.ok(hint && hint.includes('provide params explicitly'));
  });
});

describe('getConfidenceHint with provenance', () => {
  it('returns skeleton-specific hint for skeleton provenance', () => {
    const hint = getConfidenceHint(0.8, 'skeleton');
    assert.ok(hint);
    assert.ok(hint.includes('observed in traffic'));
    assert.ok(!hint.includes('imported from spec'));
  });

  it('returns import hint for openapi-import provenance', () => {
    const hint = getConfidenceHint(0.75, 'openapi-import');
    assert.ok(hint);
    assert.ok(hint.includes('imported from spec'));
  });

  it('backward compat: no provenance arg returns import hint', () => {
    const hint = getConfidenceHint(0.8);
    assert.ok(hint);
    assert.ok(hint.includes('imported from spec'));
  });
});

describe('shouldOmitQueryParam', () => {
  it('omits fromSpec param with empty example', () => {
    assert.strictEqual(shouldOmitQueryParam({ type: 'string', example: '', fromSpec: true }), true);
  });
  it('keeps fromSpec param with non-empty example', () => {
    assert.strictEqual(shouldOmitQueryParam({ type: 'string', example: 'test', fromSpec: true }), false);
  });
  it('keeps captured param even with empty example', () => {
    assert.strictEqual(shouldOmitQueryParam({ type: 'string', example: '' }), false);
  });
});

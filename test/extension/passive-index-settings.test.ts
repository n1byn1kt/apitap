import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSIVE_INDEX_DEFAULT_ENABLED,
  resolvePassiveIndexEnabled,
  canObservePassiveIndex,
} from '../../extension/src/passive-index-settings.js';

describe('passive index settings', () => {
  it('defaults passive indexing to disabled', () => {
    assert.equal(PASSIVE_INDEX_DEFAULT_ENABLED, false);
    assert.equal(resolvePassiveIndexEnabled(undefined), false);
    assert.equal(resolvePassiveIndexEnabled(null), false);
    assert.equal(resolvePassiveIndexEnabled(false), false);
  });

  it('enables passive indexing only for explicit true', () => {
    assert.equal(resolvePassiveIndexEnabled(true), true);
    assert.equal(resolvePassiveIndexEnabled('true'), false);
    assert.equal(resolvePassiveIndexEnabled(1), false);
  });

  it('requires enabled flag and tab context for observation', () => {
    assert.equal(canObservePassiveIndex(true, 10), true);
    assert.equal(canObservePassiveIndex(true, -1), false);
    assert.equal(canObservePassiveIndex(false, 10), false);
  });
});

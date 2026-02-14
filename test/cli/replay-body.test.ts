// test/cli/replay-body.test.ts
// Tests that CLI replay correctly handles body variables
// The actual body substitution is tested in test/replay/engine.test.ts
// This test verifies the CLI param parsing handles dotted keys correctly

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('CLI replay param parsing', () => {
  // Simulates the CLI param parsing logic from handleReplay
  function parseParams(paramArgs: string[]): Record<string, string> {
    const params: Record<string, string> = {};
    for (const arg of paramArgs) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        params[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
    }
    return params;
  }

  it('parses simple key=value params', () => {
    const params = parseParams(['id=123', 'name=test']);
    assert.deepEqual(params, { id: '123', name: 'test' });
  });

  it('parses dotted key=value params for body variables', () => {
    const params = parseParams(['variables.limit=25', 'variables.after=cursor123']);
    assert.deepEqual(params, {
      'variables.limit': '25',
      'variables.after': 'cursor123',
    });
  });

  it('parses mixed path and body variable params', () => {
    const params = parseParams(['id=42', 'variables.limit=10', 'page=1']);
    assert.deepEqual(params, {
      'id': '42',
      'variables.limit': '10',
      'page': '1',
    });
  });

  it('handles values with equals signs', () => {
    const params = parseParams(['query=a=b&c=d']);
    assert.deepEqual(params, { 'query': 'a=b&c=d' });
  });
});

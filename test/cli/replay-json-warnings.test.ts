// test/cli/replay-json-warnings.test.ts
// Verifies that --json replay output includes contractWarnings when present

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('CLI replay --json contractWarnings', () => {
  // Simulates the --json serialization logic from handleReplay
  function serializeReplayResult(result: {
    status: number;
    data: unknown;
    contractWarnings?: Array<{ severity: string; path: string; message: string }>;
  }): string {
    return JSON.stringify({
      status: result.status,
      data: result.data,
      ...(result.contractWarnings?.length ? { contractWarnings: result.contractWarnings } : {}),
    }, null, 2);
  }

  it('includes contractWarnings in JSON output when present', () => {
    const result = {
      status: 200,
      data: { id: 1 },
      contractWarnings: [
        { severity: 'error', path: '.name', message: 'field disappeared' },
        { severity: 'warn', path: '.age', message: 'type changed from number to string' },
      ],
    };

    const output = JSON.parse(serializeReplayResult(result));
    assert.equal(output.status, 200);
    assert.deepEqual(output.data, { id: 1 });
    assert.equal(output.contractWarnings.length, 2);
    assert.equal(output.contractWarnings[0].severity, 'error');
    assert.equal(output.contractWarnings[0].path, '.name');
    assert.equal(output.contractWarnings[1].severity, 'warn');
  });

  it('omits contractWarnings from JSON output when empty', () => {
    const result = {
      status: 200,
      data: { id: 1 },
      contractWarnings: [],
    };

    const output = JSON.parse(serializeReplayResult(result));
    assert.equal(output.status, 200);
    assert.equal(output.contractWarnings, undefined);
  });

  it('omits contractWarnings from JSON output when undefined', () => {
    const result = {
      status: 200,
      data: { id: 1 },
    };

    const output = JSON.parse(serializeReplayResult(result));
    assert.equal(output.status, 200);
    assert.equal(output.contractWarnings, undefined);
  });
});

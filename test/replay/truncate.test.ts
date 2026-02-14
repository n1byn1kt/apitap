import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncateResponse } from '../../src/replay/truncate.js';

describe('truncateResponse', () => {
  describe('under limit', () => {
    it('returns data as-is when under maxBytes', () => {
      const data = { name: 'test', value: 42 };
      const result = truncateResponse(data, { maxBytes: 50_000 });
      assert.deepStrictEqual(result.data, data);
      assert.strictEqual(result.truncated, false);
    });

    it('returns small array as-is', () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = truncateResponse(data, { maxBytes: 50_000 });
      assert.deepStrictEqual(result.data, data);
      assert.strictEqual(result.truncated, false);
    });
  });

  describe('array truncation', () => {
    it('removes items from end to fit under limit', () => {
      // Create array that's ~100KB
      const items = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        title: `Post ${i}`,
        body: 'x'.repeat(400),
      }));

      const serialized = JSON.stringify(items);
      assert.ok(Buffer.byteLength(serialized) > 50_000, 'test data should exceed 50KB');

      const result = truncateResponse(items, { maxBytes: 50_000 });
      assert.strictEqual(result.truncated, true);

      const truncatedBytes = Buffer.byteLength(JSON.stringify(result.data));
      assert.ok(truncatedBytes <= 50_000, `should be under 50KB, got ${truncatedBytes}`);
      assert.ok(Array.isArray(result.data));
      assert.ok((result.data as unknown[]).length < items.length);
      assert.ok((result.data as unknown[]).length > 0);
    });

    it('truncates string fields when single item exceeds limit', () => {
      const items = [{
        id: 1,
        content: 'x'.repeat(100_000),
        description: 'y'.repeat(50_000),
      }];

      const result = truncateResponse(items, { maxBytes: 50_000 });
      assert.strictEqual(result.truncated, true);

      const truncatedBytes = Buffer.byteLength(JSON.stringify(result.data));
      assert.ok(truncatedBytes <= 50_000, `should be under 50KB, got ${truncatedBytes}`);

      const item = (result.data as any[])[0];
      assert.ok(item.content.endsWith('... [truncated]'));
      assert.ok(item.description.endsWith('... [truncated]'));
      assert.strictEqual(item.id, 1);
    });
  });

  describe('object truncation', () => {
    it('truncates long string fields largest-first', () => {
      const data = {
        id: 42,
        title: 'Short title',
        body: 'z'.repeat(60_000),
        summary: 'w'.repeat(30_000),
      };

      const result = truncateResponse(data, { maxBytes: 50_000 });
      assert.strictEqual(result.truncated, true);

      const truncatedBytes = Buffer.byteLength(JSON.stringify(result.data));
      assert.ok(truncatedBytes <= 50_000, `should be under 50KB, got ${truncatedBytes}`);

      const obj = result.data as Record<string, unknown>;
      assert.strictEqual(obj.id, 42);
      assert.strictEqual(obj.title, 'Short title');
      assert.ok((obj.body as string).endsWith('... [truncated]'));
    });
  });

  describe('null/undefined data', () => {
    it('returns null as-is', () => {
      const result = truncateResponse(null, { maxBytes: 50_000 });
      assert.strictEqual(result.data, null);
      assert.strictEqual(result.truncated, false);
    });

    it('returns undefined as-is', () => {
      const result = truncateResponse(undefined, { maxBytes: 50_000 });
      assert.strictEqual(result.data, undefined);
      assert.strictEqual(result.truncated, false);
    });
  });

  describe('defaults', () => {
    it('uses 50KB default when no maxBytes specified', () => {
      const data = { body: 'x'.repeat(60_000) };
      const result = truncateResponse(data);
      assert.strictEqual(result.truncated, true);
    });

    it('does not truncate small data with default maxBytes', () => {
      const data = { name: 'test' };
      const result = truncateResponse(data);
      assert.strictEqual(result.truncated, false);
    });
  });

  describe('edge cases', () => {
    it('handles empty array', () => {
      const result = truncateResponse([], { maxBytes: 100 });
      assert.deepStrictEqual(result.data, []);
      assert.strictEqual(result.truncated, false);
    });

    it('handles empty object', () => {
      const result = truncateResponse({}, { maxBytes: 100 });
      assert.deepStrictEqual(result.data, {});
      assert.strictEqual(result.truncated, false);
    });

    it('handles string data over limit', () => {
      const data = 'x'.repeat(100_000);
      const result = truncateResponse(data, { maxBytes: 1_000 });
      assert.strictEqual(result.truncated, true);
      assert.ok((result.data as string).endsWith('... [truncated]'));
      assert.ok(Buffer.byteLength(JSON.stringify(result.data)) <= 1_000);
    });

    it('handles number data (cannot truncate)', () => {
      const result = truncateResponse(42, { maxBytes: 1 });
      assert.strictEqual(result.data, 42);
      assert.strictEqual(result.truncated, false);
    });
  });
});

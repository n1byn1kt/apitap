import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSchema } from '../../src/contract/schema.js';

describe('snapshotSchema', () => {
  it('handles primitive types', () => {
    assert.deepEqual(snapshotSchema('hello'), { type: 'string' });
    assert.deepEqual(snapshotSchema(42), { type: 'number' });
    assert.deepEqual(snapshotSchema(true), { type: 'boolean' });
    assert.deepEqual(snapshotSchema(null), { type: 'null', nullable: true });
  });

  it('handles flat objects', () => {
    const schema = snapshotSchema({ id: 1, name: 'foo', active: true });
    assert.deepEqual(schema, {
      type: 'object',
      fields: {
        id: { type: 'number' },
        name: { type: 'string' },
        active: { type: 'boolean' },
      },
    });
  });

  it('handles arrays with uniform elements', () => {
    const schema = snapshotSchema([{ id: 1 }, { id: 2 }]);
    assert.deepEqual(schema, {
      type: 'array',
      items: {
        type: 'object',
        fields: { id: { type: 'number' } },
      },
    });
  });

  it('handles nested objects', () => {
    const schema = snapshotSchema({
      user: { id: 1, profile: { name: 'foo' } },
    });
    assert.deepEqual(schema, {
      type: 'object',
      fields: {
        user: {
          type: 'object',
          fields: {
            id: { type: 'number' },
            profile: {
              type: 'object',
              fields: { name: { type: 'string' } },
            },
          },
        },
      },
    });
  });

  it('handles empty arrays', () => {
    assert.deepEqual(snapshotSchema([]), { type: 'array' });
  });

  it('handles null fields as nullable', () => {
    const schema = snapshotSchema({ name: null });
    assert.deepEqual(schema, {
      type: 'object',
      fields: { name: { type: 'null', nullable: true } },
    });
  });

  it('caps depth at 5 levels', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const schema = snapshotSchema(deep);
    // At depth 5, should stop recursing and use primitive type
    const level5 = schema.fields!.a.fields!.b.fields!.c.fields!.d.fields!.e;
    assert.equal(level5.type, 'object');
    assert.equal(level5.fields, undefined); // stopped recursing
  });

  it('samples first element of arrays', () => {
    const schema = snapshotSchema([
      { id: 1, name: 'a', extra: true },
      { id: 2, name: 'b' },
    ]);
    // Should use first element's schema
    assert.ok(schema.items?.fields?.id);
    assert.ok(schema.items?.fields?.name);
    assert.ok(schema.items?.fields?.extra);
  });

  it('handles mixed-type arrays', () => {
    const schema = snapshotSchema([1, 'hello', true]);
    // First element determines type
    assert.equal(schema.type, 'array');
    assert.equal(schema.items?.type, 'number');
  });
});

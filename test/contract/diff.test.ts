import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffSchema } from '../../src/contract/diff.js';
import type { SchemaNode } from '../../src/contract/schema.js';

describe('diffSchema', () => {
  it('returns empty array for identical schemas', () => {
    const schema: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'number' }, name: { type: 'string' } },
    };
    const warnings = diffSchema(schema, schema);
    assert.deepEqual(warnings, []);
  });

  it('reports missing fields as error', () => {
    const expected: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'number' }, name: { type: 'string' } },
    };
    const actual: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'number' } },
    };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'error');
    assert.equal(warnings[0].path, 'name');
    assert.ok(warnings[0].message.includes('disappeared'));
  });

  it('reports new fields as info', () => {
    const expected: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'number' } },
    };
    const actual: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'number' }, newField: { type: 'string' } },
    };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'info');
    assert.equal(warnings[0].path, 'newField');
    assert.ok(warnings[0].message.includes('new field'));
  });

  it('reports type changes as warn', () => {
    const expected: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'number' } },
    };
    const actual: SchemaNode = {
      type: 'object',
      fields: { id: { type: 'string' } },
    };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warn');
    assert.equal(warnings[0].path, 'id');
    assert.ok(warnings[0].message.includes('type changed'));
  });

  it('reports field becoming nullable as warn', () => {
    const expected: SchemaNode = {
      type: 'object',
      fields: { name: { type: 'string' } },
    };
    const actual: SchemaNode = {
      type: 'object',
      fields: { name: { type: 'null', nullable: true } },
    };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warn');
    assert.ok(warnings[0].message.includes('nullable') || warnings[0].message.includes('type changed'));
  });

  it('handles nested field changes', () => {
    const expected: SchemaNode = {
      type: 'object',
      fields: {
        user: {
          type: 'object',
          fields: { name: { type: 'string' }, age: { type: 'number' } },
        },
      },
    };
    const actual: SchemaNode = {
      type: 'object',
      fields: {
        user: {
          type: 'object',
          fields: { name: { type: 'string' } },
        },
      },
    };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'error');
    assert.equal(warnings[0].path, 'user.age');
  });

  it('handles array item schema changes', () => {
    const expected: SchemaNode = {
      type: 'array',
      items: { type: 'object', fields: { id: { type: 'number' } } },
    };
    const actual: SchemaNode = {
      type: 'array',
      items: { type: 'object', fields: { id: { type: 'string' } } },
    };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].path, '[].id');
    assert.equal(warnings[0].severity, 'warn');
  });

  it('handles top-level type change', () => {
    const expected: SchemaNode = { type: 'object', fields: {} };
    const actual: SchemaNode = { type: 'array' };
    const warnings = diffSchema(expected, actual);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warn');
    assert.equal(warnings[0].path, '');
  });

  it('handles both schemas having no fields', () => {
    const expected: SchemaNode = { type: 'object' };
    const actual: SchemaNode = { type: 'object' };
    assert.deepEqual(diffSchema(expected, actual), []);
  });
});

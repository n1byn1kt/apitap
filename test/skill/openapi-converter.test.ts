import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRef } from '../../src/skill/openapi-converter.js';

describe('resolveRef', () => {
  it('resolves a simple $ref like #/components/schemas/User', () => {
    const spec = {
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
            },
          },
        },
      },
    };

    const result = resolveRef({ $ref: '#/components/schemas/User' }, spec);

    assert.deepEqual(result, spec.components.schemas.User);
  });

  it('returns input unchanged if no $ref present', () => {
    const spec = {};
    const obj = { type: 'string', description: 'A plain string' };

    const result = resolveRef(obj, spec);

    assert.deepEqual(result, obj);
  });

  it('returns null on circular $ref (A -> B -> A)', () => {
    const spec = {
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/A' },
        },
      },
    };

    const result = resolveRef({ $ref: '#/components/schemas/A' }, spec);

    assert.equal(result, null);
  });

  it('handles deeply nested $ref chain (9 levels deep, within limit)', () => {
    // Build a chain: Level1 -> Level2 -> ... -> Level9 -> { type: 'string' }
    const spec: Record<string, any> = { components: { schemas: {} } };
    const schemas = spec.components.schemas;

    schemas['Level9'] = { type: 'string', description: 'leaf' };
    for (let i = 8; i >= 1; i--) {
      schemas[`Level${i}`] = { $ref: `#/components/schemas/Level${i + 1}` };
    }

    const result = resolveRef({ $ref: '#/components/schemas/Level1' }, spec);

    assert.deepEqual(result, { type: 'string', description: 'leaf' });
  });

  it('merges allOf properties from multiple entries', () => {
    const spec = {
      components: {
        schemas: {
          Base: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
            },
            required: ['id'],
          },
          Extra: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
            description: 'Extra fields',
          },
        },
      },
    };

    const result = resolveRef(
      {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { $ref: '#/components/schemas/Extra' },
        ],
      },
      spec,
    );

    assert.equal(result?.type, 'object');
    assert.ok(result?.properties?.id, 'should have id from Base');
    assert.ok(result?.properties?.name, 'should have name from Extra');
    assert.deepEqual(result?.required, ['id', 'name']);
    assert.equal(result?.description, 'Extra fields');
  });

  it('returns null for $ref pointing to nonexistent path', () => {
    const spec = {
      components: {
        schemas: {},
      },
    };

    const result = resolveRef({ $ref: '#/components/schemas/DoesNotExist' }, spec);

    assert.equal(result, null);
  });
});

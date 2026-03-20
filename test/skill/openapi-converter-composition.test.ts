import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRef } from '../../src/skill/openapi-converter.js';

describe('oneOf/anyOf handling', () => {
  it('uses first option from oneOf', () => {
    const spec = {
      components: { schemas: {
        Response: {
          oneOf: [
            { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } },
            { type: 'object', properties: { error: { type: 'string' } } },
          ],
        },
      }},
    };
    const result = resolveRef({ $ref: '#/components/schemas/Response' }, spec);
    assert.strictEqual(result.type, 'object');
    assert.ok(result.properties.id);
  });

  it('uses first option from anyOf', () => {
    const spec = {
      components: { schemas: {
        Payload: {
          anyOf: [
            { type: 'object', properties: { data: { type: 'array' } } },
            { type: 'string' },
          ],
        },
      }},
    };
    const result = resolveRef({ $ref: '#/components/schemas/Payload' }, spec);
    assert.strictEqual(result.type, 'object');
    assert.ok(result.properties.data);
  });

  it('handles oneOf with $ref entries', () => {
    const spec = {
      components: { schemas: {
        Cat: { type: 'object', properties: { purrs: { type: 'boolean' } } },
        Dog: { type: 'object', properties: { barks: { type: 'boolean' } } },
        Pet: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] },
      }},
    };
    const result = resolveRef({ $ref: '#/components/schemas/Pet' }, spec);
    assert.ok(result.properties.purrs);
  });
});

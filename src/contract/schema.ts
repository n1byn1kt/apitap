// src/contract/schema.ts
import type { SchemaNode } from '../types.js';

export type { SchemaNode };

const MAX_DEPTH = 5;

/**
 * Snapshot the schema of a JSON value.
 * Produces a lightweight recursive type tree for contract validation.
 * Arrays sample the first element. Caps recursion at 5 levels.
 */
export function snapshotSchema(data: unknown, depth = 0): SchemaNode {
  if (data === null) {
    return { type: 'null', nullable: true };
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { type: 'array' };
    }
    return {
      type: 'array',
      items: snapshotSchema(data[0], depth + 1),
    };
  }

  if (typeof data === 'object') {
    if (depth >= MAX_DEPTH) {
      return { type: 'object' };
    }
    const fields: Record<string, SchemaNode> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      fields[key] = snapshotSchema(value, depth + 1);
    }
    return { type: 'object', fields };
  }

  if (typeof data === 'string') return { type: 'string' };
  if (typeof data === 'number') return { type: 'number' };
  if (typeof data === 'boolean') return { type: 'boolean' };

  return { type: 'string' }; // fallback
}

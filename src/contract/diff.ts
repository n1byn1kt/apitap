// src/contract/diff.ts
import type { SchemaNode } from '../types.js';

export interface ContractWarning {
  severity: 'info' | 'warn' | 'error';
  path: string;
  message: string;
}

/**
 * Diff two schema snapshots and produce contract warnings.
 *
 * Severity levels:
 * - info: new field appeared (additive, not breaking)
 * - warn: field type changed, field became nullable
 * - error: field disappeared (breaking)
 */
export function diffSchema(
  expected: SchemaNode,
  actual: SchemaNode,
  path = '',
): ContractWarning[] {
  const warnings: ContractWarning[] = [];

  // Top-level type mismatch
  if (expected.type !== actual.type) {
    if (actual.type === 'null') {
      warnings.push({
        severity: 'warn',
        path,
        message: `type changed: ${expected.type} → null (became nullable)`,
      });
    } else {
      warnings.push({
        severity: 'warn',
        path,
        message: `type changed: ${expected.type} → ${actual.type}`,
      });
    }
    return warnings; // Can't recurse into mismatched types
  }

  // Object fields
  if (expected.type === 'object' && expected.fields && actual.fields) {
    // Check for disappeared fields
    for (const key of Object.keys(expected.fields)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actual.fields)) {
        warnings.push({
          severity: 'error',
          path: childPath,
          message: `field disappeared: ${key} was ${expected.fields[key].type}`,
        });
      } else {
        // Recurse into shared fields
        warnings.push(...diffSchema(expected.fields[key], actual.fields[key], childPath));
      }
    }

    // Check for new fields
    for (const key of Object.keys(actual.fields)) {
      if (!expected.fields || !(key in expected.fields)) {
        const childPath = path ? `${path}.${key}` : key;
        warnings.push({
          severity: 'info',
          path: childPath,
          message: `new field: ${key} (${actual.fields[key].type})`,
        });
      }
    }
  }

  // Array items
  if (expected.type === 'array' && expected.items && actual.items) {
    const itemPath = path ? `${path}[]` : '[]';
    warnings.push(...diffSchema(expected.items, actual.items, itemPath));
  }

  return warnings;
}

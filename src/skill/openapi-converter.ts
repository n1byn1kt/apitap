// src/skill/openapi-converter.ts
import type { SkillEndpoint, ImportResult, ImportMeta, RequestBody } from '../types.js';

/**
 * Resolve a JSON $ref pointer in an OpenAPI spec.
 * Uses a visited set to detect cycles and a depth limit as safety net.
 */
export function resolveRef(
  obj: any,
  spec: Record<string, any>,
  visited: Set<string> = new Set(),
  depth: number = 0,
): any {
  if (!obj || typeof obj !== 'object') return obj;

  // Handle allOf composition: merge properties from all entries
  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged: Record<string, any> = { type: 'object', properties: {} };
    for (const entry of obj.allOf) {
      const resolved = resolveRef(entry, spec, new Set(visited), depth + 1);
      if (resolved?.properties) {
        Object.assign(merged.properties, resolved.properties);
      }
      if (resolved?.required) {
        merged.required = [...(merged.required || []), ...resolved.required];
      }
      if (resolved?.description && !merged.description) {
        merged.description = resolved.description;
      }
    }
    return merged;
  }

  if (!obj.$ref) return obj;

  const ref = obj.$ref as string;
  if (visited.has(ref)) return null; // cycle detected
  if (depth > 10) return null;       // depth safety net

  visited.add(ref);

  const refPath = ref.replace('#/', '').split('/');
  let resolved: any = spec;
  for (const segment of refPath) {
    resolved = resolved?.[segment];
    if (resolved === undefined) return null;
  }

  // Recursively resolve if the resolved object also has $ref or allOf
  return resolveRef(resolved, spec, visited, depth + 1);
}

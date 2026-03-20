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

export function extractDomainAndBasePath(
  spec: Record<string, any>,
  specUrl: string,
): { domain: string; basePath: string } {
  const serverUrl = spec.servers?.[0]?.url;
  if (serverUrl) {
    try {
      const parsed = new URL(serverUrl);
      return { domain: parsed.hostname, basePath: parsed.pathname.replace(/\/$/, '') };
    } catch {
      if (serverUrl.startsWith('/')) {
        const domain = spec.info?.['x-providerName'] || new URL(specUrl).hostname;
        return { domain, basePath: serverUrl.replace(/\/$/, '') };
      }
    }
  }
  if (spec.host) {
    return { domain: spec.host, basePath: (spec.basePath || '').replace(/\/$/, '') };
  }
  try {
    return { domain: new URL(specUrl).hostname, basePath: '' };
  } catch {
    return { domain: 'unknown', basePath: '' };
  }
}

export interface ConfidenceInput {
  method: string;
  hasExamples: boolean;
  requiresAuth: boolean;
}

export function computeConfidence(input: ConfidenceInput): number {
  let score = 0.6;
  if (input.hasExamples) score += 0.1;
  if (!input.requiresAuth) score += 0.1;
  if (input.method === 'GET') score += 0.05;
  return Math.min(score, 0.85);
}

export type AuthType = 'apiKey' | 'oauth2' | 'bearer' | 'basic' | 'openIdConnect';

export function detectAuth(spec: Record<string, any>): { requiresAuth: boolean; authType?: AuthType } {
  const schemes = spec.components?.securitySchemes || {};
  const defs = spec.securityDefinitions || {};
  const allSchemes = { ...schemes, ...defs };
  const security = spec.security || [];

  if (Object.keys(allSchemes).length === 0 && security.length === 0) {
    return { requiresAuth: false };
  }

  let authType: AuthType | undefined;
  for (const scheme of Object.values(allSchemes) as any[]) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') { authType = 'bearer'; break; }
    if (scheme.type === 'http' && scheme.scheme === 'basic') { authType = 'basic'; break; }
    if (scheme.type === 'apiKey') { authType = 'apiKey'; break; }
    if (scheme.type === 'oauth2') { authType = 'oauth2'; break; }
    if (scheme.type === 'openIdConnect') { authType = 'openIdConnect'; break; }
  }

  return { requiresAuth: true, authType };
}

export function generateEndpointId(
  method: string,
  path: string,
  operationId: string | undefined,
  seen: Set<string>,
): string {
  let base: string;
  if (operationId) {
    base = `${method.toLowerCase()}-${operationId.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
  } else {
    const segments = path.split('/').filter(s => s !== '' && !s.startsWith(':')).join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'root';
    base = `${method.toLowerCase()}-${segments}`;
  }
  base = base.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  let id = base;
  let counter = 2;
  while (seen.has(id)) {
    id = `${base}-${counter}`.slice(0, 80);
    counter++;
  }
  seen.add(id);
  return id;
}

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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
const MAX_ENDPOINTS = 500;

/**
 * Detect whether a parsed JSON object is an OpenAPI/Swagger spec.
 * Returns false for SkillFile objects (which have version+domain+baseUrl+endpoints).
 */
export function isOpenAPISpec(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;

  // SkillFile check: if it looks like a SkillFile, it's not an OpenAPI spec
  if (o.version && o.domain && o.baseUrl && Array.isArray(o.endpoints)) {
    return false;
  }

  // OpenAPI 3.x or Swagger 2.0
  if (typeof o.openapi === 'string' || typeof o.swagger === 'string') {
    return true;
  }

  return false;
}

/**
 * Extract response shape (type + top-level field names) from an OpenAPI response schema.
 */
function extractResponseShape(
  responses: Record<string, any> | undefined,
  spec: Record<string, any>,
): { type: string; fields?: string[] } {
  if (!responses) return { type: 'unknown' };

  // Try 200, then 201, then first 2xx
  const responseObj =
    responses['200'] || responses['201'] ||
    Object.entries(responses).find(([k]) => k.startsWith('2'))?.[1];
  if (!responseObj) return { type: 'unknown' };

  const resolved = resolveRef(responseObj, spec);
  if (!resolved) return { type: 'unknown' };

  // OpenAPI 3.x: content -> application/json -> schema
  let schema = resolved.content?.['application/json']?.schema;
  // Swagger 2.0: schema directly on response
  if (!schema && resolved.schema) schema = resolved.schema;
  if (!schema) return { type: 'unknown' };

  schema = resolveRef(schema, spec);
  if (!schema) return { type: 'unknown' };

  const type = schema.type === 'array' ? 'array' : schema.type === 'object' ? 'object' : (schema.type || 'unknown');
  const fields: string[] = [];

  if (schema.properties) {
    fields.push(...Object.keys(schema.properties));
  } else if (schema.type === 'array' && schema.items) {
    const items = resolveRef(schema.items, spec);
    if (items?.properties) {
      fields.push(...Object.keys(items.properties));
    }
  }

  return fields.length > 0 ? { type, fields } : { type };
}

/**
 * Extract request body template for POST/PUT/PATCH from an OpenAPI operation.
 */
function extractRequestBody(
  operation: Record<string, any>,
  spec: Record<string, any>,
): RequestBody | undefined {
  // OpenAPI 3.x: requestBody -> content -> application/json -> schema
  let schema: any;
  let contentType = 'application/json';

  if (operation.requestBody) {
    const body = resolveRef(operation.requestBody, spec);
    if (!body) return undefined;
    const jsonContent = body.content?.['application/json'];
    if (jsonContent?.schema) {
      schema = resolveRef(jsonContent.schema, spec);
    } else {
      // Try first content type
      const firstKey = body.content ? Object.keys(body.content)[0] : undefined;
      if (firstKey && body.content[firstKey]?.schema) {
        contentType = firstKey;
        schema = resolveRef(body.content[firstKey].schema, spec);
      }
    }
  }

  // Swagger 2.0: parameters with in=body
  if (!schema && operation.parameters) {
    const bodyParam = operation.parameters.find((p: any) => p.in === 'body');
    if (bodyParam?.schema) {
      schema = resolveRef(bodyParam.schema, spec);
    }
  }

  if (!schema) return undefined;

  const template: Record<string, unknown> = {};
  const variables: string[] = [];

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
      const resolvedProp = resolveRef(prop, spec) || prop;
      if (resolvedProp.example !== undefined) {
        template[key] = resolvedProp.example;
      } else if (resolvedProp.default !== undefined) {
        template[key] = resolvedProp.default;
      } else {
        template[key] = `{{${key}}}`;
        variables.push(key);
      }
    }
  }

  return {
    contentType,
    template: Object.keys(template).length > 0 ? template : '{{body}}',
    ...(variables.length > 0 ? { variables } : {}),
  };
}

/**
 * Convert an OpenAPI 3.x or Swagger 2.0 spec into an ImportResult.
 */
export function convertOpenAPISpec(
  spec: Record<string, any>,
  specUrl: string,
): ImportResult {
  const { domain, basePath } = extractDomainAndBasePath(spec, specUrl);
  const { requiresAuth, authType } = detectAuth(spec);
  const specVersion: 'openapi3' | 'swagger2' = spec.swagger ? 'swagger2' : 'openapi3';

  const endpoints: SkillEndpoint[] = [];
  const seenIds = new Set<string>();
  const paths = spec.paths || {};

  for (const [pathKey, pathItem] of Object.entries(paths) as [string, any][]) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      // Collect all parameters (path-level + operation-level)
      const allParams: any[] = [
        ...(pathItem.parameters || []),
        ...(operation.parameters || []),
      ];

      // Convert path: {param} -> :param, prepend basePath
      const convertedPath = basePath + pathKey.replace(/\{([^}]+)\}/g, ':$1');

      // Extract query params
      const queryParams: SkillEndpoint['queryParams'] = {};
      for (const param of allParams) {
        const resolved = resolveRef(param, spec) || param;
        if (resolved.in === 'query') {
          const paramSchema = resolved.schema ? (resolveRef(resolved.schema, spec) || resolved.schema) : resolved;
          const example = resolved.example ?? paramSchema?.example ?? paramSchema?.default ?? '';
          queryParams[resolved.name] = {
            type: paramSchema?.type || 'string',
            example: example !== '' ? String(example) : '',
            fromSpec: true,
            ...(resolved.required ? { required: true } : {}),
            ...(paramSchema?.enum ? { enum: paramSchema.enum } : {}),
          };
        }
      }

      // Extract path param examples for the example URL
      const pathParamExamples: Record<string, string> = {};
      let hasExamples = false;
      for (const param of allParams) {
        const resolved = resolveRef(param, spec) || param;
        if (resolved.in === 'path') {
          const paramSchema = resolved.schema ? (resolveRef(resolved.schema, spec) || resolved.schema) : resolved;
          const example = resolved.example ?? paramSchema?.example ?? paramSchema?.default;
          if (example !== undefined) {
            pathParamExamples[resolved.name] = String(example);
            hasExamples = true;
          }
        }
      }

      // Check if query params have examples too
      if (!hasExamples) {
        for (const qp of Object.values(queryParams)) {
          if (qp.example !== '') { hasExamples = true; break; }
        }
      }

      // Build example URL
      let examplePath = basePath + pathKey;
      // Substitute path params with examples
      for (const [name, value] of Object.entries(pathParamExamples)) {
        examplePath = examplePath.replace(`{${name}}`, value);
      }
      // Replace remaining unsubstituted path params with placeholder
      examplePath = examplePath.replace(/\{([^}]+)\}/g, ':$1');

      // Add non-empty query params to URL
      const queryEntries = Object.entries(queryParams).filter(([, v]) => v.example !== '');
      const queryString = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.example)}`).join('&');
      const exampleUrl = `https://${domain}${examplePath}${queryString ? '?' + queryString : ''}`;

      // Extract response shape
      const responseShape = extractResponseShape(operation.responses, spec);

      // Extract request body for write methods
      const methodUpper = method.toUpperCase();
      let requestBody: RequestBody | undefined;
      if (['POST', 'PUT', 'PATCH'].includes(methodUpper)) {
        requestBody = extractRequestBody(operation, spec);
      }

      // Description
      const description = operation.summary || operation.description || undefined;

      // Generate endpoint ID
      const id = generateEndpointId(method, convertedPath, operation.operationId, seenIds);

      // Compute confidence
      const confidence = computeConfidence({
        method: methodUpper,
        hasExamples,
        requiresAuth,
      });

      const endpoint: SkillEndpoint = {
        id,
        method: methodUpper,
        path: convertedPath,
        queryParams,
        headers: {},
        responseShape,
        examples: {
          request: { url: exampleUrl, headers: {} },
          responsePreview: null,
        },
        confidence,
        endpointProvenance: 'openapi-import',
        specSource: specUrl,
        ...(description ? { description } : {}),
        ...(requestBody ? { requestBody } : {}),
      };

      endpoints.push(endpoint);
    }
  }

  // Sort by confidence descending, then truncate
  endpoints.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  if (endpoints.length > MAX_ENDPOINTS) {
    process.stderr.write(
      `[openapi-import] Warning: spec has ${endpoints.length} endpoints, truncating to ${MAX_ENDPOINTS}\n`,
    );
    endpoints.length = MAX_ENDPOINTS;
  }

  const meta: ImportMeta = {
    specUrl,
    specVersion,
    title: spec.info?.title || '',
    description: spec.info?.description || '',
    requiresAuth,
    ...(authType ? { authType } : {}),
    endpointCount: endpoints.length,
  };

  return { domain, endpoints, meta };
}

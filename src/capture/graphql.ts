// src/capture/graphql.ts

export interface GraphQLParsed {
  operationName: string | null;
  query: string;
  variables: Record<string, unknown> | null;
}

/**
 * Check whether a string looks like a GraphQL document rather than a plain
 * search term. Search APIs (e.g. Algolia) also send `{"query": "<text>"}`.
 * Accepts shorthand `{ ... }` and `query|mutation|subscription|fragment`,
 * optionally preceded by `#` comment lines.
 */
export function looksLikeGraphQLDocument(query: string): boolean {
  const body = query.replace(/^(?:\s*#[^\n]*(?:\n|$))*/, '').trimStart();
  return /^(?:\{|(?:query|mutation|subscription|fragment)\b)/.test(body);
}

/**
 * Detect if a request is to a GraphQL endpoint.
 */
export function isGraphQLEndpoint(
  path: string,
  contentType: string,
  body: string | null,
): boolean {
  // Path contains /graphql
  if (path.includes('/graphql')) {
    return true;
  }

  // Content-Type is application/graphql
  if (contentType.includes('application/graphql')) {
    return true;
  }

  // Body contains a "query" field holding a GraphQL document
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.query === 'string' && looksLikeGraphQLDocument(parsed.query)) {
        return true;
      }
    } catch {
      // Not JSON
    }
  }

  return false;
}

/**
 * Parse a GraphQL request body.
 */
export function parseGraphQLBody(body: string): GraphQLParsed | null {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.query !== 'string' || !looksLikeGraphQLDocument(parsed.query)) {
      return null;
    }
    return {
      operationName: parsed.operationName ?? null,
      query: parsed.query,
      variables: parsed.variables ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Extract operation name from query string or explicit operationName.
 */
export function extractOperationName(
  query: string,
  explicitName: string | null,
): string {
  if (explicitName) {
    return explicitName;
  }

  // Match "query Name" or "mutation Name" at start
  const match = query.match(/^\s*(query|mutation|subscription)\s+(\w+)/);
  if (match) {
    return match[2];
  }

  return 'Anonymous';
}

/**
 * Detect which variables are likely dynamic (IDs, cursors, pagination).
 */
export function detectGraphQLVariables(
  variables: Record<string, unknown> | null,
  prefix = '',
): string[] {
  if (!variables || typeof variables !== 'object') {
    return [];
  }

  const detected: string[] = [];

  for (const [key, value] of Object.entries(variables)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'number') {
      // Numbers are often IDs or pagination values
      detected.push(path);
    } else if (typeof value === 'string') {
      // Cursor-like strings (base64, long alphanumeric)
      if (isLikelyCursor(value)) {
        detected.push(path);
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      detected.push(...detectGraphQLVariables(value as Record<string, unknown>, path));
    }
  }

  return detected;
}

function isLikelyCursor(value: string): boolean {
  // Base64-ish: long alphanumeric, possibly with = padding
  if (value.length > 10 && /^[a-zA-Z0-9+/=_-]+$/.test(value)) {
    return true;
  }
  // UUID-like
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  return false;
}

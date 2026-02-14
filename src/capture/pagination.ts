// src/capture/pagination.ts
import type { PaginationInfo } from '../types.js';

const OFFSET_PARAMS = new Set(['offset', 'skip']);
const CURSOR_PARAMS = new Set(['cursor', 'after', 'before', 'next_cursor', 'starting_after']);
const PAGE_PARAMS = new Set(['page', 'p', 'page_number']);
const LIMIT_PARAMS = new Set(['limit', 'per_page', 'page_size', 'count', 'size']);

/**
 * Detect pagination patterns from query parameters.
 * Returns null if no pagination pattern is detected.
 */
export function detectPagination(
  queryParams: Record<string, { type: string; example: string }>,
): PaginationInfo | null {
  const paramNames = Object.keys(queryParams);
  const limitParam = paramNames.find(p => LIMIT_PARAMS.has(p.toLowerCase()));

  // Check offset-based (offset/skip + optional limit)
  for (const name of paramNames) {
    if (OFFSET_PARAMS.has(name.toLowerCase())) {
      return {
        type: 'offset',
        paramName: name,
        ...(limitParam ? { limitParam } : {}),
      };
    }
  }

  // Check cursor-based
  for (const name of paramNames) {
    if (CURSOR_PARAMS.has(name.toLowerCase())) {
      return { type: 'cursor', paramName: name };
    }
  }

  // Check page-based
  for (const name of paramNames) {
    if (PAGE_PARAMS.has(name.toLowerCase())) {
      return {
        type: 'page',
        paramName: name,
        ...(limitParam && limitParam !== name ? { limitParam } : {}),
      };
    }
  }

  return null;
}

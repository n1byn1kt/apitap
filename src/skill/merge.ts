// src/skill/merge.ts
import type { SkillFile, SkillEndpoint, ImportMeta, MergeResult } from '../types.js';

/**
 * Normalize a parameterized path by replacing all named param placeholders
 * with the generic `:_` placeholder, enabling matching across different param
 * naming conventions (e.g. `:id` vs `:userId` vs `:user_id`).
 *
 * @example
 *   normalizePath('/repos/:owner/:repo') // → '/repos/:_/:_'
 *   normalizePath('/users/list')          // → '/users/list'
 */
export function normalizePath(path: string): string {
  return path.replace(/:[a-zA-Z_]\w*/g, ':_');
}

/**
 * Build a match key for endpoint deduplication: METHOD + normalized path.
 */
function matchKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/**
 * Merge query params from a captured endpoint with params from an imported
 * spec endpoint.
 *
 * Rules:
 * - Captured `example` values are preserved (captured data is sacred).
 * - Spec `type`, `required`, `enum` augment the captured params.
 * - New params that only exist in the spec are added wholesale.
 */
function mergeQueryParams(
  captured: SkillEndpoint['queryParams'],
  specParams: SkillEndpoint['queryParams'],
): SkillEndpoint['queryParams'] {
  const merged = { ...captured };

  for (const [name, specParam] of Object.entries(specParams)) {
    if (name in merged) {
      // Param exists in captured — keep captured example, augment with spec metadata
      const existing = merged[name];
      merged[name] = {
        ...existing,
        // Take spec type only if captured has generic 'string' and spec is more specific
        type: existing.type === 'string' && specParam.type !== 'string' ? specParam.type : existing.type,
        // Always preserve captured example value
        example: existing.example,
        // Add spec enum if present
        ...(specParam.enum !== undefined ? { enum: specParam.enum } : {}),
        // Add spec required flag if present
        ...(specParam.required !== undefined ? { required: specParam.required } : {}),
        // Mark as also coming from spec
        ...(specParam.fromSpec ? { fromSpec: true } : {}),
      };
    } else {
      // New param only in spec — add it
      merged[name] = specParam;
    }
  }

  return merged;
}

/**
 * Determine whether an imported endpoint would enrich an existing captured
 * endpoint (i.e. adds new metadata not already present).
 */
function wouldEnrich(existing: SkillEndpoint, imported: SkillEndpoint): boolean {
  if (!existing.description && imported.description) return true;
  if (!existing.specSource && imported.specSource) return true;

  // Check if any new query params would be added or enriched
  for (const [name, specParam] of Object.entries(imported.queryParams)) {
    if (!(name in existing.queryParams)) return true;
    const ep = existing.queryParams[name];
    if (!ep.enum && specParam.enum) return true;
    if (ep.required === undefined && specParam.required !== undefined) return true;
    if (ep.type === 'string' && specParam.type !== 'string') return true;
  }

  return false;
}

/**
 * Determine whether an imported endpoint would enrich an existing skeleton
 * endpoint. Skeletons are enrichable by imports: imports can provide response
 * shape (replacing the placeholder `{ type: 'unknown' }`), description,
 * specSource, and query param metadata.
 */
function wouldEnrichSkeleton(existing: SkillEndpoint, imported: SkillEndpoint): boolean {
  // Import can replace an unknown response shape
  const existingShape = existing.responseShape;
  const isUnknownShape = existingShape.type === 'unknown' && !existingShape.fields;
  if (isUnknownShape && imported.responseShape.type !== 'unknown') return true;

  if (!existing.description && imported.description) return true;
  if (!existing.specSource && imported.specSource) return true;

  // Check if any new query params would be added or enriched
  for (const [name, specParam] of Object.entries(imported.queryParams)) {
    if (!(name in existing.queryParams)) return true;
    const ep = existing.queryParams[name];
    if (!ep.enum && specParam.enum) return true;
    if (ep.required === undefined && specParam.required !== undefined) return true;
    if (ep.type === 'string' && specParam.type !== 'string') return true;
  }

  return false;
}

/**
 * Pure function — no I/O.
 *
 * Merges imported OpenAPI endpoints into an existing skill file.
 *
 * Captured data is sacred: it always wins on confidence, examples, and
 * endpoint provenance. Spec data can only enrich (add description, specSource,
 * query param enum/required/type) or fill gaps (add missing endpoints).
 *
 * Match logic: METHOD + normalizePath(path). This allows `:owner` and `:user`
 * to be considered the same parameter slot.
 *
 * @param existing  The existing skill file on disk, or null if none exists.
 * @param imported  Endpoints parsed from the OpenAPI spec.
 * @param importMeta  Metadata about the import (spec URL, version, etc.).
 * @returns MergeResult with the updated SkillFile and a diff summary.
 */
export function mergeSkillFile(
  existing: SkillFile | null,
  imported: SkillEndpoint[],
  importMeta: ImportMeta,
): MergeResult {
  const now = new Date().toISOString();

  let preserved = 0;
  let added = 0;
  let enriched = 0;
  let skipped = 0;

  // --- Case: no existing file — create a new SkillFile from imported endpoints ---
  if (existing === null) {
    let endpoints = imported.map(ep => ({
      ...ep,
      normalizedPath: normalizePath(ep.path),
    }));
    if (endpoints.length > 500) {
      endpoints = endpoints.slice(0, 500);
    }

    const skillFile: SkillFile = {
      version: '1.2',
      domain: extractDomainFromMeta(importMeta),
      capturedAt: now,
      baseUrl: extractBaseUrlFromMeta(importMeta),
      endpoints,
      metadata: {
        captureCount: 0,
        filteredCount: 0,
        toolVersion: '1.0.0',
        importHistory: [{
          specUrl: importMeta.specUrl,
          specVersion: importMeta.specVersion,
          importedAt: now,
          endpointsAdded: endpoints.length,
          endpointsEnriched: 0,
        }],
      },
      provenance: 'imported',
    };

    added = endpoints.length;

    return {
      skillFile,
      diff: { preserved, added, enriched, skipped },
    };
  }

  // --- Case: existing file present — merge into it ---

  // Build a map from match-key → existing endpoint (mutable copy)
  const existingMap = new Map<string, SkillEndpoint>();
  for (const ep of existing.endpoints) {
    existingMap.set(matchKey(ep.method, ep.path), ep);
  }

  // Build a map from match-key → imported endpoint
  const importedMap = new Map<string, SkillEndpoint>();
  for (const ep of imported) {
    const key = matchKey(ep.method, ep.path);
    // If multiple imported endpoints map to the same key, last wins
    if (importedMap.has(key)) {
      process.stderr.write(`[openapi-import] Warning: ${ep.method} ${ep.path} collides with existing import after normalization\n`);
    }
    importedMap.set(key, ep);
  }

  // Process: update or preserve existing endpoints
  const resultEndpoints: SkillEndpoint[] = [];

  for (const [key, existingEp] of existingMap) {
    const importedEp = importedMap.get(key);

    if (!importedEp) {
      // Not in import — preserve as-is (captured endpoint with no match in spec)
      resultEndpoints.push({
        ...existingEp,
        normalizedPath: normalizePath(existingEp.path),
      });
      preserved++;
      continue;
    }

    // --- Skeleton branch: import can enrich skeleton endpoints ---
    if (existingEp.endpointProvenance === 'skeleton') {
      if (!wouldEnrichSkeleton(existingEp, importedEp)) {
        resultEndpoints.push({
          ...existingEp,
          normalizedPath: normalizePath(existingEp.path),
        });
        const existingHasSpecData = !!(existingEp.specSource || existingEp.description);
        const importHasSpecData = !!(importedEp.specSource || importedEp.description);
        if (existingHasSpecData || importHasSpecData) {
          skipped++;
        } else {
          preserved++;
        }
        continue;
      }

      const mergedQueryParams = mergeQueryParams(existingEp.queryParams, importedEp.queryParams);

      // For skeletons, import can replace responseShape if existing is unknown
      const existingShape = existingEp.responseShape;
      const isUnknownShape = existingShape.type === 'unknown' && !existingShape.fields;
      const responseShape = isUnknownShape && importedEp.responseShape.type !== 'unknown'
        ? importedEp.responseShape
        : existingShape;

      const enrichedSkeleton: SkillEndpoint = {
        ...existingEp,
        normalizedPath: normalizePath(existingEp.path),
        responseShape,
        // Augment with spec fields (only if not already present)
        ...(importedEp.description && !existingEp.description ? { description: importedEp.description } : {}),
        ...(importedEp.specSource && !existingEp.specSource ? { specSource: importedEp.specSource } : {}),
        // Confidence = max(skeleton, import)
        confidence: Math.max(existingEp.confidence ?? 0, importedEp.confidence ?? 0) || existingEp.confidence,
        // Provenance stays 'skeleton'
        endpointProvenance: 'skeleton',
        queryParams: mergedQueryParams,
      };

      resultEndpoints.push(enrichedSkeleton);
      enriched++;
      continue;
    }

    // Imported endpoint matches an existing one — check if it would add anything new
    if (!wouldEnrich(existingEp, importedEp)) {
      resultEndpoints.push({
        ...existingEp,
        normalizedPath: normalizePath(existingEp.path),
      });
      // "skipped" means the import is redundant — existing already has spec metadata.
      // "preserved" means the captured endpoint is untouched (import had nothing for it,
      // or both sides are bare with no spec data to exchange).
      const existingHasSpecData = !!(existingEp.specSource || existingEp.description);
      const importHasSpecData = !!(importedEp.specSource || importedEp.description);
      if (existingHasSpecData || importHasSpecData) {
        // Spec data was already integrated (or import tried to add it but it's already present)
        skipped++;
      } else {
        // Neither side has spec enrichment data — captured endpoint simply preserved
        preserved++;
      }
      continue;
    }

    // Enrich the captured endpoint with spec metadata
    const mergedQueryParams = mergeQueryParams(existingEp.queryParams, importedEp.queryParams);

    const enrichedEp: SkillEndpoint = {
      ...existingEp,
      normalizedPath: normalizePath(existingEp.path),
      // Augment with spec fields (only if not already present)
      ...(importedEp.description && !existingEp.description ? { description: importedEp.description } : {}),
      ...(importedEp.specSource && !existingEp.specSource ? { specSource: importedEp.specSource } : {}),
      // Confidence never downgrades
      confidence: Math.max(existingEp.confidence ?? 0, importedEp.confidence ?? 0) || existingEp.confidence,
      // Keep captured provenance
      endpointProvenance: existingEp.endpointProvenance,
      queryParams: mergedQueryParams,
    };

    resultEndpoints.push(enrichedEp);
    enriched++;
  }

  // Add endpoints from import that don't exist in the existing file
  for (const [key, importedEp] of importedMap) {
    if (!existingMap.has(key)) {
      resultEndpoints.push({
        ...importedEp,
        normalizedPath: normalizePath(importedEp.path),
      });
      added++;
    }
  }

  // Cap at MAX_ENDPOINTS after merge — keep captured/high-confidence first
  const MAX_ENDPOINTS = 500;
  if (resultEndpoints.length > MAX_ENDPOINTS) {
    const overflow = resultEndpoints.length - MAX_ENDPOINTS;
    resultEndpoints.sort((a, b) => {
      // Captured endpoints always win over imported
      const aIsCaptured = !a.endpointProvenance || a.endpointProvenance === 'captured';
      const bIsCaptured = !b.endpointProvenance || b.endpointProvenance === 'captured';
      if (aIsCaptured !== bIsCaptured) return aIsCaptured ? -1 : 1;
      // Then by confidence descending
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
    resultEndpoints.length = MAX_ENDPOINTS;
    process.stderr.write(
      `[openapi-import] Warning: merged result has ${MAX_ENDPOINTS + overflow} endpoints, truncated to ${MAX_ENDPOINTS}\n`,
    );
  }

  // Build updated import history
  const prevHistory = existing.metadata.importHistory ?? [];
  const newHistoryEntry = {
    specUrl: importMeta.specUrl,
    specVersion: importMeta.specVersion,
    importedAt: now,
    endpointsAdded: added,
    endpointsEnriched: enriched,
  };

  const skillFile: SkillFile = {
    ...existing,
    endpoints: resultEndpoints,
    metadata: {
      ...existing.metadata,
      importHistory: [...prevHistory, newHistoryEntry],
    },
  };

  return {
    skillFile,
    diff: { preserved, added, enriched, skipped },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractDomainFromMeta(meta: ImportMeta): string {
  try {
    return new URL(meta.specUrl).hostname;
  } catch {
    throw new Error(`Cannot determine domain from specUrl: ${meta.specUrl}`);
  }
}

function extractBaseUrlFromMeta(meta: ImportMeta): string {
  try {
    const u = new URL(meta.specUrl);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    throw new Error(`Cannot determine base URL from specUrl: ${meta.specUrl}`);
  }
}

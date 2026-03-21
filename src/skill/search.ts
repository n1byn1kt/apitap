// src/skill/search.ts
import { ensureIndex } from './index.js';

export interface SearchResult {
  domain: string;
  endpointId: string;
  method: string;
  path: string;
  tier: string;
  verified: boolean;
}

export interface SearchResponse {
  found: boolean;
  results?: SearchResult[];
  suggestion?: string;
}

/**
 * Search skill files for endpoints matching a query.
 * Uses the search index for sub-second results.
 * Matches against domain names, endpoint IDs, and endpoint paths.
 * Query terms are matched case-insensitively.
 */
export async function searchSkills(
  query: string,
  skillsDir?: string,
): Promise<SearchResponse> {
  const index = await ensureIndex(skillsDir);

  const domainCount = Object.keys(index.domains).length;
  if (domainCount === 0) {
    return {
      found: false,
      suggestion: 'No skill files found. Run `apitap capture <url>` to capture API traffic first.',
    };
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  for (const [domain, entry] of Object.entries(index.domains)) {
    const domainLower = domain.toLowerCase();
    const domainMatches = terms.some(term => domainLower.includes(term));

    for (const ep of entry.endpoints) {
      const endpointIdLower = ep.id.toLowerCase();
      const pathLower = ep.path.toLowerCase();
      const methodLower = ep.method.toLowerCase();

      const searchText = `${domainLower} ${endpointIdLower} ${pathLower} ${methodLower}`;
      const allMatch = domainMatches
        ? terms.every(term => searchText.includes(term))
        : terms.every(term => searchText.includes(term));

      if (allMatch) {
        results.push({
          domain,
          endpointId: ep.id,
          method: ep.method,
          path: ep.path,
          tier: ep.tier ?? 'unknown',
          verified: ep.verified ?? false,
        });
      }
    }
  }

  if (results.length === 0) {
    const domains = Object.keys(index.domains).join(', ');
    return {
      found: false,
      suggestion: `No matches for "${query}". Available domains: ${domains}`,
    };
  }

  return { found: true, results };
}

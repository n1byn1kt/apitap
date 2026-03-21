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
  summary?: string;
  suggestion?: string;
}

/**
 * Check if a search term matches a target string.
 * Supports prefix matching: "payment" matches "payments", "pay" matches "payouts".
 */
function termMatches(term: string, text: string): boolean {
  // Check if any word in the text starts with the term (prefix match)
  // Split on word boundaries: slashes, hyphens, underscores, dots, spaces
  const words = text.split(/[\s/\-_.]+/);
  for (const word of words) {
    if (word.startsWith(term)) return true;
  }
  // Also check plain substring for multi-word or partial path matches
  return text.includes(term);
}

/**
 * Search skill files for endpoints matching a query.
 * Uses the search index for sub-second results.
 * Matches against domain names, endpoint IDs, and endpoint paths.
 * Query terms are matched case-insensitively with prefix matching.
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
  const matchedDomains = new Set<string>();

  for (const [domain, entry] of Object.entries(index.domains)) {
    const domainLower = domain.toLowerCase();

    for (const ep of entry.endpoints) {
      const endpointIdLower = ep.id.toLowerCase();
      const pathLower = ep.path.toLowerCase();
      const methodLower = ep.method.toLowerCase();

      const searchText = `${domainLower} ${endpointIdLower} ${pathLower} ${methodLower}`;
      const allMatch = terms.every(term => termMatches(term, searchText));

      if (allMatch) {
        matchedDomains.add(domain);
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
      summary: '0 endpoints across 0 domains',
      suggestion: `No matches for "${query}". Available domains: ${domains}`,
    };
  }

  const summary = `${results.length} endpoints across ${matchedDomains.size} domain${matchedDomains.size === 1 ? '' : 's'}`;
  return { found: true, results, summary };
}

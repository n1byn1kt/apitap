// src/skill/search.ts
import { listSkillFiles, readSkillFile } from './store.js';

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
 * Matches against domain names, endpoint IDs, and endpoint paths.
 * Query terms are matched case-insensitively.
 */
export async function searchSkills(
  query: string,
  skillsDir?: string,
): Promise<SearchResponse> {
  const summaries = await listSkillFiles(skillsDir);
  if (summaries.length === 0) {
    return {
      found: false,
      suggestion: 'No skill files found. Run `apitap capture <url>` to capture API traffic first.',
    };
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  for (const summary of summaries) {
    const skill = await readSkillFile(summary.domain, skillsDir);
    if (!skill) continue;

    const domainLower = skill.domain.toLowerCase();

    for (const ep of skill.endpoints) {
      const endpointIdLower = ep.id.toLowerCase();
      const pathLower = ep.path.toLowerCase();
      const methodLower = ep.method.toLowerCase();

      // Check if all query terms match against the combined searchable text
      const searchText = `${domainLower} ${endpointIdLower} ${pathLower} ${methodLower}`;
      const allMatch = terms.every(term => searchText.includes(term));

      if (allMatch) {
        results.push({
          domain: skill.domain,
          endpointId: ep.id,
          method: ep.method,
          path: ep.path,
          tier: ep.replayability?.tier ?? 'unknown',
          verified: ep.replayability?.verified ?? false,
        });
      }
    }
  }

  if (results.length === 0) {
    const domains = summaries.map(s => s.domain).join(', ');
    return {
      found: false,
      suggestion: `No matches for "${query}". Available domains: ${domains}`,
    };
  }

  return { found: true, results };
}

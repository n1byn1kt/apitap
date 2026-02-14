import type { SkillFile, SkillEndpoint } from '../types.js';
import { readSkillFile } from '../skill/store.js';
import { replayEndpoint } from '../replay/engine.js';
import { SessionCache } from './cache.js';
import { read } from '../read/index.js';

export interface BrowseOptions {
  skillsDir?: string;
  cache?: SessionCache;
  task?: string;
  skipDiscovery?: boolean;
  /** Maximum response size in bytes. Default: 50000 */
  maxBytes?: number;
  /** @internal Skip SSRF check — for testing only */
  _skipSsrfCheck?: boolean;
}

export interface BrowseSuccess {
  success: true;
  data: unknown;
  status: number;
  domain: string;
  endpointId: string;
  tier: string;
  fromCache: boolean;
  capturedAt: string;
  task?: string;
  truncated?: boolean;
}

export interface BrowseGuidance {
  success: false;
  reason: string;
  discoveryConfidence?: string;
  suggestion: string;
  domain: string;
  url: string;
  task?: string;
}

export type BrowseResult = BrowseSuccess | BrowseGuidance;

/**
 * High-level browse: check cache → disk → discover → replay.
 * Auto-escalates cheap steps. Returns guidance for expensive ones.
 */
export async function browse(
  url: string,
  options: BrowseOptions = {},
): Promise<BrowseResult> {
  const { cache, skillsDir, task, skipDiscovery, maxBytes = 50_000 } = options;
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;

  let domain: string;
  let urlPath: string;
  try {
    const parsed = new URL(fullUrl);
    domain = parsed.hostname;
    urlPath = parsed.pathname;
  } catch {
    return {
      success: false,
      reason: 'invalid_url',
      suggestion: 'provide_valid_url',
      domain: '',
      url: fullUrl,
      task,
    };
  }

  // Step 1: Check session cache
  let skill: SkillFile | null = null;
  let source: 'disk' | 'discovered' | 'captured' = 'disk';

  if (cache?.has(domain)) {
    skill = cache.get(domain)!.skillFile;
    source = cache.get(domain)!.source;
  }

  // Step 2: Check disk
  if (!skill) {
    skill = await readSkillFile(domain, skillsDir);
    if (skill) {
      source = 'disk';
      cache?.set(domain, skill, 'disk');
    }
  }

  // Step 3: Try discovery
  if (!skill && !skipDiscovery) {
    try {
      const { discover } = await import('../discovery/index.js');
      const discovery = await discover(fullUrl);

      if (discovery.skillFile && discovery.skillFile.endpoints.length > 0 &&
          (discovery.confidence === 'high' || discovery.confidence === 'medium')) {
        skill = discovery.skillFile;
        source = 'discovered';

        // Save to disk
        const { writeSkillFile: writeSF } = await import('../skill/store.js');
        await writeSF(skill, skillsDir);
        cache?.set(domain, skill, 'discovered');
      } else {
        // Discovery didn't produce usable endpoints — try text-mode read
        try {
          const readResult = await read(fullUrl, { maxBytes });
          if (readResult && readResult.content.trim().length > 0 && readResult.metadata.source !== 'spa-shell') {
            return {
              success: true,
              data: readResult,
              status: 200,
              domain,
              endpointId: 'read',
              tier: 'green',
              fromCache: false,
              capturedAt: new Date().toISOString(),
              task,
            };
          }
        } catch {
          // Read failed — fall through to capture_needed
        }
        return {
          success: false,
          reason: 'no_replayable_endpoints',
          discoveryConfidence: discovery.confidence,
          suggestion: 'capture_needed',
          domain,
          url: fullUrl,
          task,
        };
      }
    } catch {
      // Discovery failed — fall through to guidance
    }
  }

  // No skill file at all — try text-mode read before giving up
  if (!skill) {
    if (!skipDiscovery) {
      try {
        const readResult = await read(fullUrl, { maxBytes });
        if (readResult && readResult.content.trim().length > 0 && readResult.metadata.source !== 'spa-shell') {
          return {
            success: true,
            data: readResult,
            status: 200,
            domain,
            endpointId: 'read',
            tier: 'green',
            fromCache: false,
            capturedAt: new Date().toISOString(),
            task,
          };
        }
      } catch {
        // Read failed — fall through to capture_needed
      }
    }
    return {
      success: false,
      reason: 'no_skill_file',
      suggestion: 'capture_needed',
      domain,
      url: fullUrl,
      task,
    };
  }

  // Step 4: Pick best endpoint
  const endpoint = pickEndpoint(skill, urlPath);
  if (!endpoint) {
    return {
      success: false,
      reason: 'no_replayable_endpoints',
      suggestion: 'capture_needed',
      domain,
      url: fullUrl,
      task,
    };
  }

  // Step 5: Replay
  try {
    const result = await replayEndpoint(skill, endpoint.id, { maxBytes, _skipSsrfCheck: options._skipSsrfCheck });
    const fromCache = source === 'disk';

    // Check content-type: HTML responses are not usable API data
    const contentType = result.headers['content-type'] ?? '';
    if (contentType.includes('text/html')) {
      return {
        success: false,
        reason: 'non_api_response',
        discoveryConfidence: source === 'discovered' ? 'medium' : undefined,
        suggestion: 'capture_needed',
        domain,
        url: fullUrl,
        task,
      };
    }

    return {
      success: true,
      data: result.data,
      status: result.status,
      domain,
      endpointId: endpoint.id,
      tier: endpoint.replayability?.tier ?? 'unknown',
      fromCache,
      capturedAt: skill.capturedAt,
      task,
      ...(result.truncated ? { truncated: true } : {}),
    };
  } catch {
    return {
      success: false,
      reason: 'replay_failed',
      suggestion: 'capture_needed',
      domain,
      url: fullUrl,
      task,
    };
  }
}

const REPLAYABLE_TIERS = new Set(['green', 'yellow', 'unknown']);

/**
 * Pick the best endpoint to replay. Prefers:
 * 1. GET endpoints with green/yellow/unknown tier
 * 2. Path overlap with the input URL
 * 3. First match as fallback
 */
function pickEndpoint(skill: SkillFile, urlPath: string): SkillEndpoint | null {
  const candidates = skill.endpoints.filter(ep =>
    ep.method === 'GET' &&
    REPLAYABLE_TIERS.has(ep.replayability?.tier ?? 'unknown'),
  );

  if (candidates.length === 0) return null;

  // Prefer path overlap
  if (urlPath && urlPath !== '/') {
    const match = candidates.find(ep => urlPath.includes(ep.path) || ep.path.includes(urlPath));
    if (match) return match;
  }

  return candidates[0];
}

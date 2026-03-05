import type { SkillFile, SkillEndpoint } from '../types.js';
import { readSkillFile } from '../skill/store.js';
import { replayEndpoint } from '../replay/engine.js';
import { SessionCache } from './cache.js';
import { read } from '../read/index.js';
import { bridgeAvailable, requestBridgeCapture, DEFAULT_SOCKET } from '../bridge/client.js';

export interface BrowseOptions {
  skillsDir?: string;
  cache?: SessionCache;
  task?: string;
  skipDiscovery?: boolean;
  /** Maximum response size in bytes. Default: 50000 */
  maxBytes?: number;
  /** @internal Skip SSRF check — for testing only */
  _skipSsrfCheck?: boolean;
  /** @internal Override bridge socket path — for testing only */
  _bridgeSocketPath?: string;
  /** @internal Override bridge timeout — for testing only */
  _bridgeTimeout?: number;
}

export interface BrowseSuccess {
  success: true;
  data: unknown;
  status: number;
  domain: string;
  endpointId: string;
  tier: string;
  skillSource: 'disk' | 'discovered' | 'captured' | 'bridge';
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
 * Try escalating to the Chrome extension bridge for authenticated capture.
 * Returns a BrowseResult if the bridge handled it, or null to fall through.
 */
async function tryBridgeCapture(
  domain: string,
  fullUrl: string,
  options: BrowseOptions,
): Promise<BrowseResult | null> {
  const socketPath = options._bridgeSocketPath ?? DEFAULT_SOCKET;
  if (!await bridgeAvailable(socketPath)) return null;

  const result = await requestBridgeCapture(domain, socketPath, { timeout: options._bridgeTimeout });

  if (result.success && result.skillFiles && result.skillFiles.length > 0) {
    const skillFiles = result.skillFiles;
    // Save each skill file to disk
    try {
      const { writeSkillFile: writeSF } = await import('../skill/store.js');
      for (const skill of skillFiles) {
        await writeSF(skill, options.skillsDir);
      }
    } catch {
      // Saving failed — still have the data in memory
    }

    // Find the skill file matching the requested domain
    const primarySkill = skillFiles.find((s: any) => s.domain === domain)
      ?? skillFiles[0];

    if (primarySkill?.endpoints?.length > 0) {
      // Pick the best endpoint and replay it
      let urlPath = '/';
      try { urlPath = new URL(fullUrl).pathname; } catch { /* use default */ }
      const endpoint = pickEndpoint(primarySkill, urlPath);

      if (endpoint) {
        try {
          const replayResult = await replayEndpoint(primarySkill, endpoint.id, {
            maxBytes: options.maxBytes,
            _skipSsrfCheck: options._skipSsrfCheck,
          });
          if (replayResult.status >= 200 && replayResult.status < 300) {
            return {
              success: true,
              data: replayResult.data,
              status: replayResult.status,
              domain,
              endpointId: endpoint.id,
              tier: endpoint.replayability?.tier ?? 'unknown',
              skillSource: 'bridge',
              capturedAt: primarySkill.capturedAt ?? new Date().toISOString(),
              task: options.task,
              ...(replayResult.truncated ? { truncated: true } : {}),
            };
          }
        } catch {
          // Replay failed — but skill file is saved for next time
        }
      }
    }

    // Skill file saved but replay didn't work
    return {
      success: false,
      reason: 'bridge_capture_saved',
      suggestion: `Captured ${skillFiles.length} skill file(s) from browser. Replay failed — try 'apitap replay ${domain}'.`,
      domain,
      url: fullUrl,
      task: options.task,
    };
  }

  // Bridge returned an error
  if (result.error === 'user_denied') {
    return {
      success: false,
      reason: 'user_denied',
      suggestion: `User denied browser access to ${domain}. Use 'apitap auth request ${domain}' for manual login instead.`,
      domain,
      url: fullUrl,
      task: options.task,
    };
  }

  if (result.error === 'approval_timeout') {
    return {
      success: false,
      reason: 'approval_timeout',
      suggestion: `User approval pending for ${domain}. Click Allow in the ApiTap extension and try again.`,
      domain,
      url: fullUrl,
      task: options.task,
    };
  }

  // Other bridge errors — fall through to existing fallback
  return null;
}

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
              skillSource: 'discovered',
              capturedAt: new Date().toISOString(),
              task,
            };
          }
        } catch {
          // Read failed — fall through to capture_needed
        }
        // Try extension bridge before giving up
        const bridgeResult1 = await tryBridgeCapture(domain, fullUrl, options);
        if (bridgeResult1) return bridgeResult1;

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
            skillSource: 'discovered',
            capturedAt: new Date().toISOString(),
            task,
          };
        }
      } catch {
        // Read failed — fall through to capture_needed
      }
    }
    // Try extension bridge before giving up
    const bridgeResult2 = await tryBridgeCapture(domain, fullUrl, options);
    if (bridgeResult2) return bridgeResult2;

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
    // Try extension bridge before giving up
    const bridgeResult3 = await tryBridgeCapture(domain, fullUrl, options);
    if (bridgeResult3) return bridgeResult3;

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
    const skillSource = source;

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
      skillSource,
      capturedAt: skill.capturedAt,
      task,
      ...(result.truncated ? { truncated: true } : {}),
    };
  } catch {
    // Try extension bridge before giving up
    const bridgeResult4 = await tryBridgeCapture(domain, fullUrl, options);
    if (bridgeResult4) return bridgeResult4;

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

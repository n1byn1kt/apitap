import type { SkillFile, SkillEndpoint } from '../types.js';
import type { TruncationInfo } from '../replay/truncate.js';
import { readSkillFile } from '../skill/store.js';
import { replayEndpoint } from '../replay/engine.js';
import { SessionCache } from './cache.js';
import { read } from '../read/index.js';
import { assertSsrfBypassAllowed } from '../skill/ssrf.js';
import { bridgeAvailable, requestBridgeCapture, DEFAULT_SOCKET } from '../bridge/client.js';
import { signSkillFile } from '../skill/signing.js';
import { deriveSigningKey } from '../auth/crypto.js';
import { getMachineId } from '../auth/manager.js';

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
  truncated?: TruncationInfo;
}

export interface BrowseGuidance {
  success: false;
  reason: string;
  discoveryConfidence?: string;
  suggestion: string;
  domain: string;
  url: string;
  task?: string;
  /**
   * Set when a saved skill file existed but could not be read or verified —
   * usually a stale or tampered signature, but any readSkillFile failure
   * (invalid JSON, schema violation, permissions) lands here too.
   */
  skillFileError?: string;
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
  unreadableOnDisk = false,
): Promise<BrowseResult | null> {
  const socketPath = options._bridgeSocketPath ?? DEFAULT_SOCKET;
  if (!await bridgeAvailable(socketPath)) return null;

  const result = await requestBridgeCapture(domain, socketPath, { timeout: options._bridgeTimeout });

  if (result.success && result.skillFiles && result.skillFiles.length > 0) {
    const skillFiles = result.skillFiles;
    // Sign and save each skill file to disk
    try {
      const { writeSkillFile: writeSF, DEFAULT_SKILLS_DIR } = await import('../skill/store.js');
      const mid = await getMachineId();
      const sk = deriveSigningKey(mid);
      for (let i = 0; i < skillFiles.length; i++) {
        skillFiles[i] = signSkillFile(skillFiles[i], sk);
        if (unreadableOnDisk && skillFiles[i].domain === domain) {
          // This overwrite would destroy the unreadable-but-preservable file
          // the disk read tripped on — copy it into .quarantine first.
          try {
            const { preserveSkillFile } = await import('../doctor/snapshot.js');
            await preserveSkillFile(options.skillsDir ?? DEFAULT_SKILLS_DIR, domain);
          } catch {
            // Best-effort — the capture still lands.
          }
        }
        await writeSF(skillFiles[i], options.skillsDir);
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
      const match = pickEndpoint(primarySkill, urlPath);

      if (match) {
        const endpoint = match.endpoint;
        try {
          const replayResult = await replayEndpoint(primarySkill, endpoint.id, {
            params: match.params,
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
              ...(replayResult.truncated ? { truncated: replayResult.truncated } : {}),
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
  assertSsrfBypassAllowed(options._skipSsrfCheck);
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
  let skillFileError: string | undefined;

  // Every guidance exit must carry the skipped-skill-file reason — including
  // results built by tryBridgeCapture, which never sees skillFileError.
  const withSkillFileError = (result: BrowseResult): BrowseResult =>
    !result.success && skillFileError ? { ...result, skillFileError } : result;

  if (cache?.has(domain)) {
    skill = cache.get(domain)!.skillFile;
    source = cache.get(domain)!.source;
  }

  // Step 2: Check disk
  if (!skill) {
    try {
      skill = await readSkillFile(domain, skillsDir);
    } catch (err: any) {
      // A stale or tampered signature makes readSkillFile throw. browse exists
      // to escalate, so an unreadable saved file must not abort the run before
      // discovery and the read fallback get their turn — report it instead.
      skillFileError = err?.message ?? String(err);
    }
    if (skill) {
      source = 'disk';
      cache?.set(domain, skill, 'disk');
    }
  }

  // Step 3: Try discovery
  if (!skill && !skipDiscovery) {
    try {
      const { discover } = await import('../discovery/index.js');
      const discovery = await discover(fullUrl, { skipSsrf: options._skipSsrfCheck });

      if (discovery.skillFile && discovery.skillFile.endpoints.length > 0 &&
          (discovery.confidence === 'high' || discovery.confidence === 'medium')) {
        skill = discovery.skillFile;
        source = 'discovered';

        // Sign and save to disk (H1: skill files must be signed for verification)
        const machineId = await getMachineId();
        const sigKey = deriveSigningKey(machineId);
        skill = signSkillFile(skill, sigKey);
        const { writeSkillFile: writeSF, DEFAULT_SKILLS_DIR } = await import('../skill/store.js');
        if (skillFileError) {
          // The file on disk could not be read. Overwriting it would destroy
          // the evidence (and, for a stale-but-valid signature, a recoverable
          // capture) — copy it into .quarantine first, same place apitap
          // doctor puts suspect files. Copy, not move: if the write below
          // fails, the domain keeps its live file.
          try {
            const { preserveSkillFile } = await import('../doctor/snapshot.js');
            await preserveSkillFile(skillsDir ?? DEFAULT_SKILLS_DIR, domain);
          } catch {
            // Best-effort — self-healing still wins if the file vanished or
            // can't be copied.
          }
        }
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
        const bridgeResult1 = await tryBridgeCapture(domain, fullUrl, options, !!skillFileError);
        if (bridgeResult1) return withSkillFileError(bridgeResult1);

        return {
          success: false,
          reason: 'no_replayable_endpoints',
          discoveryConfidence: discovery.confidence,
          suggestion: 'capture_needed',
          domain,
          url: fullUrl,
          task,
          ...(skillFileError ? { skillFileError } : {}),
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
    const bridgeResult2 = await tryBridgeCapture(domain, fullUrl, options, !!skillFileError);
    if (bridgeResult2) return withSkillFileError(bridgeResult2);

    return {
      success: false,
      reason: skillFileError ? 'unreadable_skill_file' : 'no_skill_file',
      suggestion: 'capture_needed',
      domain,
      url: fullUrl,
      task,
      ...(skillFileError ? { skillFileError } : {}),
    };
  }

  // Step 4: Pick best endpoint
  const match = pickEndpoint(skill, urlPath);
  if (!match) {
    // Try extension bridge before giving up
    const bridgeResult3 = await tryBridgeCapture(domain, fullUrl, options);
    if (bridgeResult3) return withSkillFileError(bridgeResult3);

    const hasCandidates = skill.endpoints.some(ep =>
      ep.method === 'GET' && REPLAYABLE_TIERS.has(ep.replayability?.tier ?? 'unknown'));
    return withSkillFileError({
      success: false,
      reason: hasCandidates ? 'path_not_captured' : 'no_replayable_endpoints',
      suggestion: 'capture_needed',
      domain,
      url: fullUrl,
      task,
    });
  }
  const endpoint = match.endpoint;

  // Step 5: Replay
  try {
    const result = await replayEndpoint(skill, endpoint.id, { params: match.params, maxBytes, _skipSsrfCheck: options._skipSsrfCheck });
    const skillSource = source;

    // Check content-type: HTML responses are not usable API data
    const contentType = result.headers['content-type'] ?? '';
    if (contentType.includes('text/html')) {
      // Invalidate stale cache so next call reads fresh skill file from disk
      cache?.invalidate(domain);
      return withSkillFileError({
        success: false,
        reason: 'non_api_response',
        discoveryConfidence: source === 'discovered' ? 'medium' : undefined,
        suggestion: 'capture_needed',
        domain,
        url: fullUrl,
        task,
      });
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
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  } catch {
    // Try extension bridge before giving up
    const bridgeResult4 = await tryBridgeCapture(domain, fullUrl, options);
    if (bridgeResult4) return withSkillFileError(bridgeResult4);

    return withSkillFileError({
      success: false,
      reason: 'replay_failed',
      suggestion: 'capture_needed',
      domain,
      url: fullUrl,
      task,
    });
  }
}

const REPLAYABLE_TIERS = new Set(['green', 'yellow', 'unknown']);

interface EndpointMatch {
  endpoint: SkillEndpoint;
  /** Path params extracted from the requested URL, for :param substitution at replay */
  params: Record<string, string>;
}

/**
 * Match a requested path against an endpoint's route template, segment by
 * segment. Literal segments must be equal; `:param` segments capture the
 * requested value. Returns the captured params, or null if the template
 * does not cover the requested path.
 */
function matchTemplate(template: string, urlPath: string): Record<string, string> | null {
  const templateSegs = template.split('/').filter(Boolean);
  const urlSegs = urlPath.split('/').filter(Boolean);
  if (templateSegs.length !== urlSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateSegs.length; i++) {
    if (templateSegs[i].startsWith(':')) {
      let value = urlSegs[i];
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      params[templateSegs[i].slice(1)] = value;
    } else if (templateSegs[i] !== urlSegs[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Pick the endpoint to replay.
 *
 * For a bare-domain request (path `/` or empty), any replayable endpoint is a
 * reasonable entry point — return the first candidate.
 *
 * For a specific path, require a real route match (exact or :param template).
 * A captured `GET /users` does NOT serve `/users/octocat` — falling back to a
 * sibling endpoint silently returns wrong data (issue #52).
 */
function pickEndpoint(skill: SkillFile, urlPath: string): EndpointMatch | null {
  const candidates = skill.endpoints.filter(ep =>
    ep.method === 'GET' &&
    REPLAYABLE_TIERS.has(ep.replayability?.tier ?? 'unknown'),
  );

  if (candidates.length === 0) return null;

  if (!urlPath || urlPath === '/') {
    return { endpoint: candidates[0], params: {} };
  }

  for (const ep of candidates) {
    const params = matchTemplate(ep.path, urlPath);
    if (params) return { endpoint: ep, params };
  }

  return null;
}

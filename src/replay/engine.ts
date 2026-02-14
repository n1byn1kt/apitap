// src/replay/engine.ts
import type { SkillFile } from '../types.js';
import type { AuthManager } from '../auth/manager.js';
import { substituteBodyVariables } from '../capture/body-variables.js';
import { parseJwtClaims } from '../capture/entropy.js';
import { refreshTokens } from '../auth/refresh.js';
import { truncateResponse } from './truncate.js';
import { resolveAndValidateUrl } from '../skill/ssrf.js';

export interface ReplayOptions {
  /** User-provided parameters for path, query, and body substitution */
  params?: Record<string, string>;
  /** Auth manager for token injection (optional) */
  authManager?: AuthManager;
  /** Domain for auth lookups (required if authManager provided) */
  domain?: string;
  /** Force token refresh before replay (requires authManager) */
  fresh?: boolean;
  /** Maximum response size in bytes. If set, truncates large responses. */
  maxBytes?: number;
  /** @internal Skip SSRF check — for testing only */
  _skipSsrfCheck?: boolean;
}

export interface ReplayResult {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  /** Whether tokens were refreshed during this replay */
  refreshed?: boolean;
  /** Whether the response was truncated to fit maxBytes */
  truncated?: boolean;
}

/**
 * Extract default path param values from an example URL by comparing
 * it to the parameterized path template.
 */
function extractPathDefaults(
  pathTemplate: string,
  exampleUrl: string,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  try {
    const examplePath = new URL(exampleUrl).pathname;
    const templateParts = pathTemplate.split('/');
    const exampleParts = examplePath.split('/');

    for (let i = 0; i < templateParts.length && i < exampleParts.length; i++) {
      if (templateParts[i].startsWith(':')) {
        const paramName = templateParts[i].slice(1);
        defaults[paramName] = exampleParts[i];
      }
    }
  } catch {
    // Invalid example URL — no defaults
  }
  return defaults;
}

/**
 * Substitute :param placeholders in a path with values.
 */
function substitutePath(
  pathTemplate: string,
  params: Record<string, string>,
): string {
  return pathTemplate.replace(/:([a-zA-Z_]+)/g, (match, name) => {
    return params[name] ?? match;
  });
}

/**
 * Detect if options object is new-style ReplayOptions or legacy params.
 * ReplayOptions has keys like authManager, domain, fresh, or params.
 * Legacy params only have string values.
 */
function normalizeOptions(
  optionsOrParams?: ReplayOptions | Record<string, string>,
): ReplayOptions {
  if (!optionsOrParams) {
    return {};
  }

  // Check for ReplayOptions signature (has known option keys or non-string values)
  const hasOptionKeys =
    'authManager' in optionsOrParams ||
    'domain' in optionsOrParams ||
    'fresh' in optionsOrParams ||
    'params' in optionsOrParams ||
    'maxBytes' in optionsOrParams ||
    '_skipSsrfCheck' in optionsOrParams;

  if (hasOptionKeys) {
    return optionsOrParams as ReplayOptions;
  }

  // Legacy: treat entire object as params
  return { params: optionsOrParams as Record<string, string> };
}

/**
 * Wrap a 401/403 response with structured auth guidance.
 */
function wrapAuthError(
  status: number,
  originalData: unknown,
  domain: string,
): unknown {
  if (status !== 401 && status !== 403) return originalData;

  return {
    status,
    error: 'Authentication required',
    suggestion: `Use apitap_auth_request to log in to ${domain}`,
    domain,
    originalResponse: originalData,
  };
}

/**
 * Replay a captured API endpoint.
 *
 * @param skill - Skill file containing endpoint definitions
 * @param endpointId - ID of the endpoint to replay
 * @param optionsOrParams - Either ReplayOptions object or params directly (for backward compat)
 */
export async function replayEndpoint(
  skill: SkillFile,
  endpointId: string,
  optionsOrParams?: ReplayOptions | Record<string, string>,
): Promise<ReplayResult> {
  // Normalize options: support both new ReplayOptions and legacy params-only
  const options = normalizeOptions(optionsOrParams);
  const { params = {}, authManager, domain } = options;

  const endpoint = skill.endpoints.find(e => e.id === endpointId);
  if (!endpoint) {
    throw new Error(
      `Endpoint "${endpointId}" not found in skill for ${skill.domain}. ` +
      `Available: ${skill.endpoints.map(e => e.id).join(', ')}`,
    );
  }

  // Resolve path: substitute :param placeholders
  let resolvedPath = endpoint.path;
  if (resolvedPath.includes(':')) {
    const defaults = extractPathDefaults(endpoint.path, endpoint.examples.request.url);
    const merged = { ...defaults, ...params };
    resolvedPath = substitutePath(resolvedPath, merged);
  }

  const url = new URL(resolvedPath, skill.baseUrl);

  // Apply query params: start with captured defaults, override with provided params
  for (const [key, val] of Object.entries(endpoint.queryParams)) {
    url.searchParams.set(key, val.example);
  }
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      // Skip path params (already handled above)
      if (endpoint.path.includes(`:${key}`)) continue;
      // Skip body variables (they have dots in the path)
      if (key.includes('.')) continue;
      url.searchParams.set(key, val);
    }
  }

  // SSRF validation — block requests to private/internal IPs
  if (!options._skipSsrfCheck) {
    const ssrfCheck = await resolveAndValidateUrl(url.toString());
    if (!ssrfCheck.safe) {
      throw new Error(`SSRF blocked: ${ssrfCheck.reason}`);
    }
  }

  // Prepare request body if present
  let body: string | undefined;
  const headers = { ...endpoint.headers };

  if (endpoint.requestBody) {
    let processedBody = endpoint.requestBody.template;

    // Inject refreshable tokens from storage (v0.8)
    if (authManager && domain && endpoint.requestBody.refreshableTokens?.length) {
      const storedTokens = await authManager.retrieveTokens(domain);
      if (storedTokens) {
        const tokenValues: Record<string, string> = {};
        for (const tokenName of endpoint.requestBody.refreshableTokens) {
          if (storedTokens[tokenName]) {
            tokenValues[tokenName] = storedTokens[tokenName].value;
          }
        }
        if (Object.keys(tokenValues).length > 0) {
          processedBody = substituteBodyVariables(processedBody, tokenValues);
        }
      }
    }

    // Substitute user-provided variables
    if (params && endpoint.requestBody.variables) {
      processedBody = substituteBodyVariables(processedBody, params);
    }

    // Serialize to string
    if (typeof processedBody === 'object') {
      body = JSON.stringify(processedBody);
    } else {
      body = processedBody;
    }

    // Ensure content-type is set
    if (!headers['content-type']) {
      headers['content-type'] = endpoint.requestBody.contentType;
    }
  }

  // Proactive JWT expiry check: skip doomed request if token is expired
  const fresh = options.fresh ?? false;
  let refreshed = false;

  if (authManager && domain) {
    if (fresh) {
      // --fresh flag: force refresh before replay
      const refreshResult = await refreshTokens(skill, authManager, { domain, _skipSsrfCheck: options._skipSsrfCheck });
      if (refreshResult.success) {
        refreshed = true;
        // Re-inject fresh auth header
        const freshAuth = await authManager.retrieve(domain);
        if (freshAuth) {
          headers[freshAuth.header] = freshAuth.value;
        }
      }
    } else {
      // Proactive: check if JWT is expired (30s buffer for clock skew)
      const currentAuth = await authManager.retrieve(domain);
      if (currentAuth?.value) {
        const raw = currentAuth.value.startsWith('Bearer ')
          ? currentAuth.value.slice(7)
          : currentAuth.value;
        const jwt = parseJwtClaims(raw);
        if (jwt?.exp && jwt.exp < Math.floor(Date.now() / 1000) + 30) {
          const refreshResult = await refreshTokens(skill, authManager, { domain, _skipSsrfCheck: options._skipSsrfCheck });
          if (refreshResult.success) {
            refreshed = true;
            const freshAuth = await authManager.retrieve(domain);
            if (freshAuth) {
              headers[freshAuth.header] = freshAuth.value;
            }
          }
        }
      }
    }
  }

  const response = await fetch(url.toString(), {
    method: endpoint.method,
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });

  // Reactive: retry on 401/403 if we haven't already refreshed
  if (
    (response.status === 401 || response.status === 403) &&
    !refreshed &&
    authManager &&
    domain
  ) {
    const refreshResult = await refreshTokens(skill, authManager, { domain, _skipSsrfCheck: options._skipSsrfCheck });
    if (refreshResult.success) {
      refreshed = true;
      // Re-inject fresh auth
      const freshAuth = await authManager.retrieve(domain);
      if (freshAuth) {
        headers[freshAuth.header] = freshAuth.value;
      }

      // Retry the request
      const retryResponse = await fetch(url.toString(), {
        method: endpoint.method,
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
      });

      const retryHeaders: Record<string, string> = {};
      retryResponse.headers.forEach((value, key) => {
        retryHeaders[key] = value;
      });

      let retryData: unknown;
      const retryCt = retryResponse.headers.get('content-type') ?? '';
      const retryText = await retryResponse.text();
      if (retryCt.includes('json') && retryText.length > 0) {
        retryData = JSON.parse(retryText);
      } else {
        retryData = retryText;
      }

      const retryFinalData = (retryResponse.status === 401 || retryResponse.status === 403)
        ? wrapAuthError(retryResponse.status, retryData, skill.domain)
        : retryData;

      if (options.maxBytes) {
        const truncated = truncateResponse(retryFinalData, { maxBytes: options.maxBytes });
        return {
          status: retryResponse.status,
          headers: retryHeaders,
          data: truncated.data,
          refreshed,
          ...(truncated.truncated ? { truncated: true } : {}),
        };
      }

      return {
        status: retryResponse.status,
        headers: retryHeaders,
        data: retryFinalData,
        refreshed,
      };
    }
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let data: unknown;
  const ct = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (ct.includes('json') && text.length > 0) {
    data = JSON.parse(text);
  } else {
    data = text;
  }

  const finalData = (response.status === 401 || response.status === 403)
    ? wrapAuthError(response.status, data, skill.domain)
    : data;

  // Apply truncation if maxBytes is set
  if (options.maxBytes) {
    const truncated = truncateResponse(finalData, { maxBytes: options.maxBytes });
    return {
      status: response.status,
      headers: responseHeaders,
      data: truncated.data,
      ...(refreshed ? { refreshed } : {}),
      ...(truncated.truncated ? { truncated: true } : {}),
    };
  }

  return { status: response.status, headers: responseHeaders, data: finalData, ...(refreshed ? { refreshed } : {}) };
}

// --- Batch replay ---

export interface BatchReplayRequest {
  domain: string;
  endpointId: string;
  params?: Record<string, string>;
}

export interface BatchReplayResult {
  domain: string;
  endpointId: string;
  status: number;
  data: unknown;
  error?: string;
  tier?: string;
  capturedAt?: string;
  truncated?: boolean;
}

export async function replayMultiple(
  requests: BatchReplayRequest[],
  options: { skillsDir?: string; maxBytes?: number; _skipSsrfCheck?: boolean } = {},
): Promise<BatchReplayResult[]> {
  if (requests.length === 0) return [];

  const { readSkillFile } = await import('../skill/store.js');
  const { AuthManager, getMachineId } = await import('../auth/manager.js');

  // Deduplicate skill file reads
  const skillCache = new Map<string, SkillFile | null>();
  const uniqueDomains = [...new Set(requests.map(r => r.domain))];
  await Promise.all(uniqueDomains.map(async (domain) => {
    const skill = await readSkillFile(domain, options.skillsDir);
    skillCache.set(domain, skill);
  }));

  // Shared auth manager
  const machineId = await getMachineId();
  const authManager = new AuthManager(
    (await import('node:os')).homedir() + '/.apitap',
    machineId,
  );

  // Replay all in parallel
  const settled = await Promise.allSettled(
    requests.map(async (req): Promise<BatchReplayResult> => {
      const skill = skillCache.get(req.domain);
      if (!skill) {
        return {
          domain: req.domain,
          endpointId: req.endpointId,
          status: 0,
          data: null,
          error: `No skill file found for "${req.domain}"`,
        };
      }

      const endpoint = skill.endpoints.find(e => e.id === req.endpointId);
      const tier = endpoint?.replayability?.tier ?? 'unknown';

      try {
        const result = await replayEndpoint(skill, req.endpointId, {
          params: req.params,
          authManager,
          domain: req.domain,
          maxBytes: options.maxBytes,
          _skipSsrfCheck: options._skipSsrfCheck,
        });
        return {
          domain: req.domain,
          endpointId: req.endpointId,
          status: result.status,
          data: result.data,
          tier,
          capturedAt: skill.capturedAt,
          ...(result.truncated ? { truncated: true } : {}),
        };
      } catch (err: any) {
        return {
          domain: req.domain,
          endpointId: req.endpointId,
          status: 0,
          data: null,
          error: err.message,
          tier,
          capturedAt: skill.capturedAt,
        };
      }
    }),
  );

  return settled.map((s) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          domain: '',
          endpointId: '',
          status: 0,
          data: null,
          error: s.reason?.message ?? 'Unknown error',
        },
  );
}

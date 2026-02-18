import type { SkillFile } from '../types.js';
import type { AuthManager } from '../auth/manager.js';
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
 * Replay a captured API endpoint.
 *
 * @param skill - Skill file containing endpoint definitions
 * @param endpointId - ID of the endpoint to replay
 * @param optionsOrParams - Either ReplayOptions object or params directly (for backward compat)
 */
export declare function replayEndpoint(skill: SkillFile, endpointId: string, optionsOrParams?: ReplayOptions | Record<string, string>): Promise<ReplayResult>;
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
export declare function replayMultiple(requests: BatchReplayRequest[], options?: {
    skillsDir?: string;
    maxBytes?: number;
    _skipSsrfCheck?: boolean;
}): Promise<BatchReplayResult[]>;

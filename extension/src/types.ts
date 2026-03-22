export interface CaptureState {
  active: boolean;
  tabId: number | null;
  domain: string | null;
  requestCount: number;
  endpointCount: number;
  authDetected: { type: string; header: string } | null;
  bridgeConnected: boolean;
  autoSaved: string[] | null;
}

// Messages from popup → background
export interface CaptureMessage {
  type: 'START_CAPTURE' | 'STOP_CAPTURE' | 'GET_STATE' | 'DOWNLOAD_SKILL'
    | 'PROMOTE_DOMAIN' | 'GET_INDEX' | 'GET_APPROVED_DOMAINS' | 'REMOVE_APPROVED_DOMAIN';
  domain?: string; // for PROMOTE_DOMAIN
}

// Responses from background → popup
export interface CaptureResponse {
  type: 'STATE_UPDATE' | 'CAPTURE_COMPLETE' | 'ERROR';
  state?: CaptureState;
  skillJson?: string;
  error?: string;
}

// Messages from native host → extension (CLI-initiated requests)
export interface AgentRequest {
  action: 'capture_request';
  domain: string;
  _relayId?: string;
}

// Responses from extension → native host (back to CLI)
export interface AgentResponse {
  success: boolean;
  skillFiles?: any[];
  error?: string;
  _relayId?: string;
}

// --- Passive Index types (v2) ---

export interface IndexFile {
  v: 1;
  updatedAt: string;           // ISO timestamp of last write
  entries: IndexEntry[];
}

export interface IndexEntry {
  domain: string;
  firstSeen: string;           // ISO timestamp
  lastSeen: string;            // ISO timestamp
  totalHits: number;           // all observed requests (including filtered)
  promoted: boolean;           // full skill file exists
  lastPromoted?: string;       // ISO timestamp of last CDP capture
  skillFileSource?: 'extension' | 'cli';
  endpoints: IndexEndpoint[];
  /** Stored auth tokens (header + value). Kept in chrome.storage.session (cleared on browser close). */
  authTokens?: Array<{ header: string; value: string }>;
  /** @deprecated v1.5.0 single-header compat — use authTokens */
  authToken?: { header: string; value: string };
  /** v1.5.1: timestamp (ms) of last auto-learn attempt, for backoff */
  lastAutoLearnAttempt?: number;
}

export interface IndexEndpoint {
  path: string;                // parameterized: /api/v10/channels/:id
  methods: string[];           // ["GET", "PATCH", "DELETE"]
  authType?: string;           // "Bearer" | "API Key" | "Cookie" -- never the value
  hasBody: boolean;            // content-length > 0
  hits: number;                // per-endpoint count
  lastSeen: string;            // ISO timestamp
  pagination?: string;         // "cursor" | "offset" | "page"
  type?: 'graphql';            // flagged for special handling
  queryParamNames?: string[];  // names only, never values
}

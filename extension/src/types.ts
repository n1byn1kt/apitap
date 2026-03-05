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
  type: 'START_CAPTURE' | 'STOP_CAPTURE' | 'GET_STATE' | 'DOWNLOAD_SKILL';
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

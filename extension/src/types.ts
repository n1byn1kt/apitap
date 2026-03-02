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

export interface CaptureMessage {
  type: 'START_CAPTURE' | 'STOP_CAPTURE' | 'GET_STATE' | 'DOWNLOAD_SKILL';
}

export interface CaptureResponse {
  type: 'STATE_UPDATE' | 'CAPTURE_COMPLETE' | 'ERROR';
  state?: CaptureState;
  skillJson?: string;
  error?: string;
}

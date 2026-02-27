// src/capture/oauth-detector.ts

export interface OAuthInfo {
  tokenEndpoint: string;
  clientId: string;
  grantType: 'refresh_token' | 'client_credentials';
  scope?: string;
  clientSecret?: string;
  refreshToken?: string;
}

/**
 * Detect OAuth2 token endpoint requests from captured traffic.
 * Only recognizes refreshable flows (refresh_token, client_credentials).
 * Ignores authorization_code (initial auth, not refreshable in isolation).
 */
export function isOAuthTokenRequest(req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}): OAuthInfo | null {
  // Only POST requests
  if (req.method.toUpperCase() !== 'POST') return null;

  // URL heuristic: must contain /token or /oauth
  const urlLower = req.url.toLowerCase();
  if (!urlLower.includes('/token') && !urlLower.includes('/oauth')) return null;

  if (!req.postData) return null;

  // Parse body — support URL-encoded and JSON
  const params = parseBody(req.postData, req.headers['content-type'] ?? '');
  if (!params) return null;

  const grantType = params.get('grant_type');
  if (!grantType) return null;

  // Only refreshable flows
  if (grantType !== 'refresh_token' && grantType !== 'client_credentials') return null;

  // Extract client_id — may also be in Basic auth header
  let clientId = params.get('client_id') ?? '';
  let clientSecret = params.get('client_secret');

  if (!clientId) {
    const basic = parseBasicAuth(req.headers['authorization'] ?? '');
    if (basic) {
      clientId = basic.username;
      if (!clientSecret) clientSecret = basic.password;
    }
  }

  if (!clientId) return null;

  const result: OAuthInfo = {
    tokenEndpoint: req.url.split('?')[0]!, // strip query params
    clientId,
    grantType: grantType as 'refresh_token' | 'client_credentials',
  };

  const scope = params.get('scope');
  if (scope) result.scope = scope;
  if (clientSecret) result.clientSecret = clientSecret;
  const refreshToken = params.get('refresh_token');
  if (refreshToken) result.refreshToken = refreshToken;

  return result;
}

function parseBody(body: string, contentType: string): Map<string, string> | null {
  try {
    if (contentType.includes('application/json')) {
      const obj = JSON.parse(body);
      if (typeof obj !== 'object' || obj === null) return null;
      const map = new Map<string, string>();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') map.set(k, v);
      }
      return map;
    }

    // Default: URL-encoded (+ is space in application/x-www-form-urlencoded)
    const map = new Map<string, string>();
    const pairs = body.split('&');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
      const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
      map.set(key, val);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

function parseBasicAuth(header: string): { username: string; password: string } | null {
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

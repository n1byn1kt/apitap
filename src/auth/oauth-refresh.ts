// src/auth/oauth-refresh.ts
import type { OAuthConfig } from '../types.js';
import type { AuthManager } from './manager.js';
import { resolveAndValidateUrl } from '../skill/ssrf.js';

export interface OAuthRefreshResult {
  success: boolean;
  accessToken?: string;
  tokenRotated?: boolean;
  error?: string;
}

/**
 * Refresh an OAuth2 access token via the token endpoint using stdlib fetch().
 * Supports refresh_token and client_credentials grant types.
 * Handles refresh token rotation (new refresh_token in response).
 */
export async function refreshOAuth(
  domain: string,
  oauthConfig: OAuthConfig,
  authManager: AuthManager,
  options?: { _skipSsrfCheck?: boolean },
): Promise<OAuthRefreshResult> {
  const oauthCreds = await authManager.retrieveOAuthCredentials(domain);

  // Build request body based on grant type
  const body = new URLSearchParams();
  body.append('grant_type', oauthConfig.grantType);
  body.append('client_id', oauthConfig.clientId);

  if (oauthConfig.scope) {
    body.append('scope', oauthConfig.scope);
  }

  if (oauthConfig.grantType === 'refresh_token') {
    if (!oauthCreds?.refreshToken) {
      return { success: false, error: 'No refresh token available' };
    }
    body.append('refresh_token', oauthCreds.refreshToken);
  }

  if (oauthCreds?.clientSecret) {
    body.append('client_secret', oauthCreds.clientSecret);
  }

  // SSRF check on token endpoint
  if (!options?._skipSsrfCheck) {
    const ssrfCheck = await resolveAndValidateUrl(oauthConfig.tokenEndpoint);
    if (!ssrfCheck.safe) {
      return { success: false, error: `Token endpoint blocked: ${ssrfCheck.reason}` };
    }
  }

  // Domain match: token endpoint must match skill domain or be a known OAuth provider
  const KNOWN_OAUTH_HOSTS = [
    'oauth2.googleapis.com', 'accounts.google.com',
    'login.microsoftonline.com', 'github.com',
    'oauth.reddit.com', 'api.twitter.com',
  ];
  const tokenHost = new URL(oauthConfig.tokenEndpoint).hostname;
  if (tokenHost !== domain && !tokenHost.endsWith('.' + domain) && !KNOWN_OAUTH_HOSTS.includes(tokenHost)) {
    return { success: false, error: `Token endpoint domain mismatch: ${tokenHost} vs ${domain}` };
  }

  try {
    const response = await fetch(oauthConfig.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),  // 15s timeout for token refresh
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return {
        success: false,
        error: `Token endpoint returned ${response.status}: ${errorText}`.trim(),
      };
    }

    const data = await response.json() as Record<string, unknown>;
    const accessToken = data.access_token;

    if (typeof accessToken !== 'string') {
      return { success: false, error: 'No access_token in response' };
    }

    // Store new access token
    const existingAuth = await authManager.retrieve(domain);
    await authManager.store(domain, {
      type: existingAuth?.type ?? 'bearer',
      header: existingAuth?.header ?? 'authorization',
      value: `Bearer ${accessToken}`,
      tokens: existingAuth?.tokens,
      session: existingAuth?.session,
      refreshToken: existingAuth?.refreshToken,
      clientSecret: existingAuth?.clientSecret,
    });

    // Handle refresh token rotation
    let tokenRotated = false;
    const newRefreshToken = data.refresh_token;
    if (
      typeof newRefreshToken === 'string' &&
      newRefreshToken !== oauthCreds?.refreshToken
    ) {
      await authManager.storeOAuthCredentials(domain, {
        refreshToken: newRefreshToken,
      });
      tokenRotated = true;
    }

    return { success: true, accessToken, tokenRotated };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

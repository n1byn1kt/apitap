// test/e2e/helpers/mock-oauth-server.ts
// Single-server mock for OAuth provider E2E tests.
// All endpoints (HTML, token, API) are on the same server to avoid CORS issues
// in browser capture tests (matching the pattern of oauth-capture-live.test.ts).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOAuthServerConfig {
  /** Path for the token endpoint, e.g., '/oauth/token', '/v1/token', '/auth/v1/token' */
  tokenPath: string;
  /** Where grant_type is sent: 'body' (standard) or 'url' (Supabase) */
  grantTypeLocation: 'body' | 'url';
  /**
   * Returns JS code for <script> tag that fires the OAuth token request.
   * Should use relative URLs (same-origin) to avoid CORS issues.
   */
  htmlTokenRequest: () => string;
}

export interface MockOAuthServer {
  server: Server;
  url: string;
  state: {
    currentAccessToken: string;
    currentRefreshToken: string;
    tokenRequestCount: number;
  };
  /** Reset state between tests */
  reset(): void;
  /** Close the server */
  cleanup(): Promise<void>;
}

export async function createMockOAuthServer(config: MockOAuthServerConfig): Promise<MockOAuthServer> {
  const state = {
    currentAccessToken: 'access-token-0',
    currentRefreshToken: 'refresh-token-initial',
    tokenRequestCount: 0,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');

    // HTML page that fires OAuth token request via JS
    if (req.method === 'GET' && parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>Mock App</h1><script>${config.htmlTokenRequest()}</script></body></html>`);
      return;
    }

    // OAuth token endpoint (provider-specific path)
    if (req.method === 'POST' && parsedUrl.pathname === config.tokenPath) {
      let body = '';
      req.on('data', (chunk: Buffer) => body += chunk);
      req.on('end', () => {
        const bodyParams = new URLSearchParams(body);

        // Extract grant_type from configured location (with body fallback for replay)
        const grantType = config.grantTypeLocation === 'url'
          ? (parsedUrl.searchParams.get('grant_type') ?? bodyParams.get('grant_type'))
          : bodyParams.get('grant_type');

        // Extract refresh_token from body
        const refreshToken = bodyParams.get('refresh_token');

        if (grantType === 'refresh_token' && refreshToken === state.currentRefreshToken) {
          state.tokenRequestCount++;
          state.currentAccessToken = `access-token-${state.tokenRequestCount}`;
          const newRefreshToken = `refresh-token-rotated-${state.tokenRequestCount}`;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: state.currentAccessToken,
            refresh_token: newRefreshToken,
            token_type: 'bearer',
          }));

          state.currentRefreshToken = newRefreshToken;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
      });
      return;
    }

    // Protected API endpoint
    if (req.method === 'GET' && parsedUrl.pathname === '/api/data') {
      const auth = req.headers.authorization;
      if (auth === `Bearer ${state.currentAccessToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 1, name: 'test' }] }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;

  return {
    server,
    url,
    state,
    reset() {
      state.currentAccessToken = 'access-token-0';
      state.currentRefreshToken = 'refresh-token-initial';
      state.tokenRequestCount = 0;
    },
    async cleanup() {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

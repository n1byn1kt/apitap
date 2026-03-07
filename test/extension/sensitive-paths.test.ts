import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitivePath } from '../../extension/src/sensitive-paths.js';

describe('sensitive path blocklist', () => {
  // Paths that MUST be blocked
  const blocked = [
    '/login',
    '/api/login',
    '/oauth/authorize',
    '/oauth2/token',
    '/auth/callback',
    '/api/v1/token',
    '/password/reset',
    '/passwd',
    '/2fa/verify',
    '/mfa/setup',
    '/session/new',
    '/signup',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/account/security',
    '/api-key/create',
    '/credentials/rotate',
    // Case insensitive
    '/OAuth/Token',
    '/API/LOGIN',
    '/Auth/Callback',
  ];

  for (const path of blocked) {
    it(`blocks ${path}`, () => {
      assert.ok(isSensitivePath(path), `expected ${path} to be blocked`);
    });
  }

  // Paths that MUST NOT be blocked
  const allowed = [
    '/api/v1/users',
    '/api/channels/123',
    '/authors',          // /auth must use word boundary — not /authors
    '/search',
    '/graphql',
    '/api/v10/guilds/123/members',
    '/wp-json/wp/v2/posts',
  ];

  for (const path of allowed) {
    it(`allows ${path}`, () => {
      assert.ok(!isSensitivePath(path), `expected ${path} to be allowed`);
    });
  }

  // Edge cases: paths that contain "auth" as a substring but ARE auth endpoints
  const authEndpoints = [
    '/api/authenticate',
    '/v1/authorization',
  ];

  for (const path of authEndpoints) {
    it(`blocks auth endpoint ${path}`, () => {
      assert.ok(isSensitivePath(path), `expected ${path} to be blocked`);
    });
  }
});

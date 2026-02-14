// test/types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  SkillFile,
  SkillEndpoint,
  RequestBody,
  StoredAuth,
  SkillAuth,
  StoredToken,
  StoredSession,
} from '../src/types.js';

describe('Type validation', () => {
  it('should allow SkillAuth on SkillFile', () => {
    const skill: SkillFile = {
      version: '0.8.0',
      domain: 'example.com',
      capturedAt: '2026-02-04T00:00:00Z',
      baseUrl: 'https://example.com',
      endpoints: [],
      metadata: { captureCount: 0, filteredCount: 0, toolVersion: '0.8.0' },
      provenance: 'self',
      auth: {
        browserMode: 'visible',
        captchaRisk: true,
      },
    };
    assert.ok(skill.auth?.captchaRisk === true);
  });

  it('should allow refreshableTokens on RequestBody', () => {
    const body: RequestBody = {
      contentType: 'application/json',
      template: { csrf_token: '...', data: {} },
      variables: ['data.id'],
      refreshableTokens: ['csrf_token'],
    };
    assert.deepEqual(body.refreshableTokens, ['csrf_token']);
  });

  it('should allow tokens and session on StoredAuth', () => {
    const auth: StoredAuth = {
      type: 'bearer',
      header: 'authorization',
      value: 'Bearer xyz',
      tokens: {
        csrf_token: {
          value: 'abc123',
          refreshedAt: '2026-02-04T00:00:00Z',
        },
      },
      session: {
        cookies: [{ name: 'session', value: 'xyz', domain: 'example.com', path: '/' }],
        savedAt: '2026-02-04T00:00:00Z',
      },
    };
    assert.ok(auth.tokens?.csrf_token.value === 'abc123');
    assert.ok(auth.session?.cookies.length === 1);
  });
});

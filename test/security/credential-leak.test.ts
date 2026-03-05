// test/security/credential-leak.test.ts
// Ensures no credentials, passwords, tokens, or secrets can survive into a skill file.
// This is the "never ship a password" test suite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillGenerator } from '../../src/skill/generator.js';
import type { CapturedExchange, SkillFile } from '../../src/types.js';

// --- Test helpers ---

function mockGet(overrides: {
  url?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  body?: string;
}): CapturedExchange {
  return {
    request: {
      url: overrides.url ?? 'https://api.example.com/data',
      method: 'GET',
      headers: overrides.requestHeaders ?? {},
    },
    response: {
      status: 200,
      headers: overrides.responseHeaders ?? {},
      body: overrides.body ?? '{"ok":true}',
      contentType: 'application/json',
    },
    timestamp: '2026-03-04T00:00:00Z',
  };
}

function mockPost(overrides: {
  url?: string;
  postData?: string;
  requestHeaders?: Record<string, string>;
  body?: string;
}): CapturedExchange {
  return {
    request: {
      url: overrides.url ?? 'https://api.example.com/action',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(overrides.requestHeaders ?? {}) },
      postData: overrides.postData,
    },
    response: {
      status: 200,
      headers: {},
      body: overrides.body ?? '{"ok":true}',
      contentType: 'application/json',
    },
    timestamp: '2026-03-04T00:00:00Z',
  };
}

/** Deep-search a value for any occurrence of a substring */
function containsAnywhere(obj: unknown, needle: string): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'string') {
    return obj.includes(needle) ? obj : null;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const found = containsAnywhere(obj[i], needle);
      if (found) return `[${i}]: ${found}`;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const found = containsAnywhere(value, needle);
      if (found) return `${key} -> ${found}`;
    }
  }
  return null;
}

/** Assert that a secret does not appear anywhere in the skill file */
function assertNotLeaked(skill: SkillFile, secret: string, label: string) {
  const found = containsAnywhere(skill, secret);
  assert.equal(found, null, `${label} leaked into skill file at: ${found}`);
}

// --- Auth header scrubbing ---

describe('credential leak prevention: auth headers', () => {
  const SECRET_BEARER = 'sk-proj-super-secret-key-12345';
  const SECRET_API_KEY = 'apikey_live_abcdef123456';

  it('scrubs Authorization: Bearer tokens', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { authorization: `Bearer ${SECRET_BEARER}` },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, SECRET_BEARER, 'Bearer token');
    assert.equal(skill.endpoints[0].headers['authorization'], '[stored]');
  });

  it('scrubs Authorization: Basic credentials', () => {
    const basicCreds = Buffer.from('admin:hunter2').toString('base64');
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { authorization: `Basic ${basicCreds}` },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, basicCreds, 'Basic auth');
    assertNotLeaked(skill, 'hunter2', 'Password in Basic auth');
  });

  it('scrubs x-api-key header', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-api-key': SECRET_API_KEY },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, SECRET_API_KEY, 'x-api-key');
  });

  it('scrubs x-csrf-token header', () => {
    const csrf = 'csrf_a1b2c3d4e5f6789012345678';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-csrf-token': csrf },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, csrf, 'x-csrf-token');
  });

  it('scrubs x-auth-token header', () => {
    const token = 'auth_tok_abcdef1234567890';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-auth-token': token },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, token, 'x-auth-token');
  });

  it('scrubs x-access-token header', () => {
    const token = 'access_abcdef1234567890xxxx';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-access-token': token },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, token, 'x-access-token');
  });

  it('scrubs x-session-token header', () => {
    const token = 'sess_1234abcd5678efgh9012ijkl';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-session-token': token },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, token, 'x-session-token');
  });

  it('scrubs x-guest-token header', () => {
    const token = 'guest_token_9876543210abcdef';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-guest-token': token },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, token, 'x-guest-token');
  });

  it('scrubs x-xsrf-token header', () => {
    const token = 'xsrf_99887766554433221100aabb';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-xsrf-token': token },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, token, 'x-xsrf-token');
  });

  it('strips cookie header entirely', () => {
    const cookie = 'session=abc123; auth_token=secret456';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { cookie },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'abc123', 'Cookie session value');
    assertNotLeaked(skill, 'secret456', 'Cookie auth_token value');
    assert.equal(skill.endpoints[0].headers['cookie'], undefined);
  });

  it('detects high-entropy custom headers via entropy analysis', () => {
    // A random-looking token in a non-standard header
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: { 'x-custom-auth': token },
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, token, 'JWT in custom header');
  });
});

// --- POST body credential scrubbing ---

describe('credential leak prevention: POST body fields', () => {
  const SENSITIVE_FIELDS = [
    ['password', 'MyS3cretP@ss!'],
    ['passwd', 'hunter2'],
    ['pass', 'letmein123'],
    ['secret', 'shh-dont-tell'],
    ['client_secret', 'cs_live_abcdef1234567890'],
    ['refresh_token', 'rt_1234567890abcdef'],
    ['access_token', 'at_abcdef1234567890'],
    ['api_key', 'ak_live_super_secret'],
    ['apikey', 'sk-proj-1234abcd'],
    ['token', 'tok_99887766'],
    ['csrf_token', 'csrf_aabbccdd11223344'],
    ['_csrf', '9f8e7d6c5b4a3210'],
    ['xsrf_token', 'xsrf_112233445566'],
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['credential', 'cred_live_xxyyzzww'],
  ];

  for (const [field, value] of SENSITIVE_FIELDS) {
    it(`scrubs "${field}" field from POST body`, () => {
      const gen = new SkillGenerator();
      gen.addExchange(mockPost({
        postData: JSON.stringify({ [field]: value, action: 'login' }),
      }));
      const skill = gen.toSkillFile('example.com');
      assertNotLeaked(skill, value, `POST body field "${field}"`);

      // The field should exist as [scrubbed]
      const template = skill.endpoints[0].requestBody?.template as Record<string, unknown>;
      assert.equal(template[field], '[scrubbed]', `${field} should be [scrubbed]`);
    });
  }

  it('scrubs nested sensitive fields', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockPost({
      postData: JSON.stringify({
        user: { email: 'a@b.com', password: 'nested-secret' },
        action: 'register',
      }),
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'nested-secret', 'Nested password');
  });

  it('scrubs sensitive fields in arrays', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockPost({
      postData: JSON.stringify([
        { username: 'alice', password: 'alice-pass' },
        { username: 'bob', password: 'bob-pass' },
      ]),
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'alice-pass', 'Array item password');
    assertNotLeaked(skill, 'bob-pass', 'Array item password');
  });
});

// --- Query parameter credential scrubbing ---

describe('credential leak prevention: query parameters', () => {
  it('scrubs api_key query parameter', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/data?api_key=sk_live_12345abcdef&format=json',
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'sk_live_12345abcdef', 'api_key query param');
  });

  it('scrubs token query parameter', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/data?token=eyJhbGciOiJIUzI1NiJ9.payload.sig&limit=10',
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'eyJhbGciOiJIUzI1NiJ9', 'Token query param');
  });

  it('scrubs access_key query parameter', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/data?access_key=ak_9876543210fedcba',
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'ak_9876543210fedcba', 'access_key query param');
  });

  it('scrubs secret query parameter', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/data?secret=shhh_this_is_secret_1234',
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'shhh_this_is_secret_1234', 'secret query param');
  });

  it('scrubs high-entropy values in generic query params', () => {
    // A param named "key" with a value that looks like a token
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/data?key=AIzaSy-FAKE-KEY-FOR-TESTING-ONLY-NOT-REAL',
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'AIzaSy-FAKE-KEY-FOR-TESTING-ONLY-NOT-REAL', 'High-entropy key param');
  });

  it('preserves non-sensitive query params', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/data?limit=10&offset=20&format=json',
    }));
    const skill = gen.toSkillFile('example.com');
    const params = skill.endpoints[0].queryParams;
    assert.equal(params['limit'].example, '10');
    assert.equal(params['offset'].example, '20');
    assert.equal(params['format'].example, 'json');
  });
});

// --- PII scrubbing in URLs and bodies ---

describe('credential leak prevention: PII in content', () => {
  it('scrubs email addresses from example URLs', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/users/alice@company.com/profile',
    }));
    const skill = gen.toSkillFile('example.com');
    // The example URL (what gets shared/exported) must be scrubbed
    const exUrl = skill.endpoints[0].examples.request.url;
    assert.ok(!exUrl.includes('alice@company.com'), `Email leaked in example URL: ${exUrl}`);
    // Note: endpoint.path may retain the email since it's part of the path structure
    // and with one observation the parameterizer can't know it's variable.
    // The critical thing is the example URL is clean.
  });

  it('scrubs email addresses from query params', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      url: 'https://api.example.com/search?email=bob@secret.org&name=Bob',
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'bob@secret.org', 'Email in query');
  });

  it('scrubs email addresses from POST body', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockPost({
      postData: JSON.stringify({ email: 'carol@private.net', action: 'subscribe' }),
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'carol@private.net', 'Email in POST body');
  });

  it('scrubs credit card numbers from response previews', () => {
    const gen = new SkillGenerator({ enablePreview: true });
    gen.addExchange(mockGet({
      body: JSON.stringify({ card: '4111-1111-1111-1111', status: 'active' }),
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, '4111-1111-1111-1111', 'Credit card in preview');
    assertNotLeaked(skill, '4111111111111111', 'Credit card (no dashes) in preview');
  });

  it('scrubs JWTs from response previews', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const gen = new SkillGenerator({ enablePreview: true });
    gen.addExchange(mockGet({
      body: JSON.stringify({ token: jwt, name: 'test' }),
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, jwt, 'JWT in response preview');
  });
});

// --- Response preview scrubbing ---

describe('credential leak prevention: response previews', () => {
  it('scrubs sensitive fields from response preview objects', () => {
    const gen = new SkillGenerator({ enablePreview: true, scrub: true });
    gen.addExchange(mockGet({
      body: JSON.stringify({
        user: 'alice',
        password: 'should-not-appear',
        api_key: 'also-should-not-appear',
      }),
    }));
    const skill = gen.toSkillFile('example.com');
    assertNotLeaked(skill, 'should-not-appear', 'Password in response preview');
    assertNotLeaked(skill, 'also-should-not-appear', 'API key in response preview');
  });

  it('preview is null by default (safest option)', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      body: JSON.stringify({ secret: 'hidden', data: 'visible' }),
    }));
    const skill = gen.toSkillFile('example.com');
    assert.equal(skill.endpoints[0].examples.responsePreview, null);
  });
});

// --- Full serialization scan ---

describe('credential leak prevention: full skill file scan', () => {
  it('no auth values survive JSON.stringify of skill file', () => {
    const secrets = {
      bearer: 'Bearer sk-live-AAAA1111BBBB2222CCCC3333',
      apiKey: 'x-api-key-9999888877776666',
      cookie: 'session_id=deadbeef12345678; csrf=aabbccdd',
      password: 'P@ssw0rd!2026',
      jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhcGl0YXAifQ.signature_here',
    };

    const gen = new SkillGenerator({ enablePreview: true });
    gen.addExchange(mockGet({
      url: `https://api.example.com/data?api_key=${secrets.apiKey}`,
      requestHeaders: {
        authorization: secrets.bearer,
        cookie: secrets.cookie,
        'x-custom-jwt': secrets.jwt,
      },
    }));
    gen.addExchange(mockPost({
      url: 'https://api.example.com/login',
      requestHeaders: { authorization: secrets.bearer },
      postData: JSON.stringify({
        username: 'admin',
        password: secrets.password,
        csrf_token: 'csrf_value_here',
      }),
    }));

    const skill = gen.toSkillFile('example.com');
    const serialized = JSON.stringify(skill);

    // None of these secrets should appear anywhere in the serialized output
    assertNotLeaked(skill, 'sk-live-AAAA1111BBBB2222CCCC3333', 'Bearer token value');
    assertNotLeaked(skill, secrets.apiKey, 'API key value');
    assertNotLeaked(skill, 'deadbeef12345678', 'Cookie session value');
    assertNotLeaked(skill, secrets.password, 'Password');
    assertNotLeaked(skill, 'csrf_value_here', 'CSRF token');

    // Double-check via raw string search on serialized JSON
    assert.ok(!serialized.includes(secrets.password), 'Password found in serialized JSON');
    assert.ok(!serialized.includes('deadbeef12345678'), 'Cookie found in serialized JSON');
  });

  it('realistic Discord-like login flow has no credentials in output', () => {
    const gen = new SkillGenerator();

    // Simulate a login POST with real-world field names
    gen.addExchange(mockPost({
      url: 'https://discord.com/api/v9/auth/login',
      requestHeaders: {
        'x-fingerprint': '1234567890.abcdefghij',
        'x-super-properties': 'eyJvcyI6IkxpbnV4In0=',
      },
      postData: JSON.stringify({
        login: 'user@email.com',
        password: 'MyActualPassword123!',
        undelete: false,
        login_source: null,
        gift_code_sku_id: null,
      }),
    }));

    // Simulate an authenticated API call
    gen.addExchange(mockGet({
      url: 'https://discord.com/api/v9/users/@me',
      requestHeaders: {
        authorization: 'Bot NjE2MTY0.Xx1234.abcdefghijklmnop',
      },
    }));

    const skill = gen.toSkillFile('discord.com');
    assertNotLeaked(skill, 'MyActualPassword123!', 'Discord password');
    assertNotLeaked(skill, 'user@email.com', 'Discord login email');
    assertNotLeaked(skill, 'NjE2MTY0.Xx1234.abcdefghijklmnop', 'Discord bot token');
  });

  it('realistic OAuth token exchange has no secrets in output', () => {
    const gen = new SkillGenerator();

    gen.addExchange(mockPost({
      url: 'https://oauth.example.com/token',
      postData: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'auth_code_abc123',
        client_id: 'my-app',
        client_secret: 'cs_live_supersecret',
        redirect_uri: 'https://myapp.com/callback',
      }),
    }));

    const skill = gen.toSkillFile('oauth.example.com');
    assertNotLeaked(skill, 'cs_live_supersecret', 'OAuth client_secret');
  });
});

// --- Extension export scrubbing ---

describe('credential leak prevention: extension security', () => {
  // These tests verify the extension's scrubAuthFromSkillJson function
  // The actual function is in extension/src/security.ts and tested in
  // test/extension/security.test.ts — this suite tests the generator side

  it('auth credentials are extracted but NOT stored in skill file', () => {
    const gen = new SkillGenerator();
    gen.addExchange(mockGet({
      requestHeaders: {
        authorization: 'Bearer secret-token-value',
        'x-api-key': 'key-that-should-not-persist',
      },
    }));

    // Auth should be extractable (for AuthManager storage)
    const extracted = gen.getExtractedAuth();
    assert.ok(extracted.length >= 1, 'Auth should be extracted');

    // But skill file should only have placeholders
    const skill = gen.toSkillFile('example.com');
    const serialized = JSON.stringify(skill);
    assert.ok(!serialized.includes('secret-token-value'));
    assert.ok(!serialized.includes('key-that-should-not-persist'));
    assert.ok(serialized.includes('[stored]'));
  });
});

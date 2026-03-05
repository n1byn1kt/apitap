import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUrl, scrubAuthFromSkillJson, BLOCKED_SCHEMES } from '../../extension/src/security.js';

describe('extension URL security', () => {
  it('allows https URLs', () => {
    assert.ok(isAllowedUrl('https://api.example.com/users'));
  });

  it('blocks localhost/private IPs', () => {
    assert.ok(!isAllowedUrl('http://localhost:3000/api'));
    assert.ok(!isAllowedUrl('http://127.0.0.1:8080/api'));
    assert.ok(!isAllowedUrl('http://192.168.1.1/admin'));
    assert.ok(!isAllowedUrl('http://10.0.0.1/internal'));
    assert.ok(!isAllowedUrl('http://169.254.169.254/latest/meta-data'));
  });

  it('allows public http URLs', () => {
    assert.ok(isAllowedUrl('http://api.example.com/data'));
  });

  it('blocks chrome-extension:// URLs', () => {
    assert.ok(!isAllowedUrl('chrome-extension://abcdef/page.html'));
  });

  it('blocks devtools:// URLs', () => {
    assert.ok(!isAllowedUrl('devtools://devtools/bundled/inspector.html'));
  });

  it('blocks chrome:// URLs', () => {
    assert.ok(!isAllowedUrl('chrome://extensions'));
  });

  it('blocks data: URLs', () => {
    assert.ok(!isAllowedUrl('data:text/html,<h1>test</h1>'));
  });

  it('blocks blob: URLs', () => {
    assert.ok(!isAllowedUrl('blob:https://example.com/abc-def'));
  });

  it('blocks file:// URLs', () => {
    assert.ok(!isAllowedUrl('file:///etc/passwd'));
  });

  it('blocks javascript: URLs', () => {
    assert.ok(!isAllowedUrl('javascript:alert(1)'));
  });

  it('blocks empty/invalid URLs', () => {
    assert.ok(!isAllowedUrl(''));
    assert.ok(!isAllowedUrl('not-a-url'));
  });

  it('blocks webpack HMR URLs', () => {
    assert.ok(!isAllowedUrl('https://localhost:3000/__webpack_hmr'));
    assert.ok(!isAllowedUrl('https://example.com/foo.hot-update.json'));
  });
});

describe('auth scrubbing from exported skill JSON', () => {
  it('replaces Authorization header values with [stored]', () => {
    const input = JSON.stringify({
      endpoints: [{
        headers: { authorization: 'Bearer eyJhbGciOiJSUz...longtoken' },
      }],
    });
    const scrubbed = JSON.parse(scrubAuthFromSkillJson(input));
    assert.equal(scrubbed.endpoints[0].headers.authorization, '[stored]');
  });

  it('replaces x-api-key header values with [stored]', () => {
    const input = JSON.stringify({
      endpoints: [{
        headers: { 'x-api-key': 'sk-abc123secret' },
      }],
    });
    const scrubbed = JSON.parse(scrubAuthFromSkillJson(input));
    assert.equal(scrubbed.endpoints[0].headers['x-api-key'], '[stored]');
  });

  it('replaces cookie header values with [stored]', () => {
    const input = JSON.stringify({
      endpoints: [{
        headers: { cookie: 'session=abc123; token=xyz' },
      }],
    });
    const scrubbed = JSON.parse(scrubAuthFromSkillJson(input));
    assert.equal(scrubbed.endpoints[0].headers.cookie, '[stored]');
  });

  it('scrubs sensitive fields from request body templates', () => {
    const input = JSON.stringify({
      endpoints: [{
        headers: { 'content-type': 'application/json' },
        requestBody: {
          template: {
            login: 'user@test.com',
            password: 'secret123',
            csrf_token: 'abc',
            nested: { client_secret: 'xyz' },
          },
        },
      }],
    });
    const scrubbed = JSON.parse(scrubAuthFromSkillJson(input));
    const tpl = scrubbed.endpoints[0].requestBody.template;
    assert.equal(tpl.login, 'user@test.com'); // not sensitive
    assert.equal(tpl.password, '[scrubbed]');
    assert.equal(tpl.csrf_token, '[scrubbed]');
    assert.equal(tpl.nested.client_secret, '[scrubbed]');
  });

  it('preserves non-sensitive headers', () => {
    const input = JSON.stringify({
      endpoints: [{
        headers: { 'content-type': 'application/json', accept: '*/*' },
      }],
    });
    const scrubbed = JSON.parse(scrubAuthFromSkillJson(input));
    assert.equal(scrubbed.endpoints[0].headers['content-type'], 'application/json');
    assert.equal(scrubbed.endpoints[0].headers.accept, '*/*');
  });
});

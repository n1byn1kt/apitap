// test/discovery/auth.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthRequired } from '../../src/discovery/auth.js';

describe('detectAuthRequired', () => {
  it('detects login form with password input', () => {
    const html = `
      <html><body>
        <form action="/login" method="POST">
          <input type="text" name="username">
          <input type="password" name="password">
          <button type="submit">Log in</button>
        </form>
      </body></html>
    `;
    const result = detectAuthRequired(html, 'https://example.com', {});
    assert.equal(result.authRequired, true);
    assert.ok(result.signals.some(s => s.includes('login form')));
  });

  it('detects meta redirect to login path', () => {
    const html = `
      <html>
        <head><meta http-equiv="refresh" content="0;url=/auth/login"></head>
        <body>Redirecting...</body>
      </html>
    `;
    const result = detectAuthRequired(html, 'https://example.com', {});
    assert.equal(result.authRequired, true);
    assert.ok(result.signals.some(s => s.includes('redirect')));
  });

  it('detects OAuth login links', () => {
    const html = `
      <html><body>
        <a href="https://accounts.google.com/o/oauth2/auth?client_id=123">Sign in with Google</a>
      </body></html>
    `;
    const result = detectAuthRequired(html, 'https://example.com', {});
    assert.equal(result.authRequired, true);
    assert.ok(result.signals.some(s => s.includes('OAuth')));
  });

  it('detects 401 status via response header', () => {
    const html = '<html><body>Unauthorized</body></html>';
    const headers = { 'www-authenticate': 'Bearer realm="api"' };
    const result = detectAuthRequired(html, 'https://example.com', headers);
    assert.equal(result.authRequired, true);
    assert.ok(result.signals.some(s => s.includes('WWW-Authenticate')));
  });

  it('returns false for public page', () => {
    const html = `
      <html><body>
        <h1>Welcome to our site</h1>
        <p>Public content here</p>
        <a href="/about">About</a>
      </body></html>
    `;
    const result = detectAuthRequired(html, 'https://example.com', {});
    assert.equal(result.authRequired, false);
    assert.equal(result.signals.length, 0);
  });

  it('detects redirect to /login via Location header', () => {
    const html = '';
    const headers = { location: 'https://example.com/login?redirect=%2Fdashboard' };
    const result = detectAuthRequired(html, 'https://example.com', headers);
    assert.equal(result.authRequired, true);
    assert.ok(result.signals.some(s => s.includes('redirect')));
  });

  it('detects SSO/SAML patterns', () => {
    const html = `
      <html><body>
        <form action="https://sso.company.com/saml/consume" method="POST">
          <input type="hidden" name="SAMLRequest" value="base64data">
        </form>
      </body></html>
    `;
    const result = detectAuthRequired(html, 'https://example.com', {});
    assert.equal(result.authRequired, true);
    assert.ok(result.signals.some(s => s.includes('SSO') || s.includes('SAML')));
  });

  it('returns loginUrl when form action found', () => {
    const html = `
      <form action="/api/v1/login" method="POST">
        <input type="text" name="email">
        <input type="password" name="pass">
      </form>
    `;
    const result = detectAuthRequired(html, 'https://example.com', {});
    assert.equal(result.authRequired, true);
    assert.equal(result.loginUrl, '/api/v1/login');
  });
});

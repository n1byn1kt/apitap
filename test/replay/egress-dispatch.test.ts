// test/replay/egress-dispatch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanOutboundRequest } from '../../src/replay/egress.js';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

test('JSON body: secret in nested field → body_json location + correct path', () => {
  const body = JSON.stringify({
    user: { credentials: { token: SECRET } },
    name: 'alice',
  });
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'POST',
    body,
    contentType: 'application/json',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramLocation, 'body_json');
  assert.equal(findings[0].paramPath, 'body.user.credentials.token');
});

test('JSON body: secret in array element', () => {
  const body = JSON.stringify({ tokens: ['safe', SECRET, 'also_safe'] });
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'POST',
    body,
    contentType: 'application/json',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramPath, 'body.tokens[1]');
});

test('Form body: secret as form field → body_form location', () => {
  const body = `user=alice&token=${encodeURIComponent(SECRET)}`;
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'POST',
    body,
    contentType: 'application/x-www-form-urlencoded',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramLocation, 'body_form');
  assert.equal(findings[0].paramPath, 'body.token');
});

test('Multipart body: secret in text part → body_multipart location', () => {
  const body = `--boundary\r\nContent-Disposition: form-data; name="token"\r\n\r\n${SECRET}\r\n--boundary--`;
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'POST',
    body,
    contentType: 'multipart/form-data; boundary=boundary',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramLocation, 'body_multipart');
});

test('URL query string: secret in param → url_query location', () => {
  const findings = scanOutboundRequest({
    url: `https://api.example.com/submit?token=${encodeURIComponent(SECRET)}&other=safe`,
    method: 'GET',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramLocation, 'url_query');
  assert.equal(findings[0].paramPath, 'query.token');
});

test('Raw body (text/plain): secret flagged with body_raw location', () => {
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'POST',
    body: `The token is ${SECRET}`,
    contentType: 'text/plain',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramLocation, 'body_raw');
});

test('Malformed JSON falls back to raw scan', () => {
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'POST',
    body: `{broken json: ${SECRET}}`,
    contentType: 'application/json',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].paramLocation, 'body_raw');
});

test('No body: no findings from body scan', () => {
  const findings = scanOutboundRequest({
    url: 'https://api.example.com/submit',
    method: 'GET',
    domain: 'api.example.com',
    requestPath: '/submit',
  });
  assert.equal(findings.length, 0);
});

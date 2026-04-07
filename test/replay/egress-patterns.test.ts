// test/replay/egress-patterns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanOutboundRequest } from '../../src/replay/egress.js';

function mk(body: string, contentType = 'text/plain') {
  return {
    url: 'https://api.example.com/submit',
    method: 'POST',
    body,
    contentType,
    domain: 'api.example.com',
    requestPath: '/submit',
  };
}

test('clean request: no findings', () => {
  const findings = scanOutboundRequest(mk('hello world'));
  assert.equal(findings.length, 0);
});

test('SSH private key in raw body: secret_ssh_private_key', () => {
  const body = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scanner, 'secret_ssh_private_key');
  assert.equal(findings[0].severity, 'high');
});

test('OpenSSH private key also triggers secret_ssh_private_key', () => {
  const body = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scanner, 'secret_ssh_private_key');
});

test('PGP private key', () => {
  const body = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGY\n-----END PGP PRIVATE KEY BLOCK-----';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scanner, 'secret_pgp_private_key');
});

test('AWS access key alone', () => {
  const body = 'access_key=AKIAIOSFODNN7EXAMPLE';
  const findings = scanOutboundRequest(mk(body));
  assert.ok(findings.some(f => f.scanner === 'secret_aws_access_key'));
});

test('AWS secret key is context-gated on access key presence', () => {
  // Without access key, the 40-char base64 is not flagged.
  const lonely = 'token=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.equal(scanOutboundRequest(mk(lonely)).length, 0);

  // With access key, both are flagged.
  const both = 'key=AKIAIOSFODNN7EXAMPLE&secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const findings = scanOutboundRequest(mk(both));
  assert.ok(findings.some(f => f.scanner === 'secret_aws_access_key'));
  assert.ok(findings.some(f => f.scanner === 'secret_aws_secret_key'));
});

test('GitHub classic PAT', () => {
  const body = 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scanner, 'secret_github_classic_pat');
});

test('GitHub OAuth token', () => {
  const body = 'token=gho_abcdefghijklmnopqrstuvwxyz0123456789';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_github_oauth_token');
});

test('GitHub server-to-server token (Actions GITHUB_TOKEN)', () => {
  const body = 'token=ghs_abcdefghijklmnopqrstuvwxyz0123456789';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_github_server_to_server');
});

test('GitHub fine-grained PAT', () => {
  const token = 'github_pat_' + 'A'.repeat(82);
  const findings = scanOutboundRequest(mk(`token=${token}`));
  assert.equal(findings[0].scanner, 'secret_github_fine_grained_pat');
});

test('OpenAI key', () => {
  const body = 'api_key=sk-' + 'A'.repeat(48);
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_openai_key');
});

test('Anthropic key', () => {
  const body = 'api_key=sk-ant-abcdefghijklmnopqrstuvwxyz012345';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_anthropic_key');
});

test('Slack token', () => {
  const body = 'token=xoxb-1234567890-abcdef';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_slack_token');
});

test('npm token', () => {
  const body = 'token=npm_' + 'A'.repeat(36);
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_npm_token');
});

test('Tailscale auth key', () => {
  const body = 'auth=tskey-auth-abc123-xyz456def789';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].scanner, 'secret_tailscale_auth_key');
});

test('PII email in body', () => {
  const body = 'contact=user@example.com';
  const findings = scanOutboundRequest(mk(body));
  assert.ok(findings.some(f => f.scanner === 'pii_email' && f.severity === 'medium'));
});

test('REDACTION: serialized egress finding never contains the secret', () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const body = `token=${SECRET}`;
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings.length, 1);
  const serialized = JSON.stringify(findings[0]);
  assert.equal(
    serialized.includes(SECRET),
    false,
    'secret bytes must not appear in serialized finding',
  );
  assert.equal(findings[0].paramPath.includes(SECRET), false);
  assert.equal(typeof findings[0].matchLength, 'number');
  assert.equal(findings[0].matchLength, SECRET.length);
});

test('finding has source="egress" and domain + requestPath', () => {
  const body = 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].source, 'egress');
  assert.equal(findings[0].domain, 'api.example.com');
  assert.equal(findings[0].requestPath, '/submit');
});

test('default action is "pass" (set by caller, not by scanner)', () => {
  const body = 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const findings = scanOutboundRequest(mk(body));
  assert.equal(findings[0].action, 'pass');
});

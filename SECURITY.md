# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ApiTap, please report it responsibly.

**Report via:** [GitHub Security Advisories](https://github.com/n1byn1kt/apitap/security/advisories/new)

**Do NOT** file a public GitHub issue for security vulnerabilities.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** within 48 hours
- **Assessment:** within 7 days
- **Fix:** within 30 days for confirmed vulnerabilities

## Security Model

ApiTap handles sensitive data (API credentials, request headers, response bodies). Here's how we protect it:

### Auth Encryption
Credentials are encrypted at rest using AES-256-GCM (fresh random IV per
encryption, authenticated) with a PBKDF2-SHA512 key derived from the machine
ID and a per-install random salt, stored at `~/.apitap/auth.enc` (mode `0o600`,
directory `0o700`).

**Threat model — be precise about what this protects:** the key is derived
from `/etc/machine-id` (world-readable on most systems) and
`~/.apitap/install-salt` (stored next to the ciphertext). An attacker who
obtains *those files* can re-derive the key. So the encryption is **not** a
defense against an attacker who exfiltrates the `~/.apitap` directory (backup,
sync, stolen disk); the real access control there is the file permissions.
What it does defend against is casual at-rest disclosure (the blob is not
plaintext) and tampering (GCM authentication). For protection against an
attacker who has the files, use full-disk encryption or an OS keychain.

### PII / Secret Scrubbing
During capture, request/response bodies, URL query parameters, and example URLs
are scrubbed before being written to skill files. Patterns include emails,
phone numbers (US + international), IPv4/IPv6 addresses, credit-card and SSN
numbers, IBANs, JWTs/bearer/basic tokens, cloud-provider keys (AWS/GCP), and
provider-prefixed secrets (Stripe, GitHub, Slack, GitLab). Body/query field
names matching credential stems (password, secret, token, apikey, … including
camelCase/prefixed variants) are redacted by name regardless of value.
Credential / payment / account-security URL paths (password, 2fa, checkout,
payment, billing, account/security) are not captured at all. Scrubbing is
pattern-based and best-effort — it will not catch every possible secret format.

### SSRF Protection
The replay engine validates all URLs against private IP ranges, internal
hostnames, IPv6 reserved ranges (including `::`, NAT64, site-local, IPv4-mapped),
and non-HTTP schemes. DNS is resolved and the resolved IP re-validated before
and after the fetch (DNS-rebinding defense), and redirects are followed manually
one hop with per-hop re-validation and cross-domain header stripping.

### Skill File Signing
Skill files are signed with HMAC-SHA256, covering the file contents **and** the
`provenance` field. Provenance states: `self` (all endpoints captured locally),
`imported-signed` (contains imported endpoints; locally re-signed),
`unsigned` (no signature, rejected on load unless `--trust-unsigned`).
Relabelling a file does not bypass verification, and imported endpoints cannot
inherit `self` trust. Import validation includes signature verification and
SSRF scanning.

**Signing threat model:** signatures protect against external tampering and
file corruption, *not* same-user processes — any process running as the same
user can derive the signing key (same machine-id + install-salt as above). This
is the standard Unix same-user trust boundary.

### Read-Only Capture
Playwright intercepts responses only via Chrome DevTools Protocol. No requests are modified, no code is injected into pages.

### No Telemetry
ApiTap runs entirely locally. No data is sent to external services.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

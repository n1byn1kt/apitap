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
Credentials are encrypted at rest using AES-256-GCM with PBKDF2 key derivation, stored at `~/.apitap/auth.enc`. Keys are derived from machine-specific entropy.

### PII Scrubbing
During capture, response bodies are scanned for emails, phone numbers, IP addresses, credit card numbers, and SSNs. Detected PII is redacted before writing skill files.

### SSRF Protection
The replay engine validates all URLs against private IP ranges, internal hostnames, and non-HTTP schemes. DNS rebinding protection is included.

### Skill File Signing
Skill files are signed with HMAC-SHA256. Three provenance states: `self` (captured locally), `imported` (from external source), `unsigned` (no signature). Import validation includes signature verification and SSRF scanning.

### Read-Only Capture
Playwright intercepts responses only via Chrome DevTools Protocol. No requests are modified, no code is injected into pages.

### No Telemetry
ApiTap runs entirely locally. No data is sent to external services.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

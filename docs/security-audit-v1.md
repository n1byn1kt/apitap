# ApiTap Pre-Release Security Audit Report

**Date:** 2026-02-11
**Version audited:** 1.0.0 (master branch)
**Auditor:** Security review via code analysis

---

## CRITICAL Findings

### [CRITICAL] F1: SSRF Validation Not Enforced in Replay Path
**Location:** `src/replay/engine.ts:244`, `src/mcp.ts:132-196`
**Description:** The SSRF validation functions in `src/skill/ssrf.ts` exist but are **never called** in the replay pipeline. `replayEndpoint()` constructs a URL from `skill.baseUrl` + `endpoint.path` and calls `fetch()` directly with no SSRF check. The MCP tools `apitap_replay`, `apitap_replay_batch`, and `apitap_browse` all invoke `replayEndpoint()` without pre-validating URLs.

SSRF validation is only used during:
- `apitap import` CLI command (cli.ts:435)
- Discovery pipeline (discovery/fetch.ts:32)
- Skill file import validation (importer.ts:50)

**Exploit scenario:** An attacker crafts a malicious skill file with `baseUrl: "http://169.254.169.254"` (AWS metadata service) and shares it. When the victim loads and replays it, the replay engine fetches cloud credentials from the metadata endpoint and returns them as JSON data to the attacker's LLM client.

**Recommendation:** Call `resolveAndValidateUrl()` in `replayEndpoint()` before every `fetch()`, or validate the constructed URL at the point of use. Also validate in `replayMultiple()`.

**Effort:** Low

---

### [CRITICAL] F2: OAuth Refresh Sends Credentials to Attacker-Controlled URL
**Location:** `src/auth/oauth-refresh.ts:45`
**Description:** The `refreshOAuth()` function sends `client_secret` and `refresh_token` to `oauthConfig.tokenEndpoint`, which is read from the skill file. There is no SSRF validation or even domain verification on this URL.

**Exploit scenario:** A malicious shared skill file sets `auth.oauthConfig.tokenEndpoint` to `https://evil.com/steal`. When the victim's system tries to refresh an OAuth token, it POSTs the stored `client_secret` and `refresh_token` to the attacker's server.

**Recommendation:**
1. Validate `tokenEndpoint` against SSRF using `resolveAndValidateUrl()`.
2. Verify that the token endpoint domain matches the skill file's domain (or a well-known OAuth provider list).

**Effort:** Low

---

### [CRITICAL] F3: DNS Rebinding TOCTOU in SSRF Protection
**Location:** `src/skill/ssrf.ts:112-144`
**Description:** `resolveAndValidateUrl()` resolves the hostname to an IP and checks it against private ranges, but then the actual `fetch()` call resolves DNS independently. An attacker's DNS server can return a public IP on the first query (passing validation) and a private IP (e.g., `127.0.0.1`) on the second query (used by `fetch()`). DNS TTL=0 makes this trivial.

**Exploit scenario:** Attacker registers `evil.com` with a DNS server that alternates between `203.0.113.1` (public) and `169.254.169.254` (AWS metadata). The SSRF check passes, then `fetch()` resolves to the metadata service.

**Recommendation:** Use `dns.lookup()` to resolve the hostname, validate the IP, then connect directly to that IP (set `Host` header manually), or use Node.js `fetch()` with a custom `lookup` function that pins the resolved IP.

**Effort:** Medium

---

## HIGH Findings

### [HIGH] F4: Signature Verification Never Enforced on Skill File Load
**Location:** `src/skill/store.ts:43-53`
**Description:** `readSkillFile()` performs `JSON.parse(content) as SkillFile` with zero validation. Signature verification only happens during the `import` command. Locally generated skill files are signed (`session.ts:219`), but when read back for replay, the signature is ignored.

A tampered skill file on disk (modified `baseUrl`, injected headers, changed endpoints) will be loaded and replayed without detection. The signature infrastructure exists but is purely decorative for the primary replay use case.

**Exploit scenario:** Malware modifies `~/.apitap/skills/api.example.com.json` to add an endpoint that exfiltrates data. Since signature is never checked on load, the tampered file is replayed without warning.

**Recommendation:** Add a `readSkillFileVerified(domain, key)` function that verifies signature on load. Use it in the replay path. Warn or reject unsigned/tampered files based on a configurable policy.

**Effort:** Low

---

### [HIGH] F5: No Timeout on Replay Engine fetch() Calls
**Location:** `src/replay/engine.ts:244-248`, `src/replay/engine.ts:267-271`
**Description:** Neither `fetch()` call in the replay engine uses `AbortSignal.timeout()` or any other timeout mechanism. A malicious or slow endpoint can hang the process indefinitely.

Compare with the verifier (`verifier.ts:53`) which correctly uses `AbortSignal.timeout(5000)`, and discovery (`fetch.ts:42`) which uses an abort controller.

**Exploit scenario:** A skill file points to an endpoint that accepts the connection but never responds (slowloris-style). The MCP server process hangs permanently, denying service to the LLM client.

**Recommendation:** Add `signal: AbortSignal.timeout(30_000)` (or configurable) to both fetch calls in the replay engine.

**Effort:** Low

---

### [HIGH] F6: Incomplete IPv6 Private Range Blocking in SSRF
**Location:** `src/skill/ssrf.ts:43-75`
**Description:** The SSRF validation checks for IPv6 loopback (`::1`) but misses:
- Link-local: `fe80::/10`
- Unique local (private): `fc00::/7` (includes `fd00::/8`)
- IPv4-mapped IPv6 in `validateUrl()`: `::ffff:127.0.0.1` passes the sync check (only `isPrivateIp()` handles it, used only in the async path)
- `0.0.0.0` — not blocked in `validateUrl()` (only in `isPrivateIp()`)

**Exploit scenario:** Attacker uses `http://[::ffff:169.254.169.254]/latest/meta-data/` in a skill file. The sync `validateUrl()` check (used in importer) passes because it only checks `::1` for IPv6.

**Recommendation:** Block all RFC 4193 (fc00::/7), RFC 4291 link-local (fe80::/10), IPv4-mapped addresses, and `0.0.0.0` in `validateUrl()`.

**Effort:** Low

---

### [HIGH] F7: Arbitrary URL Navigation in Interactive Capture Session
**Location:** `src/capture/session.ts:131-133`
**Description:** The `navigate` action in `CaptureSession.interact()` passes the URL directly to `page.goto()` without any validation. The MCP tool `apitap_capture_interact` accepts a `url` parameter from the LLM client and passes it through.

**Exploit scenario:** A malicious LLM client sends `{ action: "navigate", url: "file:///etc/passwd" }` or `{ action: "navigate", url: "javascript:..." }` to read local files or execute code in the browser context. While Playwright blocks `javascript:` by default, `file://` access depends on browser configuration.

**Recommendation:** Validate the URL scheme (must be `http:` or `https:`) and run SSRF validation before navigation.

**Effort:** Low

---

### [HIGH] F8: Malicious Skill File Can Inject Arbitrary HTTP Headers
**Location:** `src/replay/engine.ts:167`, `src/mcp.ts:159`
**Description:** Endpoint headers from skill files are merged directly into the `fetch()` request. In `mcp.ts:159`, the `[stored]` placeholder is replaced with real auth credentials, but other headers from the skill file pass through unmodified. A malicious skill file can inject any HTTP headers.

**Exploit scenario:** An imported skill file injects `Host: internal-service.corp` header to redirect requests through a proxy that routes based on Host header, accessing internal services. Or injects `X-Forwarded-For: 127.0.0.1` to bypass IP-based access controls on the target.

**Recommendation:** Implement a header allowlist for replay requests. Only allow safe headers: `accept`, `content-type`, `authorization` (from stored auth only), `x-api-key` (from stored auth only), and explicitly approved custom headers.

**Effort:** Medium

---

### [HIGH] F9: Fixed PBKDF2 Salt Weakens Key Derivation
**Location:** `src/auth/crypto.ts:15`
**Description:** `PBKDF2_SALT` is hardcoded to `'apitap-v0.2-key-derivation'`. All ApiTap installations use the same salt. The salt's purpose is to prevent rainbow table attacks, but a fixed salt means an attacker can precompute the key for all possible machine IDs.

Combined with the `getMachineId()` fallback (`hostname()-homedir()`), which has low entropy on many systems (e.g., `MacBook-Pro-/Users/john`), this significantly weakens the encryption.

**Exploit scenario:** An attacker who obtains the `auth.enc` file can precompute PBKDF2 for common hostname+homedir combinations using the known fixed salt, then decrypt all stored credentials.

**Recommendation:** Generate a random salt per installation and store it alongside the encrypted file (or use a random salt per encryption operation, which is already done for IV).

**Effort:** Medium

---

## MEDIUM Findings

### [MEDIUM] F10: PII Scrubber Missing Several Sensitive Data Patterns
**Location:** `src/capture/scrubber.ts`
**Description:** The scrubber catches emails, SSNs, credit cards, IPs, and phones. It misses:
- **JWTs** — `eyJhbGci...` tokens contain PII in the payload (name, email, sub)
- **API keys** — `sk-`, `pk_`, `AKIA...` (AWS), `ghp_` (GitHub) prefixed tokens
- **Base64-encoded data** — An email `am9obkBleGFtcGxlLmNvbQ==` bypasses the email regex
- **Session IDs in URLs** — `/session/abc123def456`
- **Names and addresses** — Not pattern-matchable (acknowledged limitation)

The scrubber also doesn't recursively process nested JSON objects in `scrubPII()` (the `scrubBody()` function in generator.ts handles recursion separately).

**Recommendation:** Add JWT detection/redaction, common API key prefix patterns, and document the limitations clearly so users understand what gets through.

**Effort:** Medium

---

### [MEDIUM] F11: No Rate Limiting or Resource Controls on MCP Server
**Location:** `src/mcp.ts`
**Description:** The MCP server has no rate limiting on any tool. `MAX_SESSIONS = 3` limits concurrent capture sessions, but:
- `apitap_replay` can be called unlimited times per second
- `apitap_capture` spawns a child process with no concurrency limit
- `apitap_browse` runs discovery + replay per call with no deduplication
- `apitap_replay_batch` accepts an unbounded array of requests

**Exploit scenario:** A malicious or buggy LLM client floods the server with replay requests, consuming all available network connections, memory (response bodies held in memory), and potentially triggering rate limits or IP bans from target APIs.

**Recommendation:** Add per-domain rate limiting (e.g., max 10 requests/second) and cap batch request array size. Consider adding global concurrency limits.

**Effort:** Medium

---

### [MEDIUM] F12: Redirect Following Without Re-validation in Discovery/Replay
**Location:** `src/discovery/fetch.ts:51`, `src/replay/engine.ts:244`
**Description:** `safeFetch()` uses `redirect: 'follow'` after SSRF validation. The replay engine uses default fetch behavior (also follows redirects). If the initial URL passes SSRF validation but the server responds with `302 Location: http://169.254.169.254/`, the redirect is followed without re-checking.

**Exploit scenario:** A compromised API endpoint returns a redirect to the cloud metadata service. The SSRF check passes on the original URL, but the redirect targets an internal resource.

**Recommendation:** Use `redirect: 'manual'` and validate each redirect target URL before following it, or block redirects entirely in the replay engine.

**Effort:** Medium

---

### [MEDIUM] F13: Machine ID Fallback Has Insufficient Entropy
**Location:** `src/auth/manager.ts:130-140`
**Description:** On non-Linux systems, `getMachineId()` falls back to `${hostname()}-${homedir()}`. This produces values like `MacBook-Pro-/Users/alice` or `DESKTOP-ABC123-C:\Users\Bob`. Combined with the fixed PBKDF2 salt (F9), this means the encryption key is highly predictable for an attacker who knows the target's username and hostname.

**Recommendation:** Use platform-specific machine identifiers: macOS `IOPlatformUUID` via `ioreg`, Windows `MachineGuid` from registry. Or generate a random key on first run and store it protected by OS keychain.

**Effort:** Medium

---

### [MEDIUM] F14: Domain Parameter Path Traversal in Skill File Store
**Location:** `src/skill/store.ts:14`
**Description:** `skillPath()` does `join(skillsDir, \`${domain}.json\`)`. The `domain` parameter comes from MCP tool input (`apitap_replay`, `apitap_search`) and is not sanitized. While the `.json` extension limits the practical impact, a value like `../../.apitap/auth` would attempt to read `~/.apitap/auth.json`.

**Exploit scenario:** A malicious LLM client calls `apitap_replay` with `domain: "../../etc/secrets"` to probe for files. The `.json` suffix limits this to JSON files, but error messages could leak path information.

**Recommendation:** Validate that `domain` contains only valid domain characters (`[a-zA-Z0-9.-]`). Reject domains with path separators.

**Effort:** Low

---

### [MEDIUM] F15: Credentials Remain in Memory After Use
**Location:** `src/auth/manager.ts:101-109`, `src/replay/engine.ts:167-204`
**Description:** Decrypted credentials (auth tokens, cookies, OAuth secrets) are loaded into JavaScript strings and remain in memory until garbage collected. The `loadAll()` method returns a full `Record<string, StoredAuth>` object. In the replay engine, auth headers with credential values are added to the `headers` object which may persist.

Node.js strings are immutable and not explicitly wipeable, making this a platform limitation, but the code makes no effort to minimize credential lifetime or scope.

**Recommendation:** Load only the specific domain's credentials rather than all domains. Consider using `Buffer` for sensitive values where possible (can be explicitly zeroed). Document this as a known limitation.

**Effort:** High (platform limitation)

---

## LOW Findings

### [LOW] F16: Silent Error Swallowing in AuthManager.loadAll()
**Location:** `src/auth/manager.ts:107-109`
**Description:** `loadAll()` catches all exceptions and returns `{}`. This silently masks key derivation errors, corrupted files, and permission issues. An attacker who corrupts `auth.enc` causes the system to behave as if no credentials exist, potentially leading to failed replays without clear diagnostics.

**Recommendation:** Distinguish between "file not found" (return `{}`) and "decryption failed" (log warning or throw).

**Effort:** Low

---

### [LOW] F17: Verifier Replays Requests to Arbitrary URLs Without SSRF Checks
**Location:** `src/capture/verifier.ts:51`, `src/capture/verifier.ts:108`
**Description:** `verifySingle()` and `verifySinglePost()` call `fetch(url)` using `endpoint.examples.request.url` without SSRF validation. These are URLs from the captured exchanges, so they normally point to external APIs, but if a skill file is tampered with, the verifier could be used for SSRF.

This is lower severity because verification happens during capture (with locally generated data) rather than with imported skill files, but the verifier is also called in `session.ts:216` during `finish()`.

**Recommendation:** Add SSRF validation in `verifySingle()` and `verifySinglePost()`.

**Effort:** Low

---

### [LOW] F18: CDP Connection to Default Ports Without Authentication
**Location:** `src/capture/monitor.ts:38-39`
**Description:** The capture monitor tries to connect to CDP on ports `18792, 18800, 9222` on localhost without any authentication. Any process listening on these ports would be connected to and intercepted.

**Exploit scenario:** A local attacker starts a malicious CDP-speaking process on port 9222 to inject false API traffic into ApiTap captures.

**Recommendation:** Document this behavior. Consider requiring explicit `--port` when attaching to existing browsers.

**Effort:** Low

---

### [LOW] F19: Error Messages May Leak Internal Paths
**Location:** `src/mcp.ts:100,190,310,358,471,519`
**Description:** Several MCP error handlers return `err.message` directly to the LLM client. This could leak filesystem paths, internal IP addresses, or other system information depending on the error type.

**Recommendation:** Sanitize error messages before returning them via MCP. Log full errors server-side and return generic messages to clients.

**Effort:** Low

---

## INFO Observations

### [INFO] I1: Dependency Versions Are Current
Playwright 1.58.1, @modelcontextprotocol/sdk 1.26.0, and Zod 4.3.6 are recent versions. The minimal dependency tree significantly reduces supply chain attack surface. No known CVEs detected for current versions.

### [INFO] I2: File Permissions Correctly Set on Auth Store
`auth.enc` is written with mode `0o600` and `chmod()` is called after write to enforce permissions even on existing files. This is good practice.

### [INFO] I3: Timing-Safe HMAC Comparison
`hmacVerify()` correctly uses `timingSafeEqual()` after length check. The length check leaks signature length but not content, which is acceptable.

### [INFO] I4: Auth Headers Correctly Stripped from Skill Files
The generator replaces auth header values with `[stored]` placeholder and uses entropy-based detection for non-standard auth headers. This prevents accidental credential inclusion in shareable skill files.

### [INFO] I5: AES-256-GCM Implementation Correct
Random IV per encryption, auth tag stored and verified on decrypt, authenticated encryption mode. The core crypto is sound (issues are with key derivation, not the cipher).

---

## Prioritized Remediation Plan

### Must fix before v1.0 public release:

| Priority | Finding | Effort | Impact if unpatched |
|----------|---------|--------|---------------------|
| **P0** | F1: SSRF not enforced in replay path | Low | Full SSRF exploitation via shared skill files |
| **P0** | F2: OAuth refresh credential exfiltration | Low | Credential theft via malicious skill files |
| **P0** | F5: No fetch timeout in replay | Low | Process hang / DoS |
| **P0** | F6: Incomplete IPv6 SSRF blocking | Low | SSRF bypass via IPv6 |
| **P0** | F7: Arbitrary URL navigation in sessions | Low | Local file read via MCP |
| **P1** | F3: DNS rebinding TOCTOU | Medium | SSRF bypass via DNS rebinding |
| **P1** | F8: Arbitrary header injection from skill files | Medium | Access control bypass on target APIs |
| **P1** | F12: Redirect following without re-validation | Medium | SSRF bypass via redirect |
| **P1** | F14: Domain parameter path traversal | Low | Information disclosure |

### Should fix before general availability:

| Priority | Finding | Effort |
|----------|---------|--------|
| **P2** | F4: Signature verification not enforced on load | Low |
| **P2** | F9: Fixed PBKDF2 salt | Medium |
| **P2** | F10: PII scrubber gaps | Medium |
| **P2** | F13: Machine ID fallback entropy | Medium |
| **P2** | F17: Verifier SSRF | Low |

### Nice to have:

| Priority | Finding | Effort |
|----------|---------|--------|
| **P3** | F11: Rate limiting | Medium |
| **P3** | F15: Credential memory lifetime | High |
| **P3** | F16: Silent error swallowing | Low |
| **P3** | F18: CDP port authentication | Low |
| **P3** | F19: Error message sanitization | Low |

---

## Overall Security Posture: 4/10

**Justification:** The project demonstrates good security *awareness* — SSRF validation, PII scrubbing, credential encryption, HMAC signing, and file permission hardening all exist. However, the most critical security control (SSRF validation in the replay path) is **not wired up** where it matters most. A shared malicious skill file can exploit SSRF, exfiltrate stored OAuth credentials, inject arbitrary headers, and hang the process — all via the primary usage path (MCP replay). The cryptographic implementation is sound but key derivation has material weaknesses. The gap between security infrastructure that exists and security enforcement that is actually applied is the primary concern.

---

## Recommended Security Regression Tests

Add these to the test suite:

```
test/security/ssrf-replay.test.ts
  - replayEndpoint() with baseUrl targeting 127.0.0.1 → must reject
  - replayEndpoint() with baseUrl targeting 169.254.169.254 → must reject
  - replayEndpoint() with baseUrl targeting [::1] → must reject
  - replayEndpoint() with baseUrl targeting ::ffff:127.0.0.1 → must reject
  - replayEndpoint() with baseUrl targeting fd00::1 → must reject
  - replayEndpoint() with baseUrl targeting 0.0.0.0 → must reject

test/security/ssrf-oauth.test.ts
  - refreshOAuth() with tokenEndpoint targeting private IP → must reject
  - refreshOAuth() with tokenEndpoint on different domain than skill → must reject/warn

test/security/ssrf-redirect.test.ts
  - replay following redirect to private IP → must reject
  - discovery fetch following redirect to private IP → must reject

test/security/header-injection.test.ts
  - skill file with Host header override → must be stripped
  - skill file with X-Forwarded-For injection → must be stripped
  - skill file headers limited to allowlist

test/security/path-traversal.test.ts
  - readSkillFile("../../etc/passwd") → must reject
  - readSkillFile("../auth") → must reject
  - domain parameter with path separators → must reject

test/security/session-navigation.test.ts
  - navigate action with file:// URL → must reject
  - navigate action with javascript: URL → must reject
  - navigate action with private IP → must reject

test/security/scrubber.test.ts
  - JWT in response body → must be redacted
  - AWS key (AKIA...) → must be redacted
  - GitHub token (ghp_...) → must be redacted

test/security/timeout.test.ts
  - replay to non-responding endpoint → must timeout within 30s

test/security/signature.test.ts
  - load tampered skill file → must warn or reject
  - load skill file with valid signature → must pass
  - load skill file with invalid signature → must reject
```

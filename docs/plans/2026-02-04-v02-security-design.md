# ApiTap v0.2 Security Design

**Date:** 2026-02-04
**Status:** Approved via brainstorming session

---

## 1. Domain-Only Capture (Default)

**Problem:** Currently `page.on('response')` captures all traffic from all domains and filters post-hoc. This leaks cross-tab and cross-origin data through the pipeline.

**Design:**
- Extract the target domain from the URL passed to `apitap capture <url>`
- In the response handler, check `new URL(response.url()).hostname` against the target domain *before processing*
- Domain matching: exact match OR dot-prefix suffix match (`.example.com`). This prevents `evil-example.com` from matching `example.com`
- New flag: `--all-domains` bypasses this filter (opt-out)
- Existing blocklist filter still applies on top — even with `--all-domains`, analytics domains are blocked
- Public suffix edge cases (`.co.uk`, `.com.au`): simple suffix matching is fine for v0.2 — a proper PSL library is overkill

**Changes:** `src/capture/monitor.ts` (domain gate in response handler), `src/cli.ts` (new `--all-domains` flag)

---

## 2. Auth Separation & Encrypted Storage

**Problem:** Authorization headers stored plaintext in skill files (`endpoint.headers` and `endpoint.examples.request.headers`). Anyone who gets the skill file gets the tokens.

**Design:**

### Storage Layout

```
~/.apitap/
├── skills/
│   └── api.example.com.json    ← no secrets, safe to share
└── auth.enc                    ← AES-256-GCM encrypted, all domains
```

### Capture Flow

In `skill/generator.ts`, when processing headers:
- Detect auth headers (`authorization`, `x-api-key`, custom auth patterns)
- Strip them from skill file's `headers` and `examples.request.headers`
- Replace with placeholder: `"authorization": "[stored]"` — signals auth exists but isn't inline
- Pass extracted credentials to `auth/manager.ts` for encrypted storage

### Encrypted Storage

- Single file `~/.apitap/auth.enc` — JSON object keyed by domain
- Each domain entry: `{ type: "bearer" | "api-key" | "cookie", header: string, value: string }`
- Encryption: AES-256-GCM via Node's `crypto` module (stdlib, no deps)
- Key derivation: PBKDF2 with `/etc/machine-id` (or equivalent) as input, random salt stored alongside ciphertext, 100K iterations. Raw machine ID is low entropy — PBKDF2 stretching is essential
- File format: `{ salt: hex, iv: hex, ciphertext: hex, tag: hex }`
- File permissions: `0600` on write

### Cookie Handling

Cookies are trickier than Bearer/API-key headers — they're often set by the browser via `Set-Cookie` response headers, not sent explicitly. The capture flow intercepts relevant cookies from the CDP cookie jar (via Playwright's `context.cookies()`) for the target domain, not just request headers.

### Replay Flow

In `replay/engine.ts`:
- Before executing fetch, check `auth/manager.ts` for credentials matching the domain
- Merge stored auth headers into the request
- If no stored auth and skill file has `"[stored]"` placeholder, warn: "Auth required but not found. Run `apitap capture <domain>` to re-capture credentials."

### Known Limitations (v0.2)

- **Auth is per-domain, not per-endpoint** — some sites use different auth for different endpoints (public API vs user API vs admin API). Domain-keyed structure works for MVP. Schema should allow per-endpoint auth overrides in v0.3.
- **Machine-ID-derived key is non-portable** — moving `~/.apitap/` to another machine means auth can't decrypt. Future: `apitap auth export --password` for migration (v0.3).
- **No token refresh** — captured tokens expire. Future: `apitap capture <domain> --auth-only` for quick re-auth without re-capturing endpoints (v0.3).

**New files:** `src/auth/crypto.ts`, `src/auth/manager.ts`

---

## 3. Response Previews Off by Default

**Problem:** `responsePreview` in skill files can contain PII — actual response data (first 2 array items, full objects up to 500 chars).

**Design:**
- Default: set `responsePreview` to `null` — capture response *shape* (type + field names) but not actual data
- New flag: `--preview` on `apitap capture` enables the current behavior
- `responseShape` (type + field list) is always captured — that's the real value for agents. Field names + types tell the agent everything it needs to decide whether to call an endpoint

**Changes:** `src/skill/generator.ts` (conditional preview), `src/cli.ts` (new `--preview` flag)

---

## 4. PII Scrubbing

**Problem:** Even with previews off, PII can appear in URL paths, query params, and header values.

**Design:**

New module: `src/capture/scrubber.ts`

### Detection Patterns

| Pattern | Regex | Replacement |
|---------|-------|-------------|
| Email | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | `[email]` |
| Phone (intl) | `\+[1-9]\d{7,14}` (requires `+` prefix) | `[phone]` |
| Phone (US) | `\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}` | `[phone]` |
| IPv4 | `\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b` with octet ≤ 255 validation | `[ip]` |
| Credit card | `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b` | `[card]` |
| SSN (US) | `\b\d{3}-\d{2}-\d{4}\b` | `[ssn]` |

**Phone regex note:** Require `+` prefix for international format, or common US separators. Bare `\d{8,15}` is too greedy — matches product IDs, timestamps, order numbers.

**IPv4 note:** Each octet validated ≤ 255. Prevents false positives on version strings.

### Where It Runs

Applied in `skill/generator.ts` during `addExchange()`, after response shape extraction but before storing examples. Scrubs: URL path, query param example values, response preview (when `--preview` is on). Does NOT scrub: header names, response shape field names (structural, not data).

**Principle:** Better to over-redact than leak. False positives are annoying but harmless. False negatives are privacy incidents.

**Flag:** `--no-scrub` disables for users who need raw data. Default is on.

**Changes:** New `src/capture/scrubber.ts`, integration in `src/skill/generator.ts`

---

## 5. Import Trust Boundary

**Problem:** A malicious skill file could contain SSRF URLs or tampered endpoints.

**Design:**

New command: `apitap import <file>`

### Validation Pipeline

1. **Signature check** — if signed, verify. If signature invalid, hard reject ("file was tampered with")
2. **Unsigned warning** — "This skill file was not generated by your ApiTap instance. Review before use."
3. **SSRF validation** — scan all `baseUrl` and endpoint URLs for dangerous patterns:
   - Private IPs: `127.0.0.1`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x` (link-local), `::1`
   - Internal hostnames: `localhost`, `*.local`, `*.internal`
   - Non-HTTP schemes: `file://`, `ftp://`, `gopher://`
   - Reject with clear error: "Skill file contains internal/private URLs — this could be an SSRF attack"
4. **Confirmation prompt** — display summary (domain, endpoint count, base URL), require explicit `y` to copy into `~/.apitap/skills/`
5. **Provenance tracking** — imported files stored with `provenance: "imported"` (not signed with local key)

### DNS Rebinding (Future)

Static URL check at import time catches `127.0.0.1` and `localhost`, but a skill file could contain `evil.com` which resolves to `127.0.0.1` at replay time. For v0.2, the static URL check is sufficient. The replay engine should eventually resolve and validate the target IP before sending the request (v0.3).

### Three-State Provenance

Skill files carry a provenance field:
- `"self"` — generated by this ApiTap instance, signature valid
- `"imported"` — imported via `apitap import`, not locally generated
- `"unsigned"` — no signature (legacy or stripped)

This is clearer than a boolean `signed: true/false` — distinguishes "mine, verified" from "mine, broken" from "someone else's."

**CLI flags:**
- `apitap import <file>` — interactive confirmation
- `apitap import <file> --yes` — skip confirmation (scripted use, still runs SSRF validation)
- `apitap show <domain>` gains a provenance indicator

**New files:** `src/skill/importer.ts`, `src/skill/ssrf.ts`

---

## 6. Auto-Generated .gitignore

**Problem:** Accidental `git add` of `~/.apitap/auth.enc` could commit encrypted credentials.

**Design:**

On first write to `~/.apitap/`, create `.gitignore` if missing:

```
# ApiTap — prevent accidental credential commits
auth.enc
*.key
```

Skill files are NOT gitignored — with auth separation, they're safe to share.

Also create `.gitignore` in `~/.apitap/skills/` (informational):

```
# Skill files in this directory are safe to share (no secrets)
# Auth credentials are stored separately in ../auth.enc (encrypted)
```

**Trigger:** `writeSkillFile()` and `writeAuth()` both call a shared `ensureGitignore()` helper. Idempotent — only writes if missing.

**Changes:** `src/skill/store.ts` (add `ensureGitignore()`)

---

## 7. Skill File Signing

**Problem:** No way to verify a skill file hasn't been tampered with or was generated by a different instance.

**Design:**

HMAC-SHA256 signature appended to skill files on write.

- Key: derived from same machine-ID + PBKDF2 setup as auth encryption (shared `src/auth/crypto.ts`)
- Signed payload: canonical JSON of skill file (everything except `signature` and `provenance` fields)
- Stored in skill file: `"signature": "hmac-sha256:<hex>"`
- Verification: `verifySignature(skillFile)` returns `true` if matches, `false` if tampered/foreign

This is NOT cryptographic proof of identity — it's tamper detection. Answers: "was this file generated by *this* ApiTap instance on *this* machine?"

**New files:** `src/skill/signing.ts`
**Changes:** `src/skill/store.ts` (sign on write), `src/types.ts` (add `signature` and `provenance` fields)

---

## Schema Changes (v1.0 → v1.1)

New fields on `SkillFile`:
```typescript
{
  // ... existing fields ...
  signature?: string;            // "hmac-sha256:<hex>" or undefined
  provenance: "self" | "imported" | "unsigned";
}
```

New fields on `SkillEndpoint.headers`:
```typescript
{
  authorization: "[stored]";     // placeholder, actual value in auth.enc
}
```

Backward compatible — v1.0 files without `signature`/`provenance` treated as `"unsigned"`.

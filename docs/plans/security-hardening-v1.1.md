# Security Hardening Plan — ApiTap v1.1

## Context

DeepWiki auto-generated a security analysis of ApiTap from our code + `docs/security-audit-v1.md`. 
It identified 19 findings. We already fixed 6 P0 issues before v1.0.0 launch. This plan addresses 
the remaining HIGH and MEDIUM findings to harden ApiTap for general availability.

**Current security posture: 7/10** → Target: **9/10**

## What's Already Fixed (v1.0.0 — DO NOT RE-FIX)

These P0s are already resolved in the shipped code. Verify they exist but don't touch them:

| ID | Finding | Fix Location |
|----|---------|-------------|
| F1 | SSRF in replay path | `src/replay/engine.ts:171` — `resolveAndValidateUrl()` before fetch |
| F2 | OAuth credential exfiltration | `src/auth/oauth-refresh.ts:48` — SSRF check + domain match validation |
| F5 | No fetch timeout | `src/replay/engine.ts:260,284` — `AbortSignal.timeout(30_000)` |
| F6 | IPv6 private range blocking | `src/skill/ssrf.ts:54-60` — hex-form IPv4-mapped + `0.0.0.0` |
| F7 | Arbitrary URL navigation | Partially — initial URL validated but `navigate` action still unchecked |
| F14 | Domain path traversal | `src/skill/store.ts:15` — regex validation `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` |

---

## Fixes To Implement (This Session)

### Fix 1: Capture Session Navigate SSRF (F7 — HIGH)

**File:** `src/capture/session.ts`  
**Line:** ~131-141  
**Problem:** The `navigate` action passes URL directly to `page.goto()` without validation. An LLM client could send `file:///etc/passwd` or internal IPs.

**Fix:**
```typescript
case 'navigate': {
  if (!action.url) return { success: false, error: 'url required for navigate', snapshot: await this.takeSnapshot() };
  
  // Validate URL before navigation — block non-HTTP schemes and private IPs
  const { validateUrl } = await import('../skill/ssrf.js');
  const urlCheck = validateUrl(action.url);
  if (!urlCheck.safe) {
    return { success: false, error: `Navigation blocked: ${urlCheck.reason}`, snapshot: await this.takeSnapshot() };
  }
  
  await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
  // ...
}
```

**Tests to add:** `test/capture/session-navigate-ssrf.test.ts`
- Block `file:///etc/passwd`
- Block `http://169.254.169.254/latest/meta-data`  
- Block `http://localhost:8080`
- Allow `https://example.com`

---

### Fix 2: Replay Header Injection (F8 — HIGH)

**File:** `src/replay/engine.ts`  
**Line:** ~179  
**Problem:** Endpoint headers from skill files merge directly into `fetch()`. A malicious skill file could inject `Host`, `X-Forwarded-For`, or other dangerous headers to bypass target API access controls.

**Fix:** Add a header allowlist. Only permit safe headers from skill files:
```typescript
const ALLOWED_SKILL_HEADERS = new Set([
  'accept', 'accept-language', 'accept-encoding',
  'content-type', 'content-length',
  'x-requested-with', 'x-api-key',
  'origin', 'referer',
  'user-agent',
  // Auth headers are injected separately from encrypted storage, not from skill file
]);

const BLOCKED_HEADERS = new Set([
  'host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'forwarded', 'via',
  'cookie', 'set-cookie',
  'authorization',  // Must come from auth manager, not skill file
  'proxy-authorization',
  'transfer-encoding', 'te', 'trailer',
  'connection', 'upgrade',
]);

// In replayEndpoint(), after `const headers = { ...endpoint.headers };`
for (const key of Object.keys(headers)) {
  const lower = key.toLowerCase();
  if (BLOCKED_HEADERS.has(lower) || (!ALLOWED_SKILL_HEADERS.has(lower) && !lower.startsWith('x-'))) {
    delete headers[key];
  }
}
```

**Note:** `authorization` is blocked from SKILL FILE headers — it's injected separately by the auth manager from encrypted storage. This is intentional: credentials in skill files would be a security antipattern.

**Tests to add:** `test/security/header-injection.test.ts`
- Block `Host` header from skill file
- Block `X-Forwarded-For` from skill file
- Block `Cookie` from skill file
- Block `Authorization` from skill file (must come via auth manager)
- Allow `Accept`, `Content-Type`, `User-Agent`
- Allow custom `X-Custom-Header` (starts with `x-`)

---

### Fix 3: Redirect Following Without Re-validation (F12 — MEDIUM)

**File:** `src/replay/engine.ts`  
**Problem:** `fetch()` follows redirects by default (up to 20). A public endpoint could redirect to `http://169.254.169.254/` and bypass SSRF checks.

**Fix:** Disable automatic redirects, manually validate redirect targets:
```typescript
// Change fetch options to not follow redirects automatically
const response = await fetch(url.toString(), {
  method: endpoint.method.toUpperCase(),
  headers,
  body: finalBody,
  signal: AbortSignal.timeout(30_000),
  redirect: 'manual',  // Don't auto-follow
});

// Handle redirects with SSRF validation
if (response.status >= 300 && response.status < 400) {
  const location = response.headers.get('location');
  if (location) {
    const redirectUrl = new URL(location, url);
    const redirectCheck = await resolveAndValidateUrl(redirectUrl.toString());
    if (!redirectCheck.safe) {
      throw new Error(`Redirect blocked (SSRF): ${redirectCheck.reason}`);
    }
    // Follow the redirect manually (single hop)
    const redirectResponse = await fetch(redirectUrl.toString(), {
      method: 'GET',  // Redirects typically become GET
      headers: { ...headers },  // Forward headers (already filtered)
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',  // Prevent chaining
    });
    // Use redirectResponse for rest of processing
  }
}
```

**Important:** Limit to 1 redirect hop to prevent chains. Log blocked redirects.

**Tests to add:** `test/security/redirect-ssrf.test.ts`
- Redirect to private IP → blocked
- Redirect to AWS metadata → blocked
- Redirect to valid public URL → followed
- Multiple redirect chain → stopped after 1 hop

---

### Fix 4: Signature Verification on Load (F4 — HIGH)

**File:** `src/skill/store.ts`  
**Line:** ~46-54  
**Problem:** `readSkillFile()` does `JSON.parse(content) as SkillFile` with zero validation. Tampered files on disk replay without detection.

**Fix:** Add optional verified loading:
```typescript
import { verifySignature } from './signing.js';

export async function readSkillFile(
  domain: string,
  skillsDir: string,
  options?: { verifySignature?: boolean; signingKey?: Buffer }
): Promise<SkillFile | null> {
  const path = skillPath(domain, skillsDir);
  try {
    const content = await readFile(path, 'utf-8');
    const skill = JSON.parse(content) as SkillFile;
    
    // If verification requested, check signature
    if (options?.verifySignature && options.signingKey) {
      if (skill.provenance === 'imported') {
        // Imported files had foreign signature stripped — can't verify, warn only
        // Future: re-sign on import with local key
      } else if (!verifySignature(skill, options.signingKey)) {
        throw new Error(`Skill file signature verification failed for ${domain} — file may be tampered`);
      }
    }
    
    return skill;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
```

**Note:** This is opt-in for now (backward compatible). The replay path should call with `verifySignature: true` when a signing key is available. Full enforcement can come in v1.2.

**Tests to add:** `test/skill/store-verify.test.ts`
- Tampered skill file (modified baseUrl) → verification fails
- Valid signed skill file → verification passes
- Unsigned/imported skill file → passes (no signature to verify)

---

### Fix 5: DNS Rebinding TOCTOU (F3 — CRITICAL in audit, MEDIUM in practice)

**File:** `src/skill/ssrf.ts`  
**Problem:** `resolveAndValidateUrl()` resolves DNS, validates IP, but `fetch()` resolves DNS again independently. Attacker DNS with TTL=0 can return public IP first (passes check) then private IP (hits internal service).

**Fix:** Pin resolved IP in the fetch URL:
```typescript
export async function resolveAndValidateUrl(urlString: string): Promise<ValidationResult & { resolvedUrl?: string }> {
  // ... existing sync checks ...
  
  const { address } = await dns.lookup(hostname);
  const privateReason = isPrivateIp(address);
  if (privateReason) {
    return { safe: false, reason: `DNS resolved to private IP: ${privateReason}` };
  }
  
  // Return the resolved URL with IP pinned — caller should fetch THIS URL with Host header
  const pinnedUrl = new URL(urlString);
  pinnedUrl.hostname = address;
  return { 
    safe: true, 
    resolvedUrl: pinnedUrl.toString(),
    resolvedIp: address,
    originalHost: hostname 
  };
}
```

Then in `src/replay/engine.ts`, use the pinned URL:
```typescript
const ssrfCheck = await resolveAndValidateUrl(url.toString());
if (!ssrfCheck.safe) {
  throw new Error(`SSRF blocked: ${ssrfCheck.reason}`);
}

// Use resolved IP to prevent DNS rebinding
const fetchUrl = ssrfCheck.resolvedUrl ?? url.toString();
if (ssrfCheck.resolvedUrl) {
  headers['host'] = url.hostname;  // Preserve original Host header
}

const response = await fetch(fetchUrl, { ... });
```

**Tests to add:** `test/security/dns-rebinding.test.ts`
- Verify `resolvedUrl` contains IP instead of hostname
- Verify `Host` header set to original hostname
- Mock DNS that returns different IPs → pinned IP used

---

### Fix 6: Fetch Timeout on OAuth Refresh (F5 extension)

**File:** `src/auth/oauth-refresh.ts`  
**Line:** ~66  
**Problem:** The `fetch()` in `refreshOAuth()` has no timeout. Main replay fetch has 30s timeout but OAuth refresh doesn't.

**Fix:**
```typescript
const response = await fetch(oauthConfig.tokenEndpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
  signal: AbortSignal.timeout(15_000),  // 15s timeout for token refresh
});
```

**Tests:** Existing OAuth tests should cover this. Add one timeout test.

---

## Test Strategy

Run tests by directory to avoid OOM:
```bash
# After all fixes, run each directory separately
for dir in auth capture discovery mcp read replay security serve skill types; do
  echo "--- Testing $dir ---"
  node --import tsx --test "test/$dir/*.test.ts" 2>&1 | tail -5
done
```

**Expected new test files:**
1. `test/capture/session-navigate-ssrf.test.ts` (~4 tests)
2. `test/security/header-injection.test.ts` (~6 tests)
3. `test/security/redirect-ssrf.test.ts` (~4 tests)  
4. `test/skill/store-verify.test.ts` (~3 tests)
5. `test/security/dns-rebinding.test.ts` (~3 tests)

**Target: 721 + ~20 new tests = ~741 tests, 0 failures**

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/capture/session.ts` | Add SSRF validation to `navigate` action |
| `src/replay/engine.ts` | Header allowlist, redirect validation, DNS pinning |
| `src/skill/ssrf.ts` | Return resolved URL for DNS pinning |
| `src/skill/store.ts` | Optional signature verification on load |
| `src/auth/oauth-refresh.ts` | Add fetch timeout |
| `test/capture/session-navigate-ssrf.test.ts` | NEW |
| `test/security/header-injection.test.ts` | NEW |
| `test/security/redirect-ssrf.test.ts` | NEW |
| `test/skill/store-verify.test.ts` | NEW |
| `test/security/dns-rebinding.test.ts` | NEW |

## After Implementation

1. Run full test suite (by directory, avoid OOM)
2. Rebuild `dist/` (`npx tsc`)
3. Update `docs/security-audit-v1.md` — mark F3, F4, F7, F8, F12 as FIXED
4. Commit with message: `security: harden v1.1 — fix F3/F4/F7/F8/F12 + redirect validation`
5. Push to GitHub

## Priority Order

Implement in this order (highest impact first):
1. **Fix 2** — Header injection (quick win, high impact)
2. **Fix 3** — Redirect SSRF (quick win, high impact)
3. **Fix 1** — Capture navigate SSRF (quick win)
4. **Fix 6** — OAuth fetch timeout (one-liner)
5. **Fix 5** — DNS rebinding (most complex, biggest architectural change)
6. **Fix 4** — Signature on load (opt-in, can be minimal)

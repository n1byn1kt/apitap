# ApiTap × NetSec — Red Team Edition

## What ApiTap Does Today

Open source MCP server that turns any website into a replayable API. No docs, no SDK, no browser.

```
You browse a site → ApiTap captures every API call
→ Parameterizes paths (/users/123 → /users/:id)
→ Scores & filters noise (analytics, trackers)
→ Stores as structured JSON "skill file"
→ Replay any endpoint with one command
```

**12 MCP tools. 8 decoders. 700+ tests. BSL 1.1 licensed.**

GitHub: https://github.com/n1byn1kt/apitap

## Why a Red Teamer Should Care

What you do with Burp Suite manually, ApiTap automates:

| Phase | Manual (Burp) | ApiTap |
|-------|--------------|--------|
| Recon | Browse target, proxy traffic | `apitap capture https://target.com` |
| Map endpoints | Sitemap, spider | Auto-parameterized skill file |
| Auth detection | Manual inspection | Detected during capture |
| Replay | Repeater tab | `apitap replay target.com get-users` |
| Batch test | Right-click → Intruder | `apitap_replay_batch` (all endpoints) |

**But here's the gap:** ApiTap captures and replays. It doesn't *analyze for vulns*. That's where you come in.

## The Vision: ApiTap Red

A security analysis layer on top of ApiTap's capture/replay engine:

### 🔍 Automated Recon
- Capture API surface in minutes, not hours
- Auto-detect: auth endpoints, admin paths, debug routes, GraphQL introspection
- Score endpoints by attack surface (public > auth-required > token-gated)

### 🎯 Vuln Pattern Detection
- **IDOR/BOLA** — Sequential IDs in paths (`/users/1`, `/users/2`)
- **Broken auth** — Endpoints that work without auth tokens
- **Mass assignment** — POST bodies with role/admin/privilege fields
- **Info leakage** — Verbose error responses, stack traces, internal IPs
- **Rate limiting** — Endpoints with no throttling

### ⚔️ Active Testing
- **Auth boundary testing** — Replay as User A with User B's resources
- **Parameter fuzzing** — Auto-generate mutations for each endpoint
- **Privilege escalation** — Diff responses across auth levels
- **Token analysis** — JWT decode, expiry checks, algorithm confusion

### 📋 Reporting
- OWASP Top 10 mapping per endpoint
- Structured findings with reproduction steps (skill file = proof)
- Client-ready markdown/PDF export

## What's Already Built (That Helps)

- ✅ SSRF protection (multi-layer — you'll appreciate the depth)
- ✅ PII scrubbing during capture
- ✅ Header injection protection (allowlist)
- ✅ DNS rebinding prevention (IP pinning)
- ✅ Skill file signing (tamper detection)
- ✅ Auth storage (AES-256-GCM, machine-keyed)
- ✅ Full security audit: 19 findings, 9/10 posture

## The Ask

1. **Review the current tool** — Break it. Find what we missed. Red team perspective > any automated scan.
2. **Co-design the netsec extension** — Your domain expertise shapes what gets built.
3. **Pilot it on real engagements** — Dog-food with actual pen test workflows.

## The Opportunity

Google's Threat Intelligence Group just published a report (Feb 12, 2026) documenting MCP servers being used as attack vectors by APT31 and underground toolkits. The security community needs MCP tools built with defense-in-depth, not bolted-on afterthoughts.

ApiTap is already hardened. Making it a red team weapon is the natural next step.

**The agent future is here. Pen testing hasn't caught up yet.**

---

*ApiTap: https://github.com/n1byn1kt/apitap*
*License: BSL 1.1 (open for individual use, converts to Apache 2.0 after 4 years)*

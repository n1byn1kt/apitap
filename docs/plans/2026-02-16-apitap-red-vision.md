# ApiTap Red — Vision Document
*2026-02-16 | Exploration & co-design with Dan*

---

## The Question

Should ApiTap Red be a separate product/repo, or a layer on top of ApiTap core?
How does pentesting recon actually work, and where does ApiTap slot in?

---

## How Pentesting Recon Actually Works

Professional penetration testing follows structured methodologies (PTES, NIST SP 800-115, OWASP WSTG). The standard phases:

### Phase 1: Pre-Engagement
- Scope definition, rules of engagement (RoE), written authorization
- What's in bounds, what's off-limits, communication protocols
- **ApiTap relevance:** None (this is contracts & planning)

### Phase 2: Reconnaissance (RECON)
This is where ApiTap shines. Two sub-phases:

**Passive Recon (OSINT) — Don't touch the target:**
- DNS enumeration (subdomains, MX records, TXT records)
- WHOIS, reverse DNS, certificate transparency logs
- Google dorks, Shodan, Censys
- Tech stack fingerprinting (Wappalyzer, BuiltWith)
- Employee OSINT (LinkedIn, GitHub, leaked creds via HIBP)
- JavaScript file analysis (API keys, endpoints, internal paths)
- Tools: subfinder, theHarvester, amass, Shodan CLI

**Active Recon — Touch the target:**
- Port scanning (nmap)
- Service/version detection
- Web crawling / spidering
- **API endpoint discovery ← THIS IS APITAP'S SWEET SPOT**
- Directory/file brute-forcing (ffuf, dirsearch, feroxbuster)
- Parameter discovery
- WAF detection
- Tools: nmap, ffuf, Burp Suite, nikto

### Phase 3: Vulnerability Analysis
- Automated scanning (Nessus, Nuclei, Burp Scanner)
- Manual validation (eliminate false positives)
- Custom checks against OWASP API Top 10
- **ApiTap opportunity:** Pattern detection in captured traffic

### Phase 4: Exploitation
- Prove the vuln is real — get a shell, extract data, bypass auth
- Tools: Metasploit, custom scripts, Burp Repeater/Intruder
- **ApiTap opportunity:** Replay endpoints with modified params/tokens

### Phase 5: Post-Exploitation
- Privilege escalation, lateral movement, data exfiltration
- **ApiTap relevance:** Limited (this is network/OS level)

### Phase 6: Reporting
- Executive summary + technical details + reproduction steps
- OWASP/MITRE ATT&CK mapping
- **ApiTap opportunity:** Skill files = machine-readable proof of exploit

---

## Where ApiTap Fits in the Kill Chain

```
                    WHAT EXISTS TODAY              WHAT WE'D BUILD
                    ────────────────              ───────────────

Phase 2 (Recon)     ✅ apitap_capture             🔴 Endpoint scoring
                    ✅ apitap_browse              🔴 Auth detection report
                    ✅ apitap_discover            🔴 Tech stack fingerprint
                    ✅ apitap_peek                🔴 Hidden endpoint fuzzing
                    ✅ apitap_search              🔴 GraphQL introspection detect

Phase 3 (Vuln)      ✅ Skill files capture         🔴 IDOR pattern detection
                       response structure          🔴 Auth bypass testing
                    ✅ apitap_replay              🔴 Mass assignment detect
                                                  🔴 Rate limit testing
                                                  🔴 OWASP API Top 10 checks

Phase 4 (Exploit)   ✅ apitap_replay              🔴 Parameter fuzzing
                    ✅ apitap_replay_batch        🔴 Auth boundary testing
                    ✅ Auth storage (AES-256)     🔴 Token manipulation
                                                  🔴 Privilege escalation diff

Phase 6 (Report)    ✅ Structured JSON output      🔴 OWASP mapping
                    ✅ Skill file = proof          🔴 Markdown/PDF report gen
                                                  🔴 Remediation suggestions
```

**Key insight:** ApiTap already owns Phase 2 (recon) better than any existing tool for API discovery. The gap is Phase 3-4 analysis — turning captured data into security findings.

---

## The Competitive Landscape (Feb 2026)

### What exists today:

| Tool | What it does | Gap |
|------|-------------|-----|
| **Burp Suite** ($449/yr) | Proxy + scanner + repeater | Manual, expensive, not MCP-native |
| **Caido** | Modern Burp alternative | Still manual, no AI/agent integration |
| **Nuclei** (free) | Template-based vuln scanning | No API discovery — needs known endpoints |
| **pentestMCP** | MCP bridge to CLI tools | Tool server only, no intelligence |
| **HexStrike-AI** | Large MCP bridge for offensive tools | Kitchen sink approach, high risk |
| **PentestGPT** | AI-assisted pentest pipeline | Docker-heavy, general purpose |
| **Strix** | Multi-agent pentest platform | Enterprise/CI focus, not API-first |

### ApiTap Red's unique angle:
1. **Discovery-first:** We find the APIs. Everyone else assumes you already know them.
2. **MCP-native:** Built for AI agents from day one, not bolted on.
3. **Skill files as artifacts:** Captured traffic = replayable proof = reporting evidence.
4. **Already hardened:** 9/10 security posture. We've done to ourselves what we'd help others do.
5. **Privacy-first:** Fully local. No cloud proxy. Your target data stays on your machine.

**Nobody does: discover API surface → analyze for vulns → test → report in one tool.**
Pentesters currently chain 5-6 tools. ApiTap Red could collapse that.

---

## Product Architecture: Three Options

### Option A: Plugin Layer (Recommended to start)
```
@apitap/core          ← Existing. npm package. 12 tools.
@apitap/red           ← New package. Imports core. Adds security analysis.
                         Same repo, separate entry point.
```

**Pros:** Single repo, shared codebase, ships as `apitap red` CLI or `apitap mcp --red`
**Cons:** Couples release cycles

### Option B: Separate Repo
```
n1byn1kt/apitap       ← Core tool (BSL 1.1)
n1byn1kt/apitap-red   ← Security extension (different license?)
```

**Pros:** Independent release, could have different license (more restrictive?)
**Cons:** Dependency management, split community

### Option C: Skill File (Lightest)
```
~/.apitap/skills/     ← Existing skill directory
security-audit.skill  ← New: security analysis patterns
```

ApiTap Red = a collection of security-focused skill files + a few new MCP tools. No new package at all — just specialized usage of existing tools.

**Pros:** Zero new infrastructure, Dan could contribute skill files directly
**Cons:** Limited — can't do analysis that requires new code

### Decision: Option B — Separate Private Repo

**ApiTap Red will NOT be public.** Offensive security tools in the wrong hands = liability, especially with APT31 already weaponizing MCP tooling (GTIG Feb 2026).

```
n1byn1kt/apitap       ← Public (BSL 1.1). The Leatherman.
n1byn1kt/apitap-red   ← Private. Invite-only (Jaromir + Dan). The scalpel.
```

Red imports `@apitap/core` from npm as a dependency. No security analysis code touches the public repo. Ever.

---

## Phase 1: Start with RECON (Dan's suggestion)

**Why recon first:** It's the safest, most immediately useful, and doesn't require authorization beyond the tester's own scope. It's also where ApiTap already excels.

### What "ApiTap Recon" looks like:

```bash
# Step 1: Capture full API surface
apitap capture https://target.com --duration 120

# Step 2: Recon report (NEW)
apitap red recon target.com
```

**Recon report would output:**

```
═══════════════════════════════════════════
  ApiTap Recon Report: target.com
  Captured: 47 endpoints | 12 unique paths
  Duration: 2m 3s | Traffic: 284 requests
═══════════════════════════════════════════

📊 ENDPOINT CLASSIFICATION
├─ Auth endpoints:     3  (login, register, token-refresh)
├─ Data endpoints:    28  (CRUD operations)
├─ Admin endpoints:    2  ⚠️  (/admin/users, /admin/config)
├─ Debug endpoints:    1  🔴 (/debug/healthcheck)
├─ File upload:        1  ⚠️  (/api/upload)
├─ GraphQL:            0
└─ WebSocket:          1

🔑 AUTH ANALYSIS
├─ Auth type: Bearer JWT
├─ Token in: Authorization header
├─ Refresh endpoint: POST /api/auth/refresh
├─ Token expiry: 3600s
├─ ⚠️  2 endpoints respond 200 WITHOUT auth token
│   ├─ GET /api/public/config
│   └─ GET /api/users/:id  ← POSSIBLE IDOR

🔍 PARAMETER PATTERNS
├─ Sequential IDs: /api/users/:id, /api/orders/:id  ⚠️ IDOR candidate
├─ UUID patterns: /api/sessions/:uuid  ✅
├─ Sensitive params: ?email=, ?ssn=  🔴 PII in query string
└─ Batch endpoints: /api/users?limit=&offset=  (enumeration risk)

🏗️ TECH STACK (inferred)
├─ Server: nginx/1.24
├─ Framework: Express (X-Powered-By header)
├─ API style: REST (JSON)
├─ CORS: *, allows credentials  🔴
└─ Rate limiting: None detected  ⚠️

📋 OWASP API TOP 10 SURFACE
├─ API1 (BOLA/IDOR):       3 endpoints at risk  🔴
├─ API2 (Broken Auth):     2 endpoints no auth   ⚠️
├─ API3 (Property Auth):   Unknown (need testing)
├─ API4 (Resource Limit):  No rate limiting       ⚠️
├─ API5 (Function Auth):   Admin paths exposed    🔴
├─ API9 (Inventory Mgmt):  Debug endpoint live    🔴
└─ API10 (Unsafe Consume):  Unknown
```

### What this requires technically:

**New MCP tools (3-4):**
| Tool | What it does |
|------|-------------|
| `apitap_recon` | Generate recon report from skill files |
| `apitap_classify` | Classify endpoints (auth, admin, debug, CRUD) |
| `apitap_auth_probe` | Test which endpoints work without auth |
| `apitap_diff` | Compare responses across auth levels |

**Analysis logic (reads existing skill files):**
- Parse captured endpoints for ID patterns (sequential vs UUID)
- Detect auth headers/cookies in captured requests
- Flag endpoints that returned data without auth
- Identify sensitive parameter names
- Infer tech stack from headers
- Map to OWASP API Top 10 categories

**Key point:** All of this runs on *already captured data*. No new requests to the target needed for the basic recon report. The auth_probe and diff tools would make new requests (with permission).

---

## Dan's Role

### What Dan can do right now (with ApiTap core):

1. **Install:** `npm install -g @apitap/core`
2. **Capture a test target:** 
   - Use OWASP Juice Shop, DVWA, or any authorized target
   - `apitap capture https://juice-shop.example.com`
3. **Review skill files:** Look at what's captured, what's missing
4. **Try replay:** `apitap replay juice-shop.example.com <endpoint>`
5. **Break it:** Try to make ApiTap do things it shouldn't
6. **Feedback:** What would you need in a recon report?

### What Dan brings:
- Real pen test workflows — what actually matters vs what sounds cool
- Edge cases from real engagements
- Validation of whether our recon output is actionable
- "Would you actually use this?" filter

### Co-design sessions:
1. **Session 1:** Dan reviews core tool, reports what works/breaks
2. **Session 2:** Design recon report format together (what fields matter?)
3. **Session 3:** Prototype `apitap red recon` based on Dan's feedback
4. **Session 4:** Test on OWASP targets, iterate

---

## OWASP API Security Top 10 (2023) — What We Can Detect

| # | Risk | Can ApiTap Detect? | How |
|---|------|--------------------|-----|
| API1 | Broken Object Level Auth (BOLA) | 🟡 Partial | Sequential ID patterns in paths |
| API2 | Broken Authentication | 🟡 Partial | Endpoints responding without tokens |
| API3 | Broken Object Property Auth | 🔴 Needs testing | Requires response diffing across users |
| API4 | Unrestricted Resource Consumption | 🟢 Yes | Detect missing rate limit headers |
| API5 | Broken Function Level Auth | 🟡 Partial | Admin/debug endpoints in captured traffic |
| API6 | Unrestricted Sensitive Business Flows | 🔴 Needs context | Business logic specific |
| API7 | SSRF | 🟢 Yes (ironic) | We literally hardened against this |
| API8 | Security Misconfiguration | 🟢 Yes | CORS, headers, debug endpoints |
| API9 | Improper Inventory Management | 🟢 Yes | Version headers, deprecated paths |
| API10 | Unsafe Consumption of APIs | 🔴 Needs testing | Third-party API calls in traffic |

**5 of 10 detectable from captured traffic alone. 3 more with active testing. 2 need business context.**

---

## Nuclei Integration Angle

Nuclei (ProjectDiscovery) uses YAML templates for vuln detection. There's a natural bridge:

```
ApiTap captures endpoints → generates Nuclei templates → Nuclei runs the tests
```

This means we don't have to build our own scanner from scratch. ApiTap discovers the attack surface, Nuclei tests it. Best of both tools.

Example flow:
```bash
# 1. ApiTap captures API surface
apitap capture https://target.com

# 2. ApiTap generates Nuclei templates (NEW)
apitap red nuclei-gen target.com --output templates/

# 3. Nuclei runs the generated templates
nuclei -t templates/ -u https://target.com
```

---

## License Considerations

- **Core ApiTap:** BSL 1.1 (public)
- **ApiTap Red:** Private repo, no public license needed. Access = invite only.
- If it ever goes public (unlikely), consider AGPL or proprietary to prevent weaponization.

---

## Timeline (Rough)

| Week | Milestone |
|------|-----------|
| 1 | Dan reviews core tool, provides feedback |
| 2 | Design recon report format, prototype `apitap_recon` |
| 3 | Build endpoint classifier + auth prober |
| 4 | OWASP API Top 10 mapping, test on Juice Shop |
| 5-6 | Nuclei template generation |
| 7-8 | Reporting layer, polish |

**v0.1 = just recon.** Get that right, then layer on active testing.

---

## Open Questions for Dan

1. What does your current recon workflow look like? (Tools, order, time spent)
2. What format do you want recon output in? (Markdown, JSON, HTML?)
3. What test targets can we use? (Juice Shop, DVWA, HackTheBox, real authorized targets?)
4. How do you handle auth during pen tests? (Provided creds? Self-registered? Both?)
5. What's the most time-consuming manual step in API recon?
6. Would you want this integrated into your existing toolchain (Burp, Nuclei) or standalone?
7. What do clients actually care about in reports?

---

## Summary

**Start with recon. It's safe, useful, and plays to ApiTap's strengths.**

ApiTap already does the hardest part — discovering and parameterizing API surfaces automatically. The gap is turning that raw data into security intelligence. That's what ApiTap Red adds.

Private repo (`n1byn1kt/apitap-red`), imports `@apitap/core` as dependency. Dan tests core now, co-designs the analysis layer, we build it together. Never published publicly.

**The pitch in one line:** *"ApiTap finds the APIs. ApiTap Red finds the vulns."*

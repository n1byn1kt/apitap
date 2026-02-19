# ApiTap Momentum Plan — Post-Launch Sprint

*Created 2026-02-15, after Sam Altman announced OpenClaw → OpenAI foundation move*

## Context

Sam Altman just announced Peter Steinberger (OpenClaw creator) joining OpenAI. OpenClaw moves to a foundation with continued OpenAI support. "The future is going to be extremely multi-agent."

**This validates everything we've built.** More agents = more need for structured web data = more need for ApiTap. We need to capitalize on this momentum NOW.

## The Opportunity

Every agent in the "extremely multi-agent" future needs to:
1. Get structured data from websites that don't have APIs
2. Share knowledge about how websites work
3. Do it fast, privately, without browser overhead

ApiTap does all three. We're ahead of the curve.

## Immediate Actions (This Week)

### 1. npm publish (Monday)
- `npm adduser` on the box → `npm publish`
- Makes `npm install -g apitap` work for anyone, anywhere
- Discoverable on npmjs.com for "MCP website API" searches

### 2. Launch announcement (Monday/Tuesday)
- Post on X: "I built an MCP server that turns any website into an API — no docs, no SDK, no browser."
- Post on Hacker News: Show HN
- Link to GitHub + DeepWiki auto-generated docs
- Emphasize: 8 decoders, 12 MCP tools, 74% token savings, BSL 1.1

### 3. Point apitap.io somewhere
- Option A: Redirect to GitHub README (quickest)
- Option B: Simple landing page (better for SEO)
- Option C: GitHub Pages from the repo

## Short-Term Growth (Next 2 Weeks)

### 4. Skill file sharing / community registry
- Skill files are portable JSON — no credentials, safe to share
- A community registry where agents share captured skill files = network effect
- Every new skill file makes ApiTap more valuable for everyone
- Could be as simple as a GitHub repo of contributed skills

### 5. More decoders = more value
Current: 8 decoders (Reddit, YouTube, Wikipedia, HN, Grokipedia, Twitter/X, Generic, DeepWiki)

Priority additions:
- **LinkedIn** (public profiles via Voyager API — needs reverse engineering)
- **Facebook** (bot UA trick — pattern identified, not yet coded)
- **Instagram** (mobile API — pattern in SKILL.md, not yet in decoder)
- **GitHub** (REST API — straightforward, high value for agent ecosystem)
- **Stack Overflow** (API exists, high value for coding agents)

Each new decoder = one more platform that agents can read without a browser.

### 6. Speed optimization
- Current cold start: 885ms → Target: <300ms
- For multi-agent orchestration, latency kills
- Profile startup, lazy-load decoders, optimize imports

## Medium-Term (Next Month)

### 7. ApiTap as MCP standard
- Publish SKILL.md format specification
- Make it easy for other tools to produce/consume skill files
- Position as the "package.json for web APIs"

### 8. Agent self-teaching demo
- Agent discovers a new site, captures skill file, replays endpoints — all autonomously
- "Agent That Teaches Itself" — compelling demo for the multi-agent narrative
- Shows the capture → learn → replay loop

### 9. Pulse v2
- Multi-source intelligence: Polymarket + HN + web search + ApiTap decoders
- "What people say" AND "what people bet" for any topic
- Shell script first (Option A), then MCP tool

### 10. Enterprise features (v1.2+)
- Skill file signing with org keys (team sharing)
- Audit logging for compliance
- Rate limiting per domain
- Proxy support for corporate networks

## Moat Analysis

**What's defensible:**
- 83 skill files across 249 endpoints (institutional knowledge)
- 8 site-specific decoders (reverse engineering effort)
- BSL 1.1 prevents competing hosted services
- First-mover in "MCP server for web APIs" space

**What compounds:**
- Every user who captures a site adds to the skill library
- Every decoder we build makes more of the web accessible
- Network effects from skill sharing

**What Sam's announcement means for us:**
- Agent ecosystem is about to explode (OpenAI + OpenClaw + foundation)
- More agents = exponentially more API calls to websites
- ApiTap sits at the critical junction: agents ↔ websites

## Success Metrics (30 days)

- [ ] npm weekly downloads > 100
- [ ] GitHub stars > 50
- [ ] 3+ community-contributed skill files
- [ ] 10+ decoders
- [ ] HN front page or 50+ upvotes
- [ ] At least 1 external blog post / mention

---

*"The future is going to be extremely multi-agent" — Sam Altman, Feb 15 2026*
*ApiTap makes that future possible by giving every agent access to every website.*

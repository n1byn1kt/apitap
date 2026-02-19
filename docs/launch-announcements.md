# ApiTap Launch Announcements

*Drafted 2026-02-16. Ready to post when timing is right.*

---

## X (Twitter) — Thread

**Tweet 1 (hook):**
I built an MCP server that turns any website into an API.

No docs. No SDK. No browser.

It captures the API calls happening behind any site, learns the patterns, and makes them replayable. Then goes further — extracting structured data from URLs without touching a browser at all.

Open source: apitap.io

**Tweet 2 (how it works):**
How it works:

1. Visit any site → ApiTap captures the real API calls behind the UI
2. It saves "skill files" — replayable endpoint patterns
3. Next time? Skip the browser entirely. Replay the API directly.

83 sites tested. 249 endpoints captured. 74% average token savings vs raw HTML.

**Tweet 3 (three layers):**
Three ways to use it:

🔌 MCP Server — plug into Claude/Cursor, 12 tools ready
🖥️ CLI — pipeable, composable: `apitap read url | jq '.title'`
📄 SKILL.md — teach any AI agent all 12 tools in one file

One tool, three interfaces. Use what fits.

**Tweet 4 (decoders):**
8 built-in decoders extract data without a browser:

Reddit → 500 tokens (vs 97K raw HTML)
YouTube → 36 tokens
Wikipedia → 116 tokens
Hacker News, Twitter/X, DeepWiki, Grokipedia + Generic fallback

The future isn't scraping. It's side-channel extraction.

**Tweet 5 (security):**
Security score: 9/10

SSRF protection, DNS rebinding prevention, header injection allowlist, redirect validation, OAuth timeouts, signature verification on skill files.

704 tests. 20 dedicated security tests. Built after reading the Google GTIG report on AI-powered attacks targeting MCP servers.

**Tweet 6 (philosophy):**
Every app is a slow API.

Behind every website is a fast, structured API that the frontend calls. ApiTap finds those calls and makes them available to your AI agent.

Three dependencies. Fully local. Privacy-first. BSL 1.1 (converts to Apache 2.0 after 4 years).

npm install -g @apitap/core

---

## Hacker News — Show HN

**Title:**
Show HN: ApiTap – MCP server that turns any website into an API (no browser needed)

**Body:**
Hi HN,

I built ApiTap to solve a problem I kept hitting: AI agents need structured data from websites, but most sites don't have public APIs. The options are scraping (fragile, expensive) or headless browsers (slow, token-heavy).

ApiTap takes a different approach. It sits between your browser and a website, captures the actual API calls the frontend makes, and saves them as replayable "skill files." Next time you need that data, skip the browser entirely — replay the API directly.

It goes further with 8 built-in decoders that extract structured data from URLs without any browser at all (Reddit posts in 500 tokens vs 97K of raw HTML).

**Three ways to use it:**
- MCP server (12 tools, plug into Claude/Cursor/any MCP client)
- CLI (pipeable — `apitap read <url> | jq '.title'`)
- SKILL.md (single file that teaches any agent all 12 tools)

Technical details:
- Three dependencies: playwright, @modelcontextprotocol/sdk, zod
- 704 tests, security hardened (9/10) — SSRF protection, DNS rebinding prevention, header allowlists
- Fully local, no cloud proxy, privacy-first
- BSL 1.1 license (free for all use except competing hosted services, converts to Apache 2.0 after 4 years)

Tested against 83 sites with 249 endpoints captured. Average 74% token savings vs raw HTML.

GitHub: https://github.com/n1byn1kt/apitap
npm: https://www.npmjs.com/package/@apitap/core

Happy to answer questions about the architecture, decoder approach, or security model.

---

## Reddit (r/MCP, r/ClaudeAI, r/LocalLLaMA)

**Title:** I built an MCP server that turns any website into an API — no browser needed

**Body:**
[Same as HN but slightly more casual, drop the "Hi HN" opener, add a "How I use it" section with concrete examples like price monitoring, Reddit scanning, etc.]

---

## Notes

- **Timing:** Weekday morning PST (Tue-Thu) tends to work best for HN
- **X:** Can post anytime, but morning US hours get more engagement
- **Don't post all at once** — X first, HN a day later, Reddit after that
- **Follow up:** Monitor comments, answer questions quickly (first 2 hours on HN are critical)
- **Video/demo:** asciinema recording exists but may need updating for v1.0.0

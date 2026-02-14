# ApiTap — The MCP Server That Turns Any Website Into an API

> No docs, no SDK, no browser. Just data.

## What It Does

ApiTap gives AI agents cheap access to web data through three layers:

1. **Read** — Decode any URL into structured text without a browser (side-channel APIs, og: tags, HTML extraction). 0-10K tokens vs 50-200K for browser automation.
2. **Replay** — Call captured API endpoints directly. 1-5K tokens per call.
3. **Capture** — Record API traffic from a headless browser session, generating reusable skill files.

## MCP Tools (12)

### Tier 0: Triage (free)

#### `apitap_peek`
Zero-cost URL triage. HTTP HEAD only — checks accessibility, bot protection, framework detection.
```
apitap_peek(url: string) → PeekResult
```
**Use when:** You want to know if a site is accessible before spending tokens. Check bot protection, detect frameworks.

**Returns:** `{ status, accessible, server, framework, botProtection, signals[], recommendation }`

`recommendation` is one of: `read` | `capture` | `auth_required` | `blocked`

**Example:**
```
apitap_peek("https://www.zillow.com") → { status: 200, recommendation: "read" }
apitap_peek("https://www.doordash.com") → { status: 403, botProtection: "cloudflare", recommendation: "blocked" }
```

### Tier 1: Read (0-10K tokens, no browser)

#### `apitap_read`
Extract content from any URL without a browser. Uses side-channel APIs for known sites and HTML extraction for everything else.
```
apitap_read(url: string, maxBytes?: number) → ReadResult
```
**Use when:** You need page content, article text, post data, or listing info. Always try this before capture.

**Returns:** `{ title, author, description, content (markdown), links[], images[], metadata: { source, type, publishedAt }, cost: { tokens } }`

**Site-specific decoders (free, structured):**
| Site | Side Channel | What You Get |
|------|-------------|-------------|
| Reddit | `.json` suffix | Posts, scores, comments, authors — full structured data |
| YouTube | oembed API | Title, author, channel, thumbnail |
| Wikipedia | REST API | Article summary, structured, with edit dates |
| Hacker News | Firebase API | Stories, scores, comments, real-time |
| Grokipedia | xAI public API | Full articles with citations, search, 6M+ articles |
| Twitter/X | fxtwitter API | Full tweets, articles, engagement, quotes, media |
| Everything else | og: tags + HTML extraction | Title, content as markdown, links, images |

**Examples:**
```
# Reddit — full subreddit listing, ~500 tokens
apitap_read("https://www.reddit.com/r/technology")

# Reddit post with comments
apitap_read("https://www.reddit.com/r/wallstreetbets/comments/abc123/some-post")

# YouTube — 36 tokens
apitap_read("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

# Wikipedia — 116 tokens
apitap_read("https://en.wikipedia.org/wiki/Artificial_intelligence")

# Grokipedia — full article with citations, 6M+ articles
apitap_read("https://grokipedia.com/wiki/SpaceX")

# Grokipedia — search across 6M articles
apitap_read("https://grokipedia.com/search?q=artificial+intelligence")

# Grokipedia — site stats and recent activity
apitap_read("https://grokipedia.com/")

# Twitter/X — full tweet with engagement, articles, quotes
apitap_read("https://x.com/elonmusk/status/123456789")

# Twitter/X article (long-form post) — full text extracted
apitap_read("https://twitter.com/writer/status/987654321")

# Any article/blog/news — generic extraction
apitap_read("https://example.com/blog/some-article")

# Zillow listing (bypasses PerimeterX via og: tags)
apitap_read("https://www.zillow.com/homedetails/123-Main-St/12345_zpid/")
```

### Tier 2: Replay (1-5K tokens, needs skill file)

#### `apitap_search`
Find available skill files by domain or keyword.
```
apitap_search(query: string) → { found, results[] }
```
**Use when:** Looking for captured API endpoints. Search by domain name or topic.

#### `apitap_replay`
Call a captured API endpoint directly — no browser needed.
```
apitap_replay(domain: string, endpointId: string, endpointParams?: object, maxBytes?: number) → ReplayResult
```
**Use when:** A skill file exists for this domain. This is the cheapest way to get structured API data.

**Returns:** `{ status, data (JSON), domain, endpointId, tier, fromCache }`

**Example:**
```
# Get live stock quote (Robinhood, no auth needed)
apitap_replay("api.robinhood.com", "get-marketdata-quotes", { symbols: "TSLA,MSFT" })

# Get NBA scores (ESPN)
apitap_replay("site.api.espn.com", "get-apis-personalized-v2-scoreboard-header")

# Get crypto trending (CoinMarketCap)
apitap_replay("api.coinmarketcap.com", "get-data-api-v3-unified-trending-top-boost-listing")
```

#### `apitap_replay_batch`
Replay multiple endpoints in one call.
```
apitap_replay_batch(requests: Array<{ domain, endpointId, endpointParams? }>, maxBytes?: number)
```

### Tier 3: Capture (15-20K tokens, uses browser)

#### `apitap_capture`
Launch a headless browser to capture API traffic from a website.
```
apitap_capture(url: string, duration?: number) → { sessionId }
```
**Use when:** No skill file exists and `apitap_read` doesn't give you the data you need. This is expensive but creates a skill file for future free replays.

#### `apitap_capture_interact`
Send browser commands during an active capture session.
```
apitap_capture_interact(sessionId: string, action: string, ...) → result
```
Actions: `click`, `type`, `navigate`, `snapshot`, `scroll`, `wait`

#### `apitap_capture_finish`
End capture session, generate skill file, verify endpoints.
```
apitap_capture_finish(sessionId: string) → { skillFile, endpoints[] }
```

### Auto-Router

#### `apitap_browse`
Automatic escalation: cache → skill file → discover → **read** → capture_needed.
```
apitap_browse(url: string, query?: string, maxBytes?: number) → result
```
**Use when:** You don't know which tier to use. This tries the cheapest option first and escalates automatically.

### Inspection

#### `apitap_inspect`
Get details about a skill file's endpoints.
```
apitap_inspect(domain: string) → { endpoints[], metadata }
```

#### `apitap_stats`
Usage statistics across all skill files.
```
apitap_stats() → { domains, endpoints, tiers }
```

## Decision Tree

```
Need web data?
│
├─ Know the domain? → apitap_search → found? → apitap_replay (cheapest)
│
├─ Unknown URL → apitap_peek first (free)
│   ├─ recommendation: "blocked" → STOP, tell user
│   ├─ recommendation: "read" → apitap_read (no browser)
│   ├─ recommendation: "capture" → apitap_capture (browser)
│   └─ recommendation: "auth_required" → needs human login
│
├─ Just need article/post content → apitap_read directly
│
└─ Need structured API data → apitap_capture → creates skill file → future replays free
```

## Key Patterns

### Instagram profile data (login wall bypass)
Instagram blocks all normal scraping (Googlebot UA, oembed, noembed). But the **mobile API** works:
```bash
curl -s 'https://i.instagram.com/api/v1/users/web_profile_info/?params={"user_name":"TARGET_USERNAME"}' \
  -H 'User-Agent: Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)' \
  -H 'X-IG-App-ID: 936619743392459'
```
**Returns:** Full profile JSON — bio, follower/following counts, post count, contact info (email, phone), category, highlights, recent posts with captions/engagement.

**When to use:** Need Instagram profile data, follower counts, contact info, or recent post summaries. Works without auth.

**Limitations:** Only public profiles. Rate-limited if abused. Does NOT return full post feeds — just recent edge.

### Morning news scan
```
# Scan multiple subreddits
for sub in ["technology", "wallstreetbets", "privacy"]:
    apitap_read(f"https://www.reddit.com/r/{sub}")
```

### Stock research
```
# Live quote via captured API
apitap_replay("api.robinhood.com", "get-marketdata-quotes", { symbols: "TSLA" })

# Company fundamentals
apitap_replay("api.robinhood.com", "get-fundamentals", { symbol: "TSLA" })
```

### Research any topic (dual knowledge base)
```
# 1. Read Wikipedia summary (established knowledge)
apitap_read("https://en.wikipedia.org/wiki/Topic")

# 2. Read Grokipedia article (AI-curated, with citations)
apitap_read("https://grokipedia.com/wiki/Topic")

# 3. Check Reddit discussion (community sentiment)
apitap_read("https://www.reddit.com/r/relevant_sub")

# 4. Read a linked article
apitap_read("https://news-site.com/article")
```

### Check before committing
```
# Peek first — is it worth reading?
result = apitap_peek("https://some-site.com")
if result.recommendation == "read":
    apitap_read("https://some-site.com")
elif result.recommendation == "blocked":
    # Don't waste tokens
    pass
```

## Token Economics

| Method | Cost per page | Notes |
|--------|-------------|-------|
| Browser automation | 50-200K tokens | Full DOM serialization |
| apitap_read | 0-10K tokens | No browser, side channels |
| apitap_replay | 1-5K tokens | Direct API call, needs skill file |
| apitap_peek | ~0 tokens | HEAD request only |

## CLI Usage

All MCP tools are also available as CLI commands:
```bash
apitap peek <url> [--json]
apitap read <url> [--json] [--max-bytes <n>]
apitap search <query> [--json]
apitap replay <domain> <endpointId> [--params '{}'] [--json]
apitap capture <url> [--duration <sec>] [--json]
apitap inspect <domain> [--json]
apitap stats [--json]
```

Every command supports `--json` for machine-readable output.

# Unbrowse — Brainstorming Brief

## What We're Building
An open-source tool that intercepts internal API calls from websites (SPAs, React apps, dashboards) and turns them into reusable API templates that AI agents can call directly — bypassing browser automation entirely.

## The Problem
AI agents using browser automation burn 50-200K tokens per web interaction (DOM snapshots, element finding, clicking, re-rendering). Meanwhile, every SPA already fetches clean JSON from internal APIs. The browser is just a rendering layer. We're doing: JSON → HTML → scrape HTML → data. That's insane.

## The Goal
First visit: browse normally, tool records API calls (one-time cost).
Every visit after: agent calls the API directly. No browser. 200ms. 1-5K tokens instead of 50-200K.

## Inspiration
lekt9/unbrowse-openclaw — clever concept but:
- Closed-source native binaries (28MB, can't audit)
- Requires Solana wallet + private key
- Phones home to marketplace API
- UNLICENSED despite claiming MIT
- We want: fully open, privacy-first, local-only, auditable

## Technical Constraints
- Pure JS/TypeScript — no native binaries, no compiled blobs
- Privacy-first — no external services, no phone-home, everything local
- Works with OpenClaw's existing browser control (CDP on port 18792/18800)
- Should work as both: OpenClaw plugin AND standalone CLI tool
- Must handle auth (Bearer tokens, cookies, API keys)
- Linux-first (Fedora), but portable

## What We Know
- OpenClaw already has headless Chromium with CDP
- CDP Network domain gives us: Network.requestWillBeSent, Network.responseReceived, Network.getResponseBody
- We can intercept all XHR/fetch traffic through CDP
- Generated "skills" should be simple JSON maps of endpoints + params + auth patterns

## Key Questions to Brainstorm
1. **Architecture**: What are the core components? How do they fit together?
2. **Capture**: How to intelligently filter noise (analytics, tracking, ads) from real API calls?
3. **Auth**: How to detect, capture, and replay different auth patterns (Bearer, cookies, CSRF)?
4. **Skill Format**: What does a generated "API map" look like? Schema design.
5. **Replay**: How does the agent actually call these APIs? Direct fetch? Proxy?
6. **Token Refresh**: Auth tokens expire. How to handle refresh flows?
7. **MVP Scope**: What's the absolute minimum for a useful v0.1?
8. **Integration**: OpenClaw plugin vs standalone vs both?
9. **Anti-detection**: Sites with anti-bot on their APIs — how to handle?
10. **Name**: "Unbrowse" is taken. What do we call ours?

## Success Criteria
- Agent can browse Polymarket once → capture API → call it directly next time
- Token usage drops from ~100K to ~2K for the same task
- No external dependencies, no cloud services, pure local
- Clean enough to open-source on day one

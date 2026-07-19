# Changelog

## [Unreleased]

### Changed
- `maxBytes` now bounds replay responses at any nesting depth (wrapper objects,
  GraphQL shapes). Previously nested payloads passed through untruncated. The
  bound is approximate, not exact: honest metadata and order-of-magnitude
  correctness are the goal, and rare shapes (e.g. very wide flat objects of
  small scalars) can still exceed it.
- **BREAKING** for consumers that compare strictly: `truncated` in replay/browse
  results is now a structured report
  `{originalBytes, finalBytes, droppedItems, keptItems, note?}` instead of
  `true`. It is still truthy exactly when truncation occurred, so
  `if (result.truncated)` keeps working — but `result.truncated === true`
  checks and JSON schemas typing the field as `boolean` must be updated.
- Truncation never returns an empty array for non-empty input — worst case a
  single shape-sample item with capped strings is kept.
- `read` envelope: links are deduped by href and capped at 100 (`linksOmitted`
  reports the cut); images are omitted by default (`--images` / `includeImages`
  restores them, deduped and capped at 50); `cost.tokens` now measures the
  whole envelope; `maxBytes` shrinks links first and slices content, but the
  bound is approximate — a large content body plus fixed metadata can exceed
  it. `--no-scan` / `scan: false` preserves the legacy envelope exactly.

## v1.12.1

### Fixed

- **Capture no longer overwrites existing skill files** (#55): `apitap capture` / `apitap_capture` / `apitap_capture_finish` previously rewrote a domain's skill file with only the current session's endpoints, silently dropping endpoints captured earlier. `finish()` now merges the fresh capture with the existing on-disk skill (union by `METHOD + normalized path`; fresh capture wins on re-seen endpoints, prior endpoints carried over), so re-capturing a domain accretes coverage instead of replacing it.

## v1.12.0

Security & privacy audit fixes across the CLI, MCP server, native host, and browser extension (#54).

### Security

- **Skill-file integrity**: `provenance` is now covered by the HMAC signature, and the `imported` provenance value no longer bypasses signature verification. Imported files are re-signed locally as `imported-signed` instead of stored unsigned. Provenance is computed as the minimum trust across endpoints, so a single imported endpoint can't make a merged file inherit `self` trust.
- **SSRF**: all bracketed IPv6 literals are validated against reserved ranges (closes the `[::]` bypass; adds NAT64 `64:ff9b::/96` and deprecated site-local `fec0::/10`). The capture verifier now resolves DNS and uses `redirect: 'manual'`; replay redirect hops get a symmetric post-fetch DNS re-check.
- **Credential egress**: cross-domain redirects forward only a safe transport header allowlist (previously a blocklist that missed custom auth headers like `X-Session`). OAuth refresh errors redact `refresh_token`/`client_secret`. The legacy public-constant signing-key fallback is gated behind `APITAP_ALLOW_LEGACY_KEYS=1`.
- **Supply chain**: removed the `postpublish` lifecycle hook that shelled out during publish; CI actions pinned to commit SHAs; workflow `permissions` restricted to `contents: read`.
- **Native host / extension**: `capture_request` validates the domain before relaying; the bridge socket is created `0o600` with no world-accessible window; agent-initiated captures require per-capture consent (no silent 24h-cache reuse); `_relayId` is validated.

### Privacy

- Capture path now skips human PII / financial / account-security URLs (password, 2fa, checkout, payment, billing, account/security) — previously only the extension did. OAuth/token endpoints stay capturable (auth subsystem).
- Scrubber broadened: provider-prefixed keys (Stripe, GitHub, Slack, GitLab), IBANs, IPv6; credential body-key matching now catches camelCase/prefixed names; query scrub adds OAuth `code`/`state`, password, session id.
- Search index endpoint paths are scrubbed and `index.json` is written `0o600`.
- The passive index captures raw token **values** only for user-approved domains (metadata is still indexed for all).

### Upgrade notes

- Legacy unsigned or `imported`-provenance skill files are now rejected on load — re-import them or pass `--trust-unsigned`. Files signed with the pre-Feb-2026 fixed-salt key require `APITAP_ALLOW_LEGACY_KEYS=1` for a one-off migration.
- Agent-initiated (CLI/MCP) captures now always prompt for consent rather than reusing a 24h approval.

## v1.10.1

### Security
- Security: Updated path-to-regexp to 8.4.2 to fix ReDoS vulnerability (CVE-2026-4926, CVE-2026-4923)

## v1.10.0

### Features

- **`--from known` import source**: Import curated known API specs with a single command. Ships with 31 verified providers including Cloudflare, Discord, Figma, Stripe, GitHub, Slack, and more. Filter by provider name with `--query`. (#43)
  - `apitap import --from known` — import all known specs
  - `apitap import --from known --query stripe` — filter by provider name
- **`data/known-specs.json`**: Curated registry of 31 verified OpenAPI spec URLs for major API providers. Community-contributable via PRs.

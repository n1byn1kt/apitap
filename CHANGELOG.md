# Changelog

## v2.2.1 — 2026-07-24

Both changes came out of driving the Hermes skill with a live agent
(PRs #75, #76).

### Fixed
- One unreadable skill file no longer disables `apitap browse` for its
  domain (#75). A stale or tampered signature used to abort the whole
  run — `Error:` on stderr, no JSON, exit 1 — before discovery and the
  read fallback got their turn. browse now skips the bad file and keeps
  escalating; the guidance carries why in a `skillFileError` field
  (reason `unreadable_skill_file` when nothing else worked). Before
  anything overwrites the bad file — discovery self-heal or a bridge
  capture — a best-effort copy lands in `~/.apitap/skills/.quarantine/`,
  and the overwrite keeps its atomic semantics. `apitap replay` still
  hard-fails on the same file; nothing from an unverified file ever
  shapes a request.

### Changed
- The Hermes skill's claims now match the code (#76): capture's
  `--duration` is documented as mandatory in practice, the equals flag
  form (`--flag=value`) is called out as silently dropped, replay's
  browser conditions are stated precisely, peek/browse cost claims are
  scoped honestly, and the login-wall guidance routes through real
  behaviour. Each load-bearing claim is pinned by a behaviour guard in
  `test/docs/hermes-skill.test.ts` that fails when the code drifts.

## v2.2.0 — 2026-07-20

Closes out the 2026-07-19 dogfood gauntlet (PRs #69, #70, #71, #73).

### Changed
- `apitap doctor` is summary-first (#69): per-check counts by severity +
  severity-weighted top-10 domains instead of a 376-line WARN dump.
  `--verbose` restores the full listing; `doctor <domain>` keeps full
  detail; `--json` unchanged. `doctor --help` now prints help instead of
  running a scan.
- Search ranking demotes import noise (#70): results sort by match
  locality (domain > endpoint > path) → replayability tier → provenance
  (own captures above imports). `search github` returns `api.github.com`
  before 500 apis.guru path hits. Results now carry `provenance`.
- `maxBytes` is a hard envelope cap (#71): it bounds the full serialized
  response on `replay`, `replay_batch` (per result), `browse`, and `read`
  — CLI and MCP. Every response reports `envelopeBytes`. Data budget
  floors at 512 bytes with the envelope skeleton never dropped, so
  impossible budgets yield an honest, bounded overshoot instead of
  dropped metadata. Gauntlet headline case: ~16 KB of stdout at
  `--max-bytes 4000` → ~4.5 KB (documented floor case).
- Wikipedia reads the whole article (#73): full plain-text body via the
  action API when the lede is far under budget (2 MB body cap — the
  512 KB default silently truncated to the lede forever). 301 chars →
  full article with honest `contentTruncated`.
- `--json` runs keep stderr clean (#73): warning-class messages (auth
  hints, SSRF banner, upgrade notes) move into a `notices` array inside
  the JSON envelope — capped and never dropped. Hard errors still exit
  non-zero on stderr.

### Added
- Native lobste.rs decoder (#73): structured story listings via the JSON
  endpoints, no more avatar/login noise.

## v2.1.1 — 2026-07-19

### Fixed
- Replay no longer sends a bare request when a skill's `queryParams` is
  empty but the captured example URL carries a query string (#67): params
  are seeded from `examples.request.url`, so APIs like open-meteo return
  real data instead of an empty 200 — the silent-false-success class from
  the wild dogfood gauntlet. Explicit params still override; populated
  `queryParams` remain authoritative.
- `peek` no longer mislabels client-side transport failures as `blocked`
  (#67): a new `recommendation: 'error'` carries the real failure code in
  `signals` (e.g. `UND_ERR_HEADERS_OVERFLOW` on sites with oversized CSP
  headers, with an explicit "not bot protection" note). SSRF-blocked URLs
  now say "blocked by SSRF protection" instead of a generic "fetch failed".
- `read` labels bot-challenge interstitials instead of returning an empty
  success (#68): Reddit's "please wait for verification" and Cloudflare's
  "Just a moment…" pages now yield `botProtection` on the result,
  `metadata.source: 'challenge-page'`, and an explicit content note rather
  than `content: ""`. Detection is title-driven plus the
  `/cdn-cgi/challenge-platform/` marker, so pages that merely discuss
  captchas are not flagged.

### Added
- `safeFetchDetailed` in the discovery fetch layer: preserves why a fetch
  failed (`kind: 'ssrf' | 'transport'`, code, message). `safeFetch` is
  unchanged as a thin wrapper.

## v2.1.0 — 2026-07-19

### Added
- `apitap doctor` (#66): offline hygiene lint for the skill store. Reports
  junk domains (ad/WAF/consent hosts), tracker beacon endpoints inside good
  skills, duplicate endpoints, empty and stale skill files, never-verified
  (`tier: unknown`) endpoints, unparameterized path families, and
  unsigned/tampered/expired signatures. Exit codes: 0 clean, 1 findings,
  2 operational error — cron-friendly. `--json` for machine output.
- `apitap doctor --fix`: conservative repairs only. Whole files move to
  `~/.apitap/skills/.quarantine/` (rename, non-clobbering — never deleted);
  endpoint-level edits keep a first-touch original under
  `~/.apitap/skills/.doctor/`; `apitap doctor --restore <domain>` undoes
  either. Duplicate endpoints are auto-dropped only when strictly dominated
  (the kept copy is at least as rich on every dimension and carries every
  param/body key); beacon stripping requires both a tracker-path signal and
  a contentless response. Everything else is report-only.

### Security
- Doctor edit fixes are refused on files whose HMAC signature does not
  verify or whose filename does not match the embedded domain — editing and
  re-signing unverified content would launder tampering into a validly
  signed file. Re-signing preserves provenance (`signSkillFileAs` +
  `provenanceForSigning`); quarantine and restore never re-sign. All
  doctor path operations validate domain names before touching the
  filesystem.

## v2.0.1 — 2026-07-19

### Fixed
- Array truncation is now linear (#61): the old pop-loop re-serialized the
  whole array per dropped item — a 50k-item response took minutes, now ~30ms.
  Same fix applied to the object walk, which had the same quadratic pattern.
- Wide flat scalar objects (id-keyed maps, locale dictionaries) no longer
  escape the ~2x `maxBytes` bound (#60): the schema-sample fallback spends a
  byte budget of max(maxBytes, 2 KB), and dropped fields are reported via
  `truncated.droppedFields` and the note.
- `read` envelope now fits `maxBytes` byte-accurately (#62): after links are
  exhausted, content is re-sliced against the serialized envelope and flagged
  with `contentTruncated: true` (also set on the decoder path). Only fixed
  metadata larger than the budget itself can still exceed it. The legacy
  `--no-scan` envelope is unchanged.
- DeepWiki decoder routed through `safeFetch` (#63): gains DNS-resolving SSRF
  validation, manual single-hop redirects with target re-validation, timeout,
  and a 2 MB body cap. `safeFetch` accepts extra request headers for this.

### Security
- The internal `skipSsrf` / `_skipSsrfCheck` test escape hatch is refused
  outside a test run (#64). The warned `--danger-disable-ssrf` CLI flag keeps
  working via an explicit acknowledgment env (`APITAP_DANGER_DISABLE_SSRF=1`)
  that the CLI sets itself; the `browse` command now prints the same warning
  as the other commands when the flag is used.

## v2.0.0 — 2026-07-19

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

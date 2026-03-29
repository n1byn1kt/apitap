# Changelog

## v1.10.0

### Features

- **`--from known` import source**: Import curated known API specs with a single command. Ships with 50+ pre-verified providers including Cloudflare, Discord, Figma, PagerDuty, Sentry, Datadog, Okta, Stripe, GitHub, Slack, and more. Filter by provider name with `--query`. (#43)
  - `apitap import --from known` — import all known specs
  - `apitap import --from known --query stripe` — filter by provider name
- **`data/known-specs.json`**: Curated registry of OpenAPI spec URLs for major API providers. Each entry includes provider name, GitHub repo, spec URL, and notes.

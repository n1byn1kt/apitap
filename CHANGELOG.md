# Changelog

## v1.10.0

### Features

- **`--from known` import source**: Import curated known API specs with a single command. Ships with 31 verified providers including Cloudflare, Discord, Figma, Stripe, GitHub, Slack, and more. Filter by provider name with `--query`. (#43)
  - `apitap import --from known` — import all known specs
  - `apitap import --from known --query stripe` — filter by provider name
- **`data/known-specs.json`**: Curated registry of 31 verified OpenAPI spec URLs for major API providers. Community-contributable via PRs.

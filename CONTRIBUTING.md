# Contributing to ApiTap

Thanks for your interest in contributing to ApiTap.

## Getting Started

```bash
git clone https://github.com/n1byn1kt/apitap.git
cd apitap
npm install
npm test
```

Requires Node.js 20+.

## Development Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add tests for new functionality
4. Run `npm test` and `npm run typecheck` — both must pass
5. Submit a pull request

## Running Tests

```bash
npm test                                    # All tests (366+)
node --import tsx --test test/path/to.ts    # Single test file
npm run typecheck                           # Type checking
```

## Code Style

- TypeScript throughout, no `any` unless unavoidable
- No unnecessary dependencies — stdlib `fetch()` for replay, Playwright only for capture
- TDD: write tests first, then implementation
- Filter aggressively: better to miss an endpoint than pollute skill files

## What to Contribute

- **Bug reports** — File an issue with steps to reproduce
- **Site reports** — Captured a new site? Share the results (without auth)
- **Filter improvements** — Better signal/noise scoring rules
- **Parameterization** — More URL pattern detection
- **Documentation** — Fixes, examples, tutorials

## Architecture

See the README for architecture overview and design constraints.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new behavior
- Update documentation if you change CLI flags or behavior
- Don't introduce new dependencies without discussion

## Reporting Security Issues

See [SECURITY.md](./SECURITY.md) for responsible disclosure.

## License

By contributing, you agree that your contributions will be licensed under the project's [Business Source License 1.1](./LICENSE).

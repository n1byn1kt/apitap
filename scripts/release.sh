#!/usr/bin/env bash
# Usage: bash scripts/release.sh [patch|minor|major]
# Bumps version, publishes to npm, pushes tag to GitHub.

set -euo pipefail

BUMP=${1:-patch}

if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "❌ Invalid bump type: $BUMP. Use patch, minor, or major."
  exit 1
fi

# Must be on main and clean
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "❌ Must be on main branch (currently on $BRANCH)"
  exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# ── Pre-release checklist ─────────────────────────────────────────────────────
set +e
TEST_OUTPUT=$(npm test 2>&1)
set -e
ACTUAL_TESTS=$(echo "$TEST_OUTPUT" | grep "^# tests" | awk '{print $3}')
WEBSITE_TESTS=$(grep -o 'APITAP_TESTS = [0-9]*' ../apitap-website/index.html 2>/dev/null | awk '{print $3}' || echo "?")
README_TESTS=$(grep -o 'tests-[0-9]*%20passing' README.md | grep -o '[0-9]*' || echo "?")

if [[ "$ACTUAL_TESTS" != "$WEBSITE_TESTS" || "$ACTUAL_TESTS" != "$README_TESTS" ]]; then
  echo ""
  echo "⚠️  Test count mismatch — update before releasing:"
  echo "   Actual tests:  $ACTUAL_TESTS"
  echo "   Website (APITAP_TESTS): $WEBSITE_TESTS  → ../apitap-website/index.html"
  echo "   README badge:  $README_TESTS  → README.md"
  echo ""
  read -r -p "Continue anyway? (y/N) " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborted. Update test counts and re-run."
    exit 1
  fi
else
  echo "✅ Test count consistent: $ACTUAL_TESTS tests"
fi
# ─────────────────────────────────────────────────────────────────────────────

# Pull latest
echo "⬇️  Pulling latest main..."
git pull origin main

# Bump version (creates git tag)
echo "🔖 Bumping $BUMP version..."
npm version "$BUMP"

VERSION=$(node -p "require('./package.json').version")

# Publish to npm
echo "🚀 Publishing to npm..."
npm publish --ignore-scripts

# Push commits + tag
echo "⬆️  Pushing to GitHub..."
git push origin main "refs/tags/v$VERSION"

# Create GitHub release (after tag is pushed)
echo "🏷️  Creating GitHub release..."
gh release create "v$VERSION" --title "v$VERSION" --generate-notes

echo ""
echo "✅ v$VERSION shipped!"
echo "   npm: https://www.npmjs.com/package/@apitap/core"
echo "   gh:  https://github.com/n1byn1kt/apitap/releases/tag/v$VERSION"

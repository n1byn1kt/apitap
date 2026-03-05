#!/usr/bin/env bash
# Usage: bash scripts/release.sh [patch|minor|major]
# Bumps version, publishes to npm, pushes tag to GitHub.
# GitHub release is created automatically via postpublish hook.

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

# Pull latest
echo "⬇️  Pulling latest main..."
git pull origin main

# Run tests
echo "🧪 Running tests..."
npm test

# Bump version (creates git tag)
echo "🔖 Bumping $BUMP version..."
npm version "$BUMP"

# Publish to npm
echo "🚀 Publishing to npm..."
npm publish --ignore-scripts

# Push commits + tag
echo "⬆️  Pushing to GitHub..."
git push origin main "refs/tags/v$VERSION"

# Create GitHub release (after tag is pushed)
VERSION=$(node -p "require('./package.json').version")
echo "🏷️  Creating GitHub release..."
gh release create "v$VERSION" --title "v$VERSION" --generate-notes

echo ""
echo "✅ v$VERSION shipped!"
echo "   npm: https://www.npmjs.com/package/@apitap/core"
echo "   gh:  https://github.com/n1byn1kt/apitap/releases/tag/v$VERSION"

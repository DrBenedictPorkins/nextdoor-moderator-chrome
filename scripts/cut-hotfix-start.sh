#!/usr/bin/env bash
# cut-hotfix-start.sh — Branch from a release tag to fix a specific version.
#
# Usage: ./scripts/cut-hotfix-start.sh <tag>
# Example: ./scripts/cut-hotfix-start.sh v1.0.0
#
# What this does:
#   1. Create branch hotfix/v1.0.x from the given tag
#   2. Bump patch version (v1.0.0 → v1.0.1) in package.json + manifest.json
#   3. Build + commit — branch is ready for bugfix work
#
# When done: run ./scripts/cut-hotfix-finish.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "Usage: ./scripts/cut-hotfix-start.sh <tag>"
  echo "Example: ./scripts/cut-hotfix-start.sh v1.0.0"
  echo ""
  echo "Available tags:"
  git tag --sort=-version:refname | head -10
  exit 1
fi

# ── Verify the tag exists ────────────────────────────────────────────────────
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag '$TAG' not found."
  echo ""
  echo "Available tags:"
  git tag --sort=-version:refname | head -10
  exit 1
fi

BASE_VERSION="${TAG#v}"   # strip leading 'v'

# ── Derive patch version ─────────────────────────────────────────────────────
PATCH_VERSION=$(node -p "
  const [major, minor, patch] = '${BASE_VERSION}'.split('.').map(Number);
  \`\${major}.\${minor}.\${patch + 1}\`
")

BRANCH="hotfix/v${BASE_VERSION}x"

# ── Create branch from tag ───────────────────────────────────────────────────
echo "Creating $BRANCH from $TAG"
git checkout -b "$BRANCH" "$TAG"

# ── Bump patch version ───────────────────────────────────────────────────────
npm version "$PATCH_VERSION" --no-git-tag-version --allow-same-version --silent

# ── Sync manifest.json version ───────────────────────────────────────────────
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
m.version = '${PATCH_VERSION}';
fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# ── Build ────────────────────────────────────────────────────────────────────
echo "Building..."
npm run build --silent

# ── Commit version bump ──────────────────────────────────────────────────────
git add package.json package-lock.json manifest.json
git commit -m "Bump version to ${PATCH_VERSION} — hotfix branch"

echo ""
echo "  ✓ Branch:  $BRANCH (from $TAG)"
echo "  ✓ Version: v${PATCH_VERSION}"
echo ""
echo "  Make your fixes, commit, then run:"
echo "  ./scripts/cut-hotfix-finish.sh"

#!/usr/bin/env bash
# cut-release.sh — Tag the current version, bump minor, begin next development cycle.
#
# Usage: ./scripts/cut-release.sh
#
# What this does:
#   1. Abort if working tree is dirty
#   2. Tag HEAD with the current package.json version (vX.Y.Z) — this is the label
#   3. Bump minor version in package.json (X.Y.0 → X.Y+1.0)
#   4. Build (bakes new version + timestamp into dist/)
#   5. Commit the version bump — main is now on the next unreleased version
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ── 1. Verify clean working tree ─────────────────────────────────────────────
if ! git diff --quiet HEAD || ! git diff --quiet --cached; then
  echo "Error: Working tree has uncommitted changes. Commit or stash first."
  echo ""
  git status --short
  exit 1
fi

# ── 2. Read current version (this is what we're tagging) ─────────────────────
CURRENT_VERSION=$(node -p "require('./package.json').version")
TAG="v${CURRENT_VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists. Did you already run release?"
  exit 1
fi

echo "Tagging current code as $TAG"
git tag "$TAG"
echo "  Tagged: $TAG"

# ── 3. Bump minor version ─────────────────────────────────────────────────────
npm version minor --no-git-tag-version --silent
NEW_VERSION=$(node -p "require('./package.json').version")
echo "  Next:   v${NEW_VERSION} (unreleased)"

# ── Sync manifest.json version ───────────────────────────────────────────────
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
m.version = '${NEW_VERSION}';
fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# ── 4. Build — bakes new version + build timestamp into dist/ ────────────────
echo "  Building..."
npm run build --silent

# ── 5. Commit the version bump ───────────────────────────────────────────────
git add package.json package-lock.json manifest.json
git commit -m "Bump version to ${NEW_VERSION} — begin next development cycle"

echo ""
echo "  ✓ Tagged:  $TAG"
echo "  ✓ Now on:  v${NEW_VERSION} (next unreleased version)"
echo ""
echo "  To package for the Chrome Web Store: zip the contents of dist/"
echo "    (cd dist && zip -r ../nextdoor-moderator-chrome-${CURRENT_VERSION}.zip .)"

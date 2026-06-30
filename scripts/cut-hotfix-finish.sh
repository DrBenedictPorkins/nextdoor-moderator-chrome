#!/usr/bin/env bash
# cut-hotfix-finish.sh — Tag the hotfix, merge into main, clean up branch.
#
# Usage: ./scripts/cut-hotfix-finish.sh
#        (must be run from a hotfix/* branch with a clean working tree)
#
# What this does:
#   1. Abort if not on a hotfix/* branch or working tree is dirty
#   2. Tag current HEAD with the hotfix version (vX.Y.Z)
#   3. Switch to main, merge with --no-ff
#   4. Resolve any package.json conflict in favor of main's higher version
#   5. Build + commit the merge
#   6. Delete the hotfix branch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ── 1. Verify on a hotfix branch ─────────────────────────────────────────────
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != hotfix/* ]]; then
  echo "Error: Must be on a hotfix/* branch. Currently on '$BRANCH'."
  exit 1
fi

# ── Verify clean working tree ─────────────────────────────────────────────────
if ! git diff --quiet HEAD || ! git diff --quiet --cached; then
  echo "Error: Working tree has uncommitted changes. Commit your fixes first."
  echo ""
  git status --short
  exit 1
fi

# ── 2. Tag the hotfix ────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists."
  exit 1
fi

git tag "$TAG"
echo "Tagged: $TAG"

# ── 3. Switch to main and merge ──────────────────────────────────────────────
echo "Switching to main..."
git checkout main

echo "Merging $BRANCH..."
# --no-commit lets us fix the package.json conflict before completing the merge
git merge --no-ff --no-commit "$BRANCH" || true

# ── 4. Restore main's package.json (keep main's higher version) ──────────────
# The hotfix bump on the branch would otherwise downgrade main's version
git checkout HEAD -- package.json package-lock.json manifest.json
git add package.json package-lock.json manifest.json

# ── Check for any remaining unresolved conflicts ──────────────────────────────
CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
if [ -n "$CONFLICTS" ]; then
  echo ""
  echo "Conflicts in other files — resolve manually, then:"
  echo "  git add <files>"
  echo "  git commit -m 'Merge $BRANCH into main (hotfix $TAG)'"
  echo "  git branch -d $BRANCH"
  echo ""
  echo "Conflicting files:"
  echo "$CONFLICTS"
  exit 1
fi

# ── 5. Build + complete the merge ────────────────────────────────────────────
echo "Building..."
npm run build --silent

git commit -m "Merge $BRANCH into main (hotfix $TAG)"

# ── 6. Delete hotfix branch ──────────────────────────────────────────────────
git branch -d "$BRANCH"

MAIN_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "  ✓ Tagged:   $TAG"
echo "  ✓ Merged:   $BRANCH → main"
echo "  ✓ Main:     v${MAIN_VERSION} (continuing)"

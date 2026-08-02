#!/usr/bin/env bash
# cut-hotfix-finish.sh — Tag the hotfix, merge into main, restore main's own version.
#
# Usage: ./scripts/cut-hotfix-finish.sh
#        (must be run from a hotfix/* branch with a clean working tree)
#
# What this does:
#   1. Abort if not on a hotfix/* branch, tree is dirty, or the branch's
#      version-bump commit (from cut-hotfix-start.sh) can't be found
#   2. Tag current HEAD with the hotfix version (vX.Y.Z)
#   3. Switch to main, merge with --no-ff, build, commit
#   4. Revert JUST the version-bump commit on top of the merge — restores
#      main's own (higher) version without touching any other change the
#      hotfix made to package.json/package-lock.json/manifest.json, or any
#      other file. (Blindly overwriting those files wholesale would silently
#      discard anything else the hotfix legitimately changed in them.)
#   5. Build again + commit the revert
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

# ── Find the hotfix's version-bump commit (created by cut-hotfix-start.sh) ───
# Located up front, before merging, so we can undo just this one commit's
# changes afterward instead of blindly overwriting version files.
BUMP_COMMIT=$(git log "$BRANCH" --format="%H %s" | grep -F -- "— hotfix branch" | tail -1 | cut -d' ' -f1)
if [ -z "$BUMP_COMMIT" ]; then
  echo "Error: Couldn't find the version-bump commit on $BRANCH (expected a"
  echo "commit ending in '— hotfix branch', created by cut-hotfix-start.sh)."
  echo "Was this branch created by cut-hotfix-start.sh?"
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
git merge --no-ff --no-commit "$BRANCH" || true

CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
if [ -n "$CONFLICTS" ]; then
  echo ""
  echo "Merge conflicts — resolve manually, then:"
  echo "  git add <files>"
  echo "  git commit -m 'Merge $BRANCH into main (hotfix $TAG)'"
  echo "  npm run build"
  echo "  git revert --no-commit $BUMP_COMMIT   # then resolve/commit/build again"
  echo "  git branch -d $BRANCH"
  echo "Or abort with: git merge --abort"
  echo ""
  echo "Conflicting files:"
  echo "$CONFLICTS"
  exit 1
fi

echo "Building..."
npm run build --silent

git commit -m "Merge $BRANCH into main (hotfix $TAG)"

# ── 4. Revert just the version-bump commit ────────────────────────────────────
echo "Reverting version bump ($BUMP_COMMIT) — restoring main's own version..."
git revert --no-commit "$BUMP_COMMIT" || true

REVERT_CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
if [ -n "$REVERT_CONFLICTS" ]; then
  echo ""
  echo "The version-bump revert conflicts with other changes — resolve manually, then:"
  echo "  git add <files>"
  echo "  git commit -m \"Revert hotfix version bump — main stays on its own version\""
  echo "  npm run build"
  echo "  git branch -d $BRANCH"
  echo "Or abort just the revert with: git revert --abort"
  echo ""
  echo "Conflicting files:"
  echo "$REVERT_CONFLICTS"
  exit 1
fi

# ── 5. Build again + commit the revert ────────────────────────────────────────
echo "Building..."
npm run build --silent

git commit -m "Revert hotfix version bump — main stays on its own version"

# ── 6. Delete hotfix branch ────────────────────────────────────────────────────
git branch -d "$BRANCH"

MAIN_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "  ✓ Tagged:   $TAG"
echo "  ✓ Merged:   $BRANCH → main"
echo "  ✓ Main:     v${MAIN_VERSION} (continuing)"

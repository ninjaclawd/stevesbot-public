#!/bin/bash
# Fast-forward local read-only repository mirrors before repo-aware chores run.
set -euo pipefail
shopt -s nullglob

ROOT="${STEVESBOT_ROOT:-$(pwd)}"
REPOS_DIR="$ROOT/repos"
LOG="$ROOT/logs/repo-update.log"
mkdir -p "$(dirname "$LOG")"

if [ ! -d "$REPOS_DIR" ]; then
  echo "[$(date -Iseconds)] Repo update skipped (missing $REPOS_DIR)" | tee -a "$LOG" >&2
  exit 1
fi

FAILED=0
UPDATED=0
SKIPPED=0

echo "[$(date -Iseconds)] Starting repo update" >> "$LOG"
for repo_path in "$REPOS_DIR"/*/; do
  repo_name="$(basename "$repo_path")"
  if [ ! -d "$repo_path/.git" ]; then
    echo "  $repo_name: not a Git repository, skipping" >> "$LOG"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if result="$(git -C "$repo_path" pull --ff-only 2>&1)"; then
    echo "  $repo_name: $result" >> "$LOG"
    UPDATED=$((UPDATED + 1))
  else
    echo "  $repo_name: FAILED: $result" | tee -a "$LOG" >&2
    FAILED=$((FAILED + 1))
  fi
done

summary="[$(date -Iseconds)] Repo update complete; updated=$UPDATED, failed=$FAILED, skipped=$SKIPPED"
echo "$summary" | tee -a "$LOG"
if (( FAILED > 0 )); then
  exit 1
fi

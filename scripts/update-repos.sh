#!/usr/bin/env bash
# Refresh only the reference checkouts configured for this installation.
set -euo pipefail
ROOT="$(cd "${STEVESBOT_ROOT:-$(dirname "$0")/..}" && pwd)"
cd "$ROOT"
mkdir -p logs
targets="$(node scripts/repo-sync-targets.cjs "$ROOT")"
failed=0
while IFS=$'\t' read -r name directory branch repository; do
  if (
    cd "$directory" || exit 1
    [[ -e .git ]] || { echo "Missing checkout"; exit 1; }
    current="$(git symbolic-ref --short HEAD)" || exit 1
    remote="$(git config "branch.$current.remote")" || exit 1
    url="$(git remote get-url "$remote")"
    case "${url%.git}" in
      "https://github.com/$repository"|"git@github.com:$repository") ;;
      *) echo "Unexpected remote for $repository"; exit 1 ;;
    esac
    upstream="$(git rev-parse --abbrev-ref '@{upstream}')" || exit 1
    [[ "$branch" == "-" || ( "$current" == "$branch" && "$upstream" == "$remote/$branch" ) ]] || { echo "Unexpected branch or upstream"; exit 1; }
    changes="$(git status --porcelain --untracked-files=no)" || exit 1
    [[ -z "$changes" ]] || { echo "Tracked local changes"; exit 1; }
    GIT_TERMINAL_PROMPT=0 timeout 45 git fetch --prune "$remote" && git merge-base --is-ancestor HEAD '@{upstream}' && git merge --ff-only '@{upstream}'
  ) >> logs/repo-update.log 2>&1; then
    echo "$name up to date"
  else
    echo "$name failed; see logs/repo-update.log" >&2
    failed=1
  fi
done <<< "$targets"
exit "$failed"

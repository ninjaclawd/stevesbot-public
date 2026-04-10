#!/bin/bash
set -e
ROOT="${STEVESBOT_ROOT:-$(pwd)}"
cd "$ROOT"

DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  fi
done
source .env 2>/dev/null || true

NODE_BIN="${STEVESBOT_NODE:-$(command -v node 2>/dev/null || true)}"
TSX_LOADER="${STEVESBOT_TSX_LOADER:-$ROOT/node_modules/tsx/dist/loader.mjs}"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: No Node runtime available"
  exit 127
fi

run_tsx() {
  "$NODE_BIN" --import "file://$TSX_LOADER" "$@"
}

if [ "$DRY_RUN" != "1" ] && [ -z "$OPENCODE_API_KEY" ]; then
  echo "ERROR: No OPENCODE_API_KEY"
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN: monthly KB refresh validation only; no OpenCode jobs will run."
  echo "Would run deep analysis with model=gpt-5.4-pro"
  echo "Would run KB enrichment with model=gpt-5.4"
  exit 0
fi

echo "Regenerating product reference docs + analysis..."
ANALYZE_MODEL="gpt-5.4-pro" run_tsx scripts/deep-analyze-opencode.ts
echo "Regenerating FAQ + enriching weak entries..."
ENRICH_MODEL="gpt-5.4" run_tsx scripts/enrich-kb-opencode.ts
echo "=== Monthly KB refresh complete ==="
ls -la resources/learnings/*.md | tail -10

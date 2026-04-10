#!/bin/bash
# Weekly KB mining — burns OpenCode credits on unmined threads + KB enrichment
# Launched as a skill so it's tracked in chore_log and visible on the dashboard
set -e
ROOT="${STEVESBOT_ROOT:-$(pwd)}"
cd "$ROOT"

DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  fi
done

# Load env
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

MIN_UNMINED="${WEEKLY_KB_MIN_UNMINED:-20}"
PRIMARY_MODEL="${WEEKLY_KB_PRIMARY_MODEL:-gpt-5.4-mini}"
PRIMARY_LIMIT="${WEEKLY_KB_PRIMARY_LIMIT:-40}"
SECONDARY_MODEL="${WEEKLY_KB_SECONDARY_MODEL:-claude-sonnet-4-6}"
SECONDARY_LIMIT="${WEEKLY_KB_SECONDARY_LIMIT:-25}"
ENRICH_MODEL_NAME="${WEEKLY_KB_ENRICH_MODEL:-gpt-5.4-mini}"
RUN_DEEP_ANALYZE="${WEEKLY_KB_RUN_DEEP_ANALYZE:-0}"
ANALYZE_MODEL_NAME="${WEEKLY_KB_ANALYZE_MODEL:-gpt-5.4}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
MINE_LOGS=()

launch_miner() {
  local label="$1"
  local model="$2"
  local limit="$3"
  if [ -z "$limit" ] || [ "$limit" -le 0 ]; then
    return
  fi

  local log_path="logs/mine-weekly-${RUN_ID}-${label}.log"
  MINE_LOGS+=("$log_path")
  echo "Launching miner ${label}: model=${model}, limit=${limit}"
  MINE_MODEL="$model" run_tsx scripts/mine-with-opencode.ts --limit "$limit" >> "$log_path" 2>&1 &
}

# Check we have credits to burn
if [ "$DRY_RUN" != "1" ] && [ -z "$OPENCODE_API_KEY" ]; then
  echo "ERROR: No OPENCODE_API_KEY set"
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN: weekly mining validation only; no OpenCode jobs will be launched."
  echo "Would launch primary miner: model=${PRIMARY_MODEL}, limit=${PRIMARY_LIMIT}"
  echo "Would launch secondary miner: model=${SECONDARY_MODEL}, limit=${SECONDARY_LIMIT}"
  echo "Would launch enrichment: model=${ENRICH_MODEL_NAME}"
  if [ "$RUN_DEEP_ANALYZE" = "1" ]; then
    echo "Would launch deep analysis: model=${ANALYZE_MODEL_NAME}"
  else
    echo "Deep analysis remains disabled for conservative profile."
  fi
  exit 0
fi

# Count unmined threads
UNMINED=$("$NODE_BIN" -e "
const D=require('better-sqlite3');
const kb=new D('data/sqlite/knowledge.sqlite',{readonly:true});
const arch=new D('data/sqlite/archive.sqlite',{readonly:true});
const mined=kb.prepare('SELECT COUNT(*) as c FROM mined_threads').get().c;
const total=arch.prepare('SELECT COUNT(DISTINCT thread_id) as c FROM archived_messages WHERE thread_id IS NOT NULL').get().c;
console.log(total - mined);
" 2>/dev/null || echo 0)

echo "Unmined threads: $UNMINED"

if [ "$UNMINED" -lt "$MIN_UNMINED" ]; then
  echo "Only $UNMINED unmined threads — below conservative threshold of $MIN_UNMINED. Skipping mining, running enrichment only."
else
  echo "Launching conservative weekly mining profile..."
  launch_miner "primary" "$PRIMARY_MODEL" "$PRIMARY_LIMIT"
  launch_miner "secondary" "$SECONDARY_MODEL" "$SECONDARY_LIMIT"
fi

# Launch enrichment; deep analysis is opt-in for conservative defaults
ENRICH_LOG="logs/enrich-weekly-${RUN_ID}.log"
echo "Launching KB enrichment with model=${ENRICH_MODEL_NAME}..."
ENRICH_MODEL="$ENRICH_MODEL_NAME" run_tsx scripts/enrich-kb-opencode.ts >> "$ENRICH_LOG" 2>&1 &

if [ "$RUN_DEEP_ANALYZE" = "1" ]; then
  ANALYZE_LOG="logs/deep-analyze-weekly-${RUN_ID}.log"
  echo "Launching deep analysis with model=${ANALYZE_MODEL_NAME}..."
  ANALYZE_MODEL="$ANALYZE_MODEL_NAME" run_tsx scripts/deep-analyze-opencode.ts >> "$ANALYZE_LOG" 2>&1 &
else
  echo "Skipping deep analysis for conservative weekly profile."
fi

# Wait for all background jobs
echo "Waiting for all workers to finish..."
wait

# Count results
MINED_NOW=$("$NODE_BIN" -e "
const D=require('better-sqlite3');
const kb=new D('data/sqlite/knowledge.sqlite',{readonly:true});
console.log(kb.prepare('SELECT COUNT(*) as c FROM mined_threads').get().c);
" 2>/dev/null)

TOTAL_OK=0
for f in "${MINE_LOGS[@]}"; do
  if [ -f "$f" ]; then
    C=$(grep -c "OK:" "$f" 2>/dev/null || true)
    C="${C:-0}"
    TOTAL_OK=$((TOTAL_OK + C))
  fi
done

TOTAL_ERR=0
for f in "${MINE_LOGS[@]}"; do
  if [ -f "$f" ]; then
    C=$(grep -c "ERROR:" "$f" 2>/dev/null || true)
    C="${C:-0}"
    TOTAL_ERR=$((TOTAL_ERR + C))
  fi
done

echo ""
echo "=== Weekly KB Mining Complete ==="
echo "Threads mined this run: $TOTAL_OK"
echo "Errors: $TOTAL_ERR"
echo "Total KB entries now: $MINED_NOW"
echo "Unmined remaining: $((UNMINED - TOTAL_OK))"

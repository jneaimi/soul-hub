#!/bin/bash
set -euo pipefail
# miner.sh — Run The Miner (Agent 1) to analyze collected signals
#
# Usage:
#   ./miner.sh                        Daily incremental run (default)
#   ./miner.sh --weekly               Weekly comprehensive report
#   ./miner.sh --full                 Full analysis (ignore mined_at)
#   ./miner.sh --budget 1.00          Override budget
#   ./miner.sh --lookback-days 3      Override lookback window
#   ./miner.sh --quick                Quick mode (fewer topics, no transcript quotes)

source "$(dirname "$0")/paths.sh"

# Source env vars (API keys etc)
eval "$(grep '^export ' "$HOME/.zshrc" 2>/dev/null)" 2>/dev/null || true

MODEL="${MINER_MODEL:-sonnet}"
LOG_FILE="/tmp/miner-${MI_DATE}.log"
CONFIG="$MI_CONFIG/miner-config.md"

# Read config from brain
CONFIG_VALUES=$(python3 -c "
import re
text = open('$CONFIG').read()
fm = text.split('---')[1] if '---' in text else ''
def get(key, default):
    m = re.search(rf'{key}:\s*([\d.]+)', fm)
    return m.group(1) if m else default
print(f'{get(\"budget_per_run\", \"0.50\")} {get(\"lookback_days\", \"7\")}')
" 2>/dev/null || echo "0.50 7")

BASE_BUDGET=$(echo "$CONFIG_VALUES" | cut -d' ' -f1)
LOOKBACK=$(echo "$CONFIG_VALUES" | cut -d' ' -f2)
BUDGET=""
MODE="daily"
QUICK=""

# Parse flags (override config)
while [[ $# -gt 0 ]]; do
    case "$1" in
        --budget) BUDGET="$2"; shift 2 ;;
        --lookback-days) LOOKBACK="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --weekly) MODE="weekly"; shift ;;
        --full) MODE="full"; shift ;;
        --quick) QUICK="--quick"; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

# ──────────────────────────────────────────────
# PRE-FLIGHT: Check DB has data
# ──────────────────────────────────────────────
if [ ! -f "$MI_DB" ]; then
    echo "[ERROR] No database found at $MI_DB — run the Scout first" >&2
    exit 1
fi

POST_COUNT=$(sqlite3 "$MI_DB" "SELECT COUNT(*) FROM posts WHERE fetched_at >= datetime('now', '-${LOOKBACK} days');" 2>/dev/null || echo "0")
SIGNAL_COUNT=$(sqlite3 "$MI_DB" "SELECT COUNT(*) FROM market_signals WHERE fetched_at >= datetime('now', '-${LOOKBACK} days');" 2>/dev/null || echo "0")
TRANSCRIPT_COUNT=$(sqlite3 "$MI_DB" "SELECT COUNT(*) FROM posts WHERE fetched_at >= datetime('now', '-${LOOKBACK} days') AND transcript IS NOT NULL AND transcript != '' AND transcript != '[unavailable]';" 2>/dev/null || echo "0")

if [ "$POST_COUNT" -eq 0 ]; then
    echo "[ERROR] No posts in the last ${LOOKBACK} days — run the Scout first" >&2
    exit 1
fi

# ──────────────────────────────────────────────
# BUDGET SCALING: based on data volume
# ──────────────────────────────────────────────
if [ -z "$BUDGET" ]; then
    BUDGET=$(python3 -c "
base = $BASE_BUDGET
signals = $SIGNAL_COUNT
transcripts = $TRANSCRIPT_COUNT
scaled = base + (signals * 0.003) + (transcripts * 0.05) + 0.50
clamped = max(1.00, min(5.00, scaled))
print(round(clamped, 2))
" 2>/dev/null || echo "2.00")
fi

TOTAL_DATA=$((POST_COUNT + SIGNAL_COUNT))
echo "[START] Miner run — $MI_DATE" >&2
echo "[INFO] Budget: \$$BUDGET (scaled) | Model: $MODEL | Lookback: ${LOOKBACK}d" >&2
echo "[INFO] Data: $POST_COUNT posts + $SIGNAL_COUNT market signals + $TRANSCRIPT_COUNT transcripts = $TOTAL_DATA total" >&2

# ──────────────────────────────────────────────
# Ensure output directory exists
# ──────────────────────────────────────────────
mkdir -p "$MI_OUTPUT"

# ──────────────────────────────────────────────
# Heartbeat
# ──────────────────────────────────────────────
_heartbeat() {
    local elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        echo "[STATUS] Miner working... (${elapsed}s)" >&2
    done
}

_heartbeat & HEARTBEAT_PID=$!
trap 'kill $HEARTBEAT_PID 2>/dev/null || true' EXIT INT TERM

# ──────────────────────────────────────────────
# Build prompt with quick mode adjustments
# ──────────────────────────────────────────────
QUICK_INSTRUCTIONS=""
if [ -n "$QUICK" ]; then
    QUICK_INSTRUCTIONS="QUICK MODE: Set max_trending_topics=3, max_pain_points=5, include_transcript_quotes=false. Produce a shorter report."
fi

# ──────────────────────────────────────────────
# RUN THE AGENT
# ──────────────────────────────────────────────

# Determine report filename based on mode
if [ "$MODE" = "weekly" ]; then
    REPORT_NAME="${MI_DATE}-miner-weekly.md"
else
    REPORT_NAME="${MI_DATE}-miner-daily.md"
fi

MARKET_CONTEXT="$MI_CONFIG/market-context.md"

MODE_INSTRUCTIONS=""
if [ "$MODE" = "daily" ]; then
    MODE_INSTRUCTIONS="DAILY MODE: Only analyze unmined data (WHERE mined_at IS NULL). Produce a daily brief."
elif [ "$MODE" = "weekly" ]; then
    MODE_INSTRUCTIONS="WEEKLY MODE: Analyze ALL data in the lookback window. Read findings table for the past 7 days to aggregate. Produce comprehensive weekly report."
elif [ "$MODE" = "full" ]; then
    MODE_INSTRUCTIONS="FULL MODE: Analyze ALL data in the lookback window regardless of mined_at. Produce comprehensive report."
fi

# Check for pre-processed data pack
DATA_PACK_INSTRUCTIONS=""
DATA_PACK="$MI_OUTPUT/_prep/${MI_DATE}-weekly-data-pack.md"
if [ -f "$DATA_PACK" ] && [ "$MODE" = "weekly" ]; then
    DATA_PACK_INSTRUCTIONS="IMPORTANT: A pre-processed data pack is available at: $DATA_PACK
Read it FIRST — it contains pre-aggregated stats, top posts, transcript quotes, pain signals,
topic convergence, and audience comments. Use this instead of running SQL queries for overview data.
Only query the DB directly for specific details not in the data pack."
    echo "[INFO] Data pack found: $(basename "$DATA_PACK")" >&2
fi

claude --agent "$MI_AGENTS/miner.md" \
    -p "Run the miner analysis for $MI_DATE.

Mode: $MODE
$MODE_INSTRUCTIONS

Read config from: $CONFIG
Read market context from: $MARKET_CONTEXT
Database: $MI_DB
Lookback days: $LOOKBACK
Save report to: $MI_OUTPUT/$REPORT_NAME

$DATA_PACK_INSTRUCTIONS

$QUICK_INSTRUCTIONS

Use these tool paths:
- Scout DB: $MI_SCRIPTS/scout_db.py
- SQLite: sqlite3 $MI_DB" \
    --allowedTools "Read(*),Write($MI_OUTPUT/*),Write(/tmp/miner-*),Bash(sqlite3*),Bash(uv run*),Bash(python3*),Bash(echo*),Glob(*),Grep(*)" \
    --max-budget-usd "$BUDGET" \
    --model "$MODEL" \
    --verbose \
    --output-format stream-json \
    >> "$LOG_FILE" 2>&1 || true

kill $HEARTBEAT_PID 2>/dev/null || true

# ──────────────────────────────────────────────
# POST-RUN: Verify + Notify
# ──────────────────────────────────────────────

REPORT="$MI_OUTPUT/$REPORT_NAME"

if [ ! -f "$REPORT" ]; then
    echo "[ERROR] Miner report not generated" >&2
    exit 1
fi

REPORT_LINES=$(wc -l < "$REPORT" | tr -d ' ')

# ──────────────────────────────────────────────
# POST-RUN: Parse report into DB findings
# ──────────────────────────────────────────────
echo "[PHASE] Parsing report into DB findings" >&2

PARSE_RESULT=$(uv run "$MI_SCRIPTS/parse_report.py" "$REPORT" --run-mode "$MODE" 2>/dev/null || echo '{"error":"parse failed"}')
FINDINGS_COUNT=$(echo "$PARSE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_findings', 0))" 2>/dev/null || echo "0")
OPPS_COUNT=$(echo "$PARSE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('opportunities', 0))" 2>/dev/null || echo "0")

echo "[STEP] Findings stored: $FINDINGS_COUNT | Opportunities: $OPPS_COUNT" >&2

# ──────────────────────────────────────────────
# POST-RUN: Mark data as mined
# ──────────────────────────────────────────────
echo "[PHASE] Marking analyzed data as mined" >&2

MARK_RESULT=$(uv run "$MI_SCRIPTS/scout_db.py" mark-mined --lookback-days "$LOOKBACK" 2>/dev/null || echo '{"error":"mark failed"}')
POSTS_MARKED=$(echo "$MARK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('posts_marked', 0))" 2>/dev/null || echo "0")
SIGNALS_MARKED=$(echo "$MARK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('signals_marked', 0))" 2>/dev/null || echo "0")

echo "[STEP] Marked as mined: $POSTS_MARKED posts, $SIGNALS_MARKED signals" >&2
echo "[DONE] Miner complete — report ($REPORT_LINES lines), $FINDINGS_COUNT findings, $((POSTS_MARKED + SIGNALS_MARKED)) items marked mined" >&2

# Send Telegram notification
MSG="Miner Report — $MI_DATE

Data: $POST_COUNT posts + $SIGNAL_COUNT market signals + $TRANSCRIPT_COUNT transcripts
Budget: \$$BUDGET (scaled)
Report: $REPORT_LINES lines

Open in Obsidian to review."

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${MSG}" \
        -d "disable_web_page_preview=true" \
        --max-time 15 > /dev/null 2>&1 || true
else
    echo "[WARN] Telegram credentials not set, skipping notification" >&2
fi

# Ensure PIPELINE_OUTPUT points to the report (Soul Hub verifies this)
if [ -n "${PIPELINE_OUTPUT:-}" ] && [ "$PIPELINE_OUTPUT" != "$REPORT" ]; then
    mkdir -p "$(dirname "$PIPELINE_OUTPUT")"
    cp "$REPORT" "$PIPELINE_OUTPUT"
fi

exit 0

#!/bin/bash
set -euo pipefail
# strategist.sh — Run The Strategist (Pipeline Step 5) for business opportunity analysis
#
# Usage:
#   ./strategist.sh                        Standard weekly run
#   ./strategist.sh --budget 2.00          Override budget
#   ./strategist.sh --lookback-weeks 6     Override lookback window
#   ./strategist.sh --act-now-only         Only report ACT NOW tier

source "$(dirname "$0")/paths.sh"

# Source env vars (API keys etc)
eval "$(grep '^export ' "$HOME/.zshrc" 2>/dev/null)" 2>/dev/null || true

MODEL="${STRATEGIST_MODEL:-sonnet}"
LOG_FILE="/tmp/strategist-${MI_DATE}.log"
CONFIG="$MI_CONFIG/strategist-config.md"

# Read config from brain
CONFIG_VALUES=$(python3 -c "
import re
text = open('$CONFIG').read()
fm = text.split('---')[1] if '---' in text else ''
def get(key, default):
    m = re.search(rf'{key}:\s*([\d.]+)', fm)
    return m.group(1) if m else default
print(f'{get(\"budget_per_run\", \"1.50\")} {get(\"lookback_weeks\", \"4\")}')
" 2>/dev/null || echo "1.50 4")

BASE_BUDGET=$(echo "$CONFIG_VALUES" | cut -d' ' -f1)
LOOKBACK_WEEKS=$(echo "$CONFIG_VALUES" | cut -d' ' -f2)
BUDGET=""
ACT_NOW_ONLY=""

# Parse flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        --budget) BUDGET="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --lookback-weeks) LOOKBACK_WEEKS="$2"; shift 2 ;;
        --act-now-only) ACT_NOW_ONLY="true"; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
done

# ──────────────────────────────────────────────
# PRE-FLIGHT: Check DB has accumulated data
# ──────────────────────────────────────────────
if [ ! -f "$MI_DB" ]; then
    echo "[ERROR] No database found at $MI_DB — run the full pipeline first" >&2
    exit 1
fi

LOOKBACK_DAYS=$((LOOKBACK_WEEKS * 7))

FINDINGS_COUNT=$(sqlite3 "$MI_DB" "SELECT COUNT(*) FROM findings WHERE created_at >= datetime('now', '-${LOOKBACK_DAYS} days');" 2>/dev/null || echo "0")
DAYS_WITH_DATA=$(sqlite3 "$MI_DB" "SELECT COUNT(DISTINCT date(created_at)) FROM findings WHERE created_at >= datetime('now', '-${LOOKBACK_DAYS} days');" 2>/dev/null || echo "0")
OPP_COUNT=$(sqlite3 "$MI_DB" "SELECT COUNT(*) FROM opportunities WHERE created_at >= datetime('now', '-${LOOKBACK_DAYS} days');" 2>/dev/null || echo "0")

if [ "$FINDINGS_COUNT" -eq 0 ]; then
    echo "[ERROR] No findings in the last ${LOOKBACK_WEEKS} weeks — run the daily pipeline first" >&2
    exit 1
fi

if [ "$DAYS_WITH_DATA" -lt 3 ]; then
    echo "[WARN] Only $DAYS_WITH_DATA days of data (recommend 7+). Results may have low confidence." >&2
fi

# ──────────────────────────────────────────────
# BUDGET: Scale with data volume
# ──────────────────────────────────────────────
if [ -z "$BUDGET" ]; then
    BUDGET=$(python3 -c "
base = $BASE_BUDGET
findings = $FINDINGS_COUNT
days = $DAYS_WITH_DATA
scaled = base + (findings * 0.02) + (days * 0.05)
clamped = max(1.50, min(4.00, scaled))
print(round(clamped, 2))
" 2>/dev/null || echo "2.00")
fi

echo "[START] Strategist run — $MI_DATE" >&2
echo "[INFO] Budget: \$$BUDGET | Model: $MODEL | Lookback: ${LOOKBACK_WEEKS} weeks" >&2
echo "[INFO] Data: $FINDINGS_COUNT findings across $DAYS_WITH_DATA days | $OPP_COUNT existing opportunities" >&2

# ──────────────────────────────────────────────
# Ensure output directory exists
# ──────────────────────────────────────────────
mkdir -p "$MI_OUTPUT"

# ──────────────────────────────────────────────
# ACT-NOW-ONLY mode
# ──────────────────────────────────────────────
ACT_NOW_INSTRUCTIONS=""
if [ -n "$ACT_NOW_ONLY" ]; then
    ACT_NOW_INSTRUCTIONS="ACT-NOW-ONLY MODE: Only report opportunities scoring >= 24. Skip DEVELOP and WATCH tiers."
fi

# ──────────────────────────────────────────────
# Heartbeat
# ──────────────────────────────────────────────
_heartbeat() {
    local elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        echo "[STATUS] Strategist working... (${elapsed}s)" >&2
    done
}

_heartbeat & HEARTBEAT_PID=$!
trap 'kill $HEARTBEAT_PID 2>/dev/null || true' EXIT INT TERM

# ──────────────────────────────────────────────
# RUN THE AGENT
# ──────────────────────────────────────────────
REPORT_NAME="${MI_DATE}-strategist-weekly.md"
MARKET_CONTEXT="$MI_CONFIG/market-context.md"
BRAND_ASSETS="$MI_CONFIG/brand-assets.md"

# Generate strategist prep (Python — pre-computes patterns, scores, clusters)
echo "[STEP] Running strategist prep (Python)..." >&2
python3 "$MI_SCRIPTS/strategist_prep.py" --lookback-weeks "$LOOKBACK_WEEKS" >> "$LOG_FILE" 2>&1 || true

# Check for pre-processed prep file
DATA_PACK_INSTRUCTIONS=""
PREP_FILE="$MI_OUTPUT/_prep/${MI_DATE}-strategist-prep.md"
if [ -f "$PREP_FILE" ]; then
    DATA_PACK_INSTRUCTIONS="IMPORTANT: A pre-processed strategist prep is available at: $PREP_FILE
Read it FIRST — it contains pre-detected patterns (persistent pain, convergence, pain clusters,
asset-market fits), pre-computed opportunity scores, and evolution tracking.
The prep has partially scored each candidate. Your job: score the AI_JUDGE factors,
calculate totals, assign categories, and write the Brief.
Do NOT re-query the database for aggregation — the prep has everything."
    echo "[INFO] Strategist prep found: $(basename "$PREP_FILE")" >&2
fi

claude --agent "$MI_AGENTS/strategist.md" \
    -p "Run the Strategist analysis for week of $MI_DATE.

Read config from: $CONFIG
Read market context from: $MARKET_CONTEXT
Read brand assets from: $BRAND_ASSETS
Database: $MI_DB
Lookback: $LOOKBACK_WEEKS weeks ($LOOKBACK_DAYS days)
Save report to: $MI_OUTPUT/$REPORT_NAME

$DATA_PACK_INSTRUCTIONS

Previous Strategist reports (if any): $MI_OUTPUT/*-strategist-weekly.md
Latest Miner weekly report: find in $MI_OUTPUT/*-miner-weekly.md

$ACT_NOW_INSTRUCTIONS

Use these tool paths:
- SQLite: sqlite3 $MI_DB" \
    --allowedTools "Read(*),Write($MI_OUTPUT/*),Bash(sqlite3*),Bash(ls*),Bash(echo*),Bash(find*),Glob(*),Grep(*)" \
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
    echo "[WARN] Strategist report not generated — check log at $LOG_FILE" >&2
else
    REPORT_LINES=$(wc -l < "$REPORT" | tr -d ' ')
    echo "[DONE] Strategist complete — report: $REPORT ($REPORT_LINES lines)" >&2
fi

# Count opportunities by tier from report
ACT_COUNT=$(grep -c "^### " "$REPORT" 2>/dev/null | head -1 || echo "0")
echo "[INFO] Opportunities found: ~$ACT_COUNT sections" >&2

# ──────────────────────────────────────────────
# Telegram notification
# ──────────────────────────────────────────────
MSG="Strategist Report — $MI_DATE

Data: $FINDINGS_COUNT findings across $DAYS_WITH_DATA days
Lookback: $LOOKBACK_WEEKS weeks
Budget: \$$BUDGET

Review the Business Opportunity Brief in Obsidian."

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
if [ -n "${PIPELINE_OUTPUT:-}" ] && [ -f "$REPORT" ] && [ "$PIPELINE_OUTPUT" != "$REPORT" ]; then
    mkdir -p "$(dirname "$PIPELINE_OUTPUT")"
    cp "$REPORT" "$PIPELINE_OUTPUT"
fi

exit 0

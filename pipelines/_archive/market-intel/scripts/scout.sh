#!/bin/bash
set -euo pipefail
# scout.sh — Run The Scout to fetch daily influencer signals
#
# Calls scout_run.py (deterministic Python script, no AI agent).
#
# Usage:
#   ./scout.sh                    Run with defaults

source "$(dirname "$0")/paths.sh"

# Source env vars (API keys etc)
eval "$(grep '^export ' "$HOME/.zshrc" 2>/dev/null)" 2>/dev/null || true

LOG_FILE="/tmp/scout-${MI_DATE}.log"

echo "[START] Scout run — $MI_DATE" >&2

# ──────────────────────────────────────────────
# RUN THE DETERMINISTIC SCOUT
# ──────────────────────────────────────────────

python3 "$MI_SCRIPTS/scout_run.py" "$@" >> "$LOG_FILE" 2>&1 || true
SCOUT_EXIT=$?

# ──────────────────────────────────────────────
# POST-RUN: Summary + Notification
# ──────────────────────────────────────────────

echo "[PHASE] Post-run summary" >&2

SUMMARY=$(uv run "$MI_SCRIPTS/scout_db.py" summary 2>/dev/null || echo '{"error":"failed to read DB"}')
POSTS_TODAY=$(echo "$SUMMARY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('posts_today', 0))" 2>/dev/null || echo "?")

MSG="Scout Daily Run — $MI_DATE

Posts collected today: $POSTS_TODAY

$SUMMARY"

# Send Telegram notification
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

# Write pipeline output (Soul Hub expects a file at PIPELINE_OUTPUT)
OUTPUT="${PIPELINE_OUTPUT:-/tmp/scout-status.json}"
mkdir -p "$(dirname "$OUTPUT")"
POSTS_NUM=$(echo "$POSTS_TODAY" | grep -o '[0-9]*' || echo "0")
echo "{\"date\":\"$MI_DATE\",\"posts_today\":${POSTS_NUM:-0},\"status\":\"ok\"}" > "$OUTPUT"

echo "[DONE] Scout complete — $POSTS_TODAY posts collected" >&2
exit $SCOUT_EXIT

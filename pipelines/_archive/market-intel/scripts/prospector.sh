#!/bin/bash
set -euo pipefail
# prospector.sh — Run The Prospector to fetch market signals on trending topics
#
# Calls prospector_run.py (deterministic Python script, no AI agent).
#
# Usage:
#   ./prospector.sh                              Auto mode (top N topics from Miner)
#   ./prospector.sh --topic "Claude Code memory"  Manual mode (single topic)
#   ./prospector.sh --max-topics 5               Override max topics

source "$(dirname "$0")/paths.sh"

# Source env vars (API keys etc)
eval "$(grep '^export ' "$HOME/.zshrc" 2>/dev/null)" 2>/dev/null || true

LOG_FILE="/tmp/prospector-${MI_DATE}.log"

echo "[START] Prospector run — $MI_DATE" >&2

# ──────────────────────────────────────────────
# RUN THE DETERMINISTIC PROSPECTOR
# ──────────────────────────────────────────────

# Prospector is non-fatal — continue even if it fails (Miner works with posts only)
python3 "$MI_SCRIPTS/prospector_run.py" "$@" >> "$LOG_FILE" 2>&1 || {
    echo "[WARN] Prospector failed — continuing (Miner can work with posts only)" >&2
}
PROSPECTOR_EXIT=0

# ──────────────────────────────────────────────
# POST-RUN: Summary + Notification
# ──────────────────────────────────────────────

MARKET_STATS=$(uv run "$MI_SCRIPTS/scout_db.py" market-summary --days 1 2>/dev/null || echo '{"error":"failed"}')
SIGNAL_COUNT=$(echo "$MARKET_STATS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('signals_last_n_days', 0))" 2>/dev/null || echo "?")

echo "[DONE] Prospector complete — $SIGNAL_COUNT market signals stored" >&2

MSG="Prospector Data Collection — $MI_DATE

Market signals stored: $SIGNAL_COUNT

Run the Miner next to analyze all data."

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

# Write pipeline output
OUTPUT="${PIPELINE_OUTPUT:-/tmp/prospector-status.json}"
mkdir -p "$(dirname "$OUTPUT")"
SIGNAL_COUNT_NUM=$(echo "$SIGNAL_COUNT" | grep -o '[0-9]*' || echo "0")
echo "{\"date\":\"$MI_DATE\",\"signals\":${SIGNAL_COUNT_NUM:-0},\"status\":\"ok\"}" > "$OUTPUT"

exit $PROSPECTOR_EXIT

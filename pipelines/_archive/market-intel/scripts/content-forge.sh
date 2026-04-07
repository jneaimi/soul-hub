#!/bin/bash
set -euo pipefail
# content-forge.sh — Generate enriched content menu from today's findings
#
# Two-step process:
#   1. Python prep (content_prep.py) — dedup, score, rank, extract supporting data (~1s, $0)
#   2. AI enrichment (Claude agent) — add titles, hooks, angles (~2-3min, ~$0.50)
#
# Usage:
#   ./content-forge.sh                        Standard (prep + AI enrich)
#   ./content-forge.sh --prep-only            Only run Python prep, skip AI
#   ./content-forge.sh --hot-only             Only HOT items
#   ./content-forge.sh --lookback 3           Look back 3 days
#   ./content-forge.sh --budget 1.00          Override AI enrichment budget

source "$(dirname "$0")/paths.sh"

# Source env vars (API keys etc)
eval "$(grep '^export ' "$HOME/.zshrc" 2>/dev/null)" 2>/dev/null || true

MODEL="${CONTENT_FORGE_MODEL:-sonnet}"
LOG_FILE="/tmp/content-forge-${MI_DATE}.log"
IDEAS_DIR="$MI_OUTPUT/ideas"
BUDGET="0.75"
LOOKBACK="1"
HOT_ONLY=""
PREP_ONLY=""
PLATFORMS="linkedin"
MAX_HOT="3"
LANGUAGES="en,ar"

# Parse flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        --budget) BUDGET="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --lookback) LOOKBACK="$2"; shift 2 ;;
        --hot-only) HOT_ONLY="--hot-only"; shift ;;
        --prep-only) PREP_ONLY="true"; shift ;;
        --platforms) PLATFORMS="$2"; shift 2 ;;
        --max-hot) MAX_HOT="$2"; shift 2 ;;
        --languages) LANGUAGES="$2"; shift 2 ;;
        *) shift ;;
    esac
done

echo "[START] Content Menu generation — $MI_DATE" >&2

# ──────────────────────────────────────────────
# STEP 1: Python prep (dedup, score, rank, extract data)
# ──────────────────────────────────────────────

echo "[STEP 1] Running content prep (Python)..." >&2
python3 "$MI_SCRIPTS/content_prep.py" --lookback "$LOOKBACK" $HOT_ONLY >> "$LOG_FILE" 2>&1
PREP_EXIT=$?

PREP_FILE="$MI_OUTPUT/_prep/${MI_DATE}-content-prep.md"
if [ ! -f "$PREP_FILE" ]; then
    echo "[ERROR] Content prep failed — no prep file generated" >&2
    exit 1
fi

PREP_LINES=$(wc -l < "$PREP_FILE" | tr -d ' ')
echo "[OK] Prep ready — $PREP_LINES lines" >&2

# If --prep-only, stop here
if [ -n "$PREP_ONLY" ]; then
    echo "[DONE] Prep-only mode — review $PREP_FILE and run with AI enrichment when ready" >&2
    exit 0
fi

# ──────────────────────────────────────────────
# STEP 2: AI enrichment (titles, hooks, angles)
# ──────────────────────────────────────────────

echo "[STEP 2] AI enrichment (Claude agent)..." >&2

BRAND_VOICE="$HOME/.claude/skills/arabic/references/brand-voice.md"
STOP_SLOP_PHRASES="$HOME/.claude/skills/stop-slop/references/phrases.md"

mkdir -p "$IDEAS_DIR"

claude --agent "$MI_AGENTS/content-forge.md" \
    -p "Generate the content menu for $MI_DATE.

READ THE PREP FILE FIRST: $PREP_FILE
It contains pre-scored, deduped findings with supporting data (comments, quotes, market signals, brand asset matches).

DO NOT re-query the database. DO NOT re-score findings. The prep file has everything you need.

YOUR ONLY JOB:
1. Read the prep file
2. For each HOT and WARM item, write:
   - Title (EN) — punchy, under 80 chars
   - Title (AR) — rewrite in brand voice, not translation
   - Hook (EN) — 1-2 sentences, evidence-first, no throat-clearers
   - Hook (AR) — rewrite for GCC audience, warm+professional
   - Key data points — 3-5 bullets from the prep data
   - Brand asset CTA if the prep matched one
3. Write the content menu to: $MI_OUTPUT/${MI_DATE}-content-menu.md
4. Write seeds JSON to: $IDEAS_DIR/${MI_DATE}-seeds.json

Read brand voice from: $BRAND_VOICE
Read stop-slop phrases from: $STOP_SLOP_PHRASES

Keep the scoring table from the prep file. Add your editorial layer on top.
Platform: LinkedIn only. EN + AR per item." \
    --allowedTools "Read(*),Write($MI_OUTPUT/*),Write($IDEAS_DIR/*),Bash(echo*),Bash(ls*),Glob(*),Grep(*)" \
    --max-budget-usd "$BUDGET" \
    --model "$MODEL" \
    --verbose \
    --output-format stream-json \
    >> "$LOG_FILE" 2>&1 || true

# ──────────────────────────────────────────────
# POST-RUN: Verify
# ──────────────────────────────────────────────

MENU="$MI_OUTPUT/${MI_DATE}-content-menu.md"
if [ -f "$MENU" ]; then
    MENU_LINES=$(wc -l < "$MENU" | tr -d ' ')
    echo "[DONE] Content menu ready — $MENU_LINES lines (AI-enriched)" >&2
else
    # Fallback: use the prep file as the menu
    echo "[WARN] AI enrichment didn't produce a menu — using prep as fallback" >&2
    cp "$PREP_FILE" "$MENU"
    MENU_LINES=$(wc -l < "$MENU" | tr -d ' ')
fi

# Telegram
MSG="Content Menu Ready — $MI_DATE ($MENU_LINES lines, AI-enriched)

Review in Obsidian, then draft with /draft"

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${MSG}" \
        -d "disable_web_page_preview=true" \
        --max-time 15 > /dev/null 2>&1 || true
fi

# Ensure PIPELINE_OUTPUT points to the menu (Soul Hub verifies this)
if [ -n "${PIPELINE_OUTPUT:-}" ] && [ -f "$MENU" ] && [ "$PIPELINE_OUTPUT" != "$MENU" ]; then
    mkdir -p "$(dirname "$PIPELINE_OUTPUT")"
    cp "$MENU" "$PIPELINE_OUTPUT"
fi

exit 0

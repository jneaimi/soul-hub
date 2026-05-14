#!/bin/bash
# peer-brief-render.sh — Render today's Signal Forge miner-daily into a peer-brief PDF
#
# Pipeline:
#   1. Resolve today's miner-daily report
#   2. Extract 14-day signal-trend YAML (helper script)
#   3. Synthesise recipe via peer-brief-synth agent (Sonnet)
#   4. Stop-slop scan the synthesised recipe (block on fail)
#   5. Build PDF via katib (--brand jasem)
#
# Usage:
#   ./peer-brief-render.sh                              # today
#   ./peer-brief-render.sh --date 2026-05-14            # specific day
#   ./peer-brief-render.sh --date 2026-05-14 --dry-run  # skip render, keep recipe
#   ./peer-brief-render.sh --date 2026-05-14 --out /tmp/test.pdf
#   PEER_BRIEF_MODEL=opus ./peer-brief-render.sh        # override model
#
# Exit codes:
#   0  success (PDF rendered + alert sent if configured)
#   2  bad CLI args
#   4  missing input (miner-daily report not found)
#   5  synthesis failed (agent returned [SYNTH-FAIL] or no output)
#   6  stop-slop gate failed
#   7  katib build failed
#   8  Telegram alert failed (PDF is still on disk; non-fatal for the brief)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source env vars
eval "$(grep '^export ' "$HOME/.zshrc" 2>/dev/null)" 2>/dev/null || true

# ── Defaults ──────────────────────────────────────────────────────────────
DATE="$(date +%Y-%m-%d)"
MODEL="${PEER_BRIEF_MODEL:-sonnet}"
BUDGET="${PEER_BRIEF_BUDGET:-2.00}"
DRY_RUN=""
OUT_OVERRIDE=""
MIN_SCORE="${PEER_BRIEF_MIN_SCORE:-30}"
NO_NOTIFY=""
TG_CHAT_ID="${PEER_BRIEF_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"

REPORTS_DIR="$HOME/vault/content/signal-forge/reports"
CANONICAL_RECIPE="$HOME/.katib/recipes/peer-brief-2026-05-14-miner-daily-en.yaml"
TREND_HELPER="$HOME/.claude/skills/katib/scripts/extract-signal-trend.py"
KATIB_BUILD="$HOME/.claude/skills/katib/scripts/build.py"
SYNTH_AGENT="$HOME/.claude/agents/peer-brief-synth.md"
SCANNER="$SCRIPT_DIR/peer-brief/stop-slop-scan.py"

WORK_DIR="$(mktemp -d -t peer-brief-XXXXX)"
trap 'echo "[INFO] work dir: $WORK_DIR" >&2' EXIT

# ── Parse flags ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --date) DATE="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --budget) BUDGET="$2"; shift 2 ;;
        --out) OUT_OVERRIDE="$2"; shift 2 ;;
        --min-score) MIN_SCORE="$2"; shift 2 ;;
        --dry-run) DRY_RUN="1"; shift ;;
        --no-notify) NO_NOTIFY="1"; shift ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0
            ;;
        *)
            echo "[ERROR] Unknown flag: $1" >&2
            exit 2
            ;;
    esac
done

# Validate DATE format
if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "[ERROR] Invalid date format: $DATE (expected YYYY-MM-DD)" >&2
    exit 2
fi

OUT_PDF="${OUT_OVERRIDE:-$HOME/Downloads/peer-brief-${DATE}.en.pdf}"
SYNTH_RECIPE="$WORK_DIR/peer-brief-${DATE}-synthesised.yaml"
TREND_YAML="$WORK_DIR/trend-${DATE}.yaml"
SYNTH_LOG="$WORK_DIR/synth-${DATE}.log"
SYNTH_STDERR="$WORK_DIR/synth-${DATE}.stderr"

echo "[START] peer-brief-render — $DATE" >&2
echo "[INFO] model=$MODEL  budget=\$$BUDGET  min-score=$MIN_SCORE" >&2
echo "[INFO] work=$WORK_DIR  out=$OUT_PDF" >&2

# ── Step 1: Resolve miner-daily ───────────────────────────────────────────
MINER_REPORT="$REPORTS_DIR/${DATE}-miner-daily.md"
if [ ! -f "$MINER_REPORT" ]; then
    echo "[ERROR] Miner-daily not found: $MINER_REPORT" >&2
    echo "[HINT] Check ls $REPORTS_DIR for the actual filename" >&2
    exit 4
fi
REPORT_LINES=$(wc -l < "$MINER_REPORT" | tr -d ' ')
echo "[STEP 1/5] miner-daily ✓ ($REPORT_LINES lines)" >&2

# ── Step 2: Extract signal-trend ──────────────────────────────────────────
echo "[STEP 2/5] extracting signal-trend..." >&2
if ! uv run "$TREND_HELPER" --as-of "$DATE" > "$TREND_YAML" 2> "$WORK_DIR/trend.err"; then
    echo "[ERROR] signal-trend extraction failed" >&2
    cat "$WORK_DIR/trend.err" >&2
    exit 4
fi
TREND_LINES=$(wc -l < "$TREND_YAML" | tr -d ' ')
echo "[STEP 2/5] signal-trend ✓ ($TREND_LINES lines)" >&2

# ── Step 3: Synthesise ────────────────────────────────────────────────────
echo "[STEP 3/5] synthesising via $MODEL (budget \$$BUDGET)..." >&2

# Heartbeat
_heartbeat() {
    local elapsed=0
    while true; do
        sleep 30
        elapsed=$((elapsed + 30))
        echo "[STATUS] synthesis working... (${elapsed}s)" >&2
    done
}
_heartbeat & HEARTBEAT_PID=$!
trap 'kill $HEARTBEAT_PID 2>/dev/null || true; echo "[INFO] work dir: $WORK_DIR" >&2' EXIT INT TERM

PROMPT="Synthesise today's peer-brief recipe.

DATE: $DATE
MINER-DAILY REPORT: $MINER_REPORT
CANONICAL RECIPE TEMPLATE: $CANONICAL_RECIPE
SIGNAL-TREND YAML (Figure 0 input, paste verbatim): $TREND_YAML
OUTPUT RECIPE PATH: $SYNTH_RECIPE

Read the canonical recipe to absorb section structure and prose voice.
Read today's miner-daily for findings, signal counts, and source material.
Read the trend YAML; embed verbatim under the signal-trend-area section.

Write the synthesised recipe to the output path. Apply stop-slop discipline.
Apply the six lessons (em-dash ban, text: not quote: for pull-quote, etc.).

When done, print the [SYNTH-DONE] line to stderr."

claude --agent "$SYNTH_AGENT" \
    -p "$PROMPT" \
    --allowedTools "Read(*),Write($SYNTH_RECIPE),Bash(wc*),Bash(head*),Bash(grep*),Glob(*),Grep(*)" \
    --max-budget-usd "$BUDGET" \
    --model "$MODEL" \
    --verbose \
    --output-format stream-json \
    > "$SYNTH_LOG" 2> "$SYNTH_STDERR" || true

kill $HEARTBEAT_PID 2>/dev/null || true
trap 'echo "[INFO] work dir: $WORK_DIR" >&2' EXIT

# Check for explicit failure marker
if grep -q '\[SYNTH-FAIL\]' "$SYNTH_STDERR"; then
    echo "[ERROR] Synthesis returned SYNTH-FAIL:" >&2
    grep '\[SYNTH-FAIL\]' "$SYNTH_STDERR" >&2
    exit 5
fi

# Check the recipe was actually written
if [ ! -s "$SYNTH_RECIPE" ]; then
    echo "[ERROR] Synthesis produced no recipe at $SYNTH_RECIPE" >&2
    echo "[HINT] last 20 lines of synth log:" >&2
    tail -20 "$SYNTH_LOG" >&2 || true
    echo "[HINT] last 20 lines of synth stderr:" >&2
    tail -20 "$SYNTH_STDERR" >&2 || true
    exit 5
fi

SYNTH_LINES=$(wc -l < "$SYNTH_RECIPE" | tr -d ' ')
echo "[STEP 3/5] synthesis ✓ ($SYNTH_LINES lines)" >&2

if grep -q '\[SYNTH-DONE\]' "$SYNTH_STDERR"; then
    grep '\[SYNTH-DONE\]\|\[SYNTH-SKIP\]' "$SYNTH_STDERR" >&2
fi

# ── Step 4: Stop-slop gate ────────────────────────────────────────────────
echo "[STEP 4/5] stop-slop gate (min $MIN_SCORE)..." >&2
SCAN_OUT="$WORK_DIR/stop-slop-${DATE}.json"
if ! uv run "$SCANNER" "$SYNTH_RECIPE" --min-score "$MIN_SCORE" > "$SCAN_OUT" 2>&1; then
    echo "[ERROR] stop-slop gate FAILED — recipe at $SYNTH_RECIPE" >&2
    echo "[HINT] inspect $SCAN_OUT for the breakdown" >&2
    # surface the score line
    grep '\[stop-slop' "$SCAN_OUT" >&2 || true
    exit 6
fi
SCORE=$(grep '\[stop-slop PASS\]' "$SCAN_OUT" | head -1 | sed -E 's/.*score=([0-9]+).*/\1/')
echo "[STEP 4/5] stop-slop ✓ (score $SCORE/50)" >&2

# ── Step 5: Render ────────────────────────────────────────────────────────
if [ -n "$DRY_RUN" ]; then
    echo "[DRY-RUN] skipping katib build" >&2
    echo "[DRY-RUN] recipe at: $SYNTH_RECIPE" >&2
    echo "[DONE] dry-run complete (no PDF)" >&2
    exit 0
fi

echo "[STEP 5/5] rendering PDF via katib..." >&2
KATIB_PROJECT_DIR="$HOME/dev/katib"
if [ ! -d "$KATIB_PROJECT_DIR" ]; then
    echo "[ERROR] katib project dir not found: $KATIB_PROJECT_DIR" >&2
    exit 7
fi
# katib's build.py needs to run from the project root for uv to resolve deps
# (ruamel.yaml etc.). --skip-audit-check because synth recipes are ephemeral
# and should not get audit-trail entries.
if ! (cd "$KATIB_PROJECT_DIR" && uv run scripts/build.py "$SYNTH_RECIPE" --lang en --brand jasem --out "$OUT_PDF" --skip-audit-check) > "$WORK_DIR/build.log" 2>&1; then
    echo "[ERROR] katib build FAILED" >&2
    tail -40 "$WORK_DIR/build.log" >&2 || true
    echo "[HINT] full build log: $WORK_DIR/build.log" >&2
    echo "[HINT] recipe: $SYNTH_RECIPE" >&2
    exit 7
fi

if [ ! -f "$OUT_PDF" ]; then
    echo "[ERROR] katib reported success but PDF missing: $OUT_PDF" >&2
    exit 7
fi

PDF_SIZE=$(du -h "$OUT_PDF" | cut -f1)
echo "[STEP 5/5] PDF rendered ✓ ($PDF_SIZE)" >&2

# ── Step 6: Telegram text alert (optional, fail-soft) ─────────────────────
# Just a one-line "it's ready" ping. NOT a document upload. The operator
# opens the PDF on their machine, where they review and forward anyway.
# Failure here is non-fatal: the PDF is still on disk.
if [ -n "$NO_NOTIFY" ]; then
    echo "[INFO] --no-notify: skipping Telegram alert" >&2
elif [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "$TG_CHAT_ID" ]; then
    echo "[WARN] TELEGRAM_BOT_TOKEN or chat_id not set, skipping alert" >&2
else
    PDF_NAME=$(basename "$OUT_PDF")
    SECTIONS=$(grep -cE "^  - component:" "$SYNTH_RECIPE" 2>/dev/null || echo "?")
    MSG="📄 Peer brief ready · $DATE
$PDF_NAME
$SECTIONS sections · score $SCORE/50 · $PDF_SIZE
Open ~/Downloads/ to review and forward."

    HTTP=$(curl -s -o /tmp/peer-brief-tg.out -w "%{http_code}" \
        -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "chat_id=${TG_CHAT_ID}" \
        --data-urlencode "text=${MSG}" \
        -d "disable_web_page_preview=true" \
        --max-time 15 2>/dev/null || echo "000")

    if [ "$HTTP" = "200" ]; then
        echo "[STEP 6/6] Telegram alert ✓" >&2
    else
        echo "[WARN] Telegram alert FAILED (http=$HTTP)" >&2
        echo "[WARN] response: $(cat /tmp/peer-brief-tg.out 2>/dev/null | head -c 200)" >&2
        echo "[WARN] PDF is still at $OUT_PDF (alert failure is non-fatal)" >&2
        # Exit 8 ONLY if we were explicitly trying to notify (not in --no-notify)
        # AND the PDF rendered fine. Operator gets the file via filesystem either way.
        echo "[DONE] $OUT_PDF (no notification)" >&2
        echo "$OUT_PDF"
        exit 8
    fi
fi

echo "[DONE] $OUT_PDF" >&2
echo "$OUT_PDF"
exit 0

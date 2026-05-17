#!/usr/bin/env bash
# scripts/soul-cli-uptake-check.sh — ADR-001 falsifier data collector.
#
# Scans Claude Code session JSONLs over the last N days (default 7) and counts:
#   - Total Bash tool invocations
#   - `soul ...` invocations (positive signal)
#   - Anti-patterns the CLI is meant to replace:
#       A1) Inline Python hitting the Soul Hub API
#       A2) Raw curl against /api/(vault|projects|crm|scheduler|intent)
#
# Surfaces counts + most-recent anti-pattern samples so the operator can see
# why the falsifier moved. Intended to be called from the scheduler weekly
# (planned: under soul-hub-hygiene). Standalone runnable today.
#
# Usage:
#   bash scripts/soul-cli-uptake-check.sh                 # last 7 days, pretty
#   bash scripts/soul-cli-uptake-check.sh 30              # last 30 days
#   bash scripts/soul-cli-uptake-check.sh 7 --json        # machine-readable
#
# Exit codes:
#   0  ran successfully (regardless of whether the falsifier is tripped)
#   1  dependency missing / Claude projects dir absent

set -uo pipefail   # NOTE: no `-e`. grep-no-match must not abort the script.

DAYS="${1:-7}"
JSON_OUT=0
for arg in "$@"; do
  case "$arg" in --json) JSON_OUT=1 ;; esac
done

CLAUDE_PROJECTS="${CLAUDE_PROJECTS:-$HOME/.claude/projects}"
[ -d "$CLAUDE_PROJECTS" ] || { echo "soul-cli-uptake: $CLAUDE_PROJECTS missing" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "soul-cli-uptake: jq required" >&2; exit 1; }

# Cutoff in milliseconds — Claude JSONL stores ISO timestamps; we convert.
if date -v -1d +%s >/dev/null 2>&1; then
  CUTOFF_MS=$(($(date -v -"${DAYS}"d +%s) * 1000))      # BSD / macOS
else
  CUTOFF_MS=$(($(date -d "$DAYS days ago" +%s) * 1000)) # GNU / Linux
fi

# Walk every JSONL under ~/.claude/projects/*/. Extract Bash tool_use commands
# inside the window. Output: <ts_ms>\t<command_one_line>
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

while IFS= read -r -d '' file; do
  jq -r --argjson cutoff "$CUTOFF_MS" '
    . as $r
    | select($r.type == "assistant" and ($r.message.content // null) != null)
    # jq fromdateiso8601 rejects millisecond precision (".327Z") — strip first.
    | (($r.timestamp | sub("\\.[0-9]+Z$"; "Z") | (try fromdateiso8601 catch 0)) * 1000) as $ms
    | select($ms >= $cutoff)
    | $r.message.content[]
    | select(.type == "tool_use" and .name == "Bash")
    | [($ms | tostring), (.input.command // "" | gsub("\n"; " ¶ "))]
    | @tsv
  ' "$file" 2>/dev/null
done < <(find "$CLAUDE_PROJECTS" -type f -name "*.jsonl" -print0) >> "$TMP"

TOTAL=$(wc -l < "$TMP" | tr -d ' ')
[ -z "$TOTAL" ] && TOTAL=0

# Regexes — ERE.
SOUL_RE='(^|[[:space:]]|/)soul([[:space:]]|$)'
ANTI1_RE='python3?[[:space:]]+-c.*localhost:2400/api/'                                        # inline python
ANTI2_RE='curl[^|]*localhost:2400/api/(vault|projects|crm|scheduler|intent)'                  # curl on covered routes
WRITE_RE='-X[[:space:]]+(POST|PUT|PATCH|DELETE)|--request[[:space:]]+(POST|PUT|PATCH|DELETE)' # phase-2 territory

count() {
  # $1 = regex. `grep -c` always prints a number; pipe-fail is fine without -e.
  awk -F'\t' '{print $2}' "$TMP" | grep -Ec "$1" 2>/dev/null
  return 0
}

# anti2 = curls on covered routes that are NOT writes (Phase 1 = reads only).
count_anti_curl() {
  awk -F'\t' '{print $2}' "$TMP" \
    | grep -E "$ANTI2_RE" 2>/dev/null \
    | grep -Ev -- "$WRITE_RE" 2>/dev/null \
    | wc -l | tr -d ' '
}

SOUL_COUNT=$(count "$SOUL_RE")
A1_COUNT=$(count "$ANTI1_RE")
A2_COUNT=$(count_anti_curl)
ANTI_COUNT=$((A1_COUNT + A2_COUNT))

# Most-recent anti-pattern samples for the operator (3 max, truncated).
# Excludes write-method curls (those map to Phase 2, not currently anti-).
SAMPLES=$(
  grep -E "($ANTI1_RE|$ANTI2_RE)" "$TMP" 2>/dev/null \
    | grep -Ev -- "$WRITE_RE" 2>/dev/null \
    | sort -r \
    | head -3 \
    | awk -F'\t' '{
        ts = int($1 / 1000);
        cmd = $2;
        if (length(cmd) > 110) cmd = substr(cmd, 1, 107) "...";
        printf "%s  (ts=%d)\n", cmd, ts;
      }' || true
)

# Falsifier from ADR-001: ≥ 5 anti-pattern hits / week on covered routes.
WEEKLY_RATE=$(awk -v a="$ANTI_COUNT" -v d="$DAYS" 'BEGIN{printf "%.1f", (d>0 ? a*7/d : 0)}')
TRIPPED=$(awk -v r="$WEEKLY_RATE" 'BEGIN{print (r >= 5 ? "yes" : "no")}')

if [ "$JSON_OUT" = "1" ]; then
  # Build JSON via jq -n for safe escaping.
  jq -n \
    --argjson days "$DAYS" \
    --argjson cutoffMs "$CUTOFF_MS" \
    --argjson total "$TOTAL" \
    --argjson soul "$SOUL_COUNT" \
    --argjson a1 "$A1_COUNT" \
    --argjson a2 "$A2_COUNT" \
    --argjson anti "$ANTI_COUNT" \
    --arg weeklyRate "$WEEKLY_RATE" \
    --arg tripped "$TRIPPED" \
    --arg samples "$SAMPLES" \
    '{
       windowDays: $days,
       cutoffMs: $cutoffMs,
       bashTotal: $total,
       soulCount: $soul,
       antiPython: $a1,
       antiCurl: $a2,
       antiTotal: $anti,
       weeklyAntiRate: ($weeklyRate | tonumber),
       falsifierTripped: ($tripped == "yes"),
       samples: ($samples | split("\n") | map(select(length > 0)))
     }'
  exit 0
fi

# Pretty output.
printf "soul-cli uptake — last %s day(s)\n" "$DAYS"
printf "─────────────────────────────────────\n"
printf "  Total Bash tool calls : %s\n" "$TOTAL"
printf "  soul invocations      : %s\n" "$SOUL_COUNT"
printf "  Anti-patterns         : %s  (python:%s  raw-curl:%s)\n" "$ANTI_COUNT" "$A1_COUNT" "$A2_COUNT"
printf "  Anti-rate / week      : %s   (ADR-001 falsifier threshold: 5.0)\n" "$WEEKLY_RATE"
printf "  Falsifier tripped     : %s\n" "$TRIPPED"

if [ -n "$SAMPLES" ]; then
  printf "\nRecent anti-pattern commands:\n"
  printf "%s\n" "$SAMPLES" | sed 's/^/  /'
fi

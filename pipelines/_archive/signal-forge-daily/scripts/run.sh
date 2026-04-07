#!/bin/bash
set -euo pipefail

# Signal Forge Daily — wrapper for Soul Hub pipeline runner
# Calls the existing pipeline.py with inputs from Soul Hub

SF_DIR="$HOME/dev/signal-forge"
SF_SCRIPTS="$SF_DIR/scripts"
OUTPUT="${PIPELINE_OUTPUT:-/tmp/signal-forge-daily-status.json}"

# Build args from Soul Hub inputs
ARGS=()

# Mode: quick
MODE="${PIPELINE_INPUT_0:-full}"
if [ "$MODE" = "quick" ]; then
    ARGS+=(--quick)
fi

# Resume from step
FROM="${PIPELINE_INPUT_1:-scout}"
if [ "$FROM" != "scout" ] && [ -n "$FROM" ]; then
    ARGS+=(--from "$FROM")
fi

echo "Signal Forge Daily Pipeline"
echo "Mode: $MODE | From: $FROM"
echo "---"

# Run the existing pipeline orchestrator
cd "$SF_SCRIPTS"
python3 pipeline.py "${ARGS[@]}" 2>&1

# Copy the status file as pipeline output
STATUS_FILE="$SF_SCRIPTS/pipeline-status.json"
if [ -f "$STATUS_FILE" ]; then
    mkdir -p "$(dirname "$OUTPUT")"
    cp "$STATUS_FILE" "$OUTPUT"
    echo "Status written to $OUTPUT"
else
    mkdir -p "$(dirname "$OUTPUT")"
    echo '{"status":"no_status_file","date":"'"$(date +%Y-%m-%d)"'"}' > "$OUTPUT"
    echo "Warning: pipeline-status.json not found"
fi

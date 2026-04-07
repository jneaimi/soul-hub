#!/bin/bash
set -euo pipefail

# Signal Forge Weekly — wrapper for Soul Hub pipeline runner
# Calls the existing weekly_pipeline.py with inputs from Soul Hub

SF_DIR="$HOME/dev/signal-forge"
SF_SCRIPTS="$SF_DIR/scripts"
OUTPUT="${PIPELINE_OUTPUT:-/tmp/signal-forge-weekly-status.json}"

# Build args from Soul Hub inputs
ARGS=()

# Skip strategist
SKIP="${PIPELINE_INPUT_0:-no}"
if [ "$SKIP" = "yes" ]; then
    ARGS+=(--skip strategist)
fi

echo "Signal Forge Weekly Pipeline"
echo "Skip strategist: $SKIP"
echo "---"

# Run the existing weekly pipeline orchestrator
cd "$SF_SCRIPTS"
python3 weekly_pipeline.py "${ARGS[@]}" 2>&1

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

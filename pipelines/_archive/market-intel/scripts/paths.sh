#!/bin/bash
# Shared path config for market-intel pipeline
# All scripts source this first

export MI_BASE="${PIPELINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MI_CONFIG="$MI_BASE/config"
export MI_DB="$MI_BASE/db/signals.db"
export MI_AGENTS="$MI_BASE/agents"
export MI_SCRIPTS="$MI_BASE/scripts"
export MI_OUTPUT="$HOME/SecondBrain/02-areas/pipelines/market-intel"
export MI_DATE="$(date +%Y-%m-%d)"

# Ensure output dir exists
mkdir -p "$MI_OUTPUT"
mkdir -p "$MI_OUTPUT/_prep"

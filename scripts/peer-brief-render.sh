#!/bin/bash
# Thin shim — orchestrator logic lives in peer-brief-render.py.
# Bash entry preserved so the scheduler task config stays untouched.
# See ~/vault/projects/soul-hub-whatsapp/adr-040-peer-brief-orchestrator-uv-python-port.md
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec uv run "$SCRIPT_DIR/peer-brief-render.py" "$@"

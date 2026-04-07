#!/bin/bash
# Guard: block file writes outside allowed builder destinations
# Allowed: catalog/scripts/*, catalog/agents/*, pipelines/*/
# Blocked: everything else (src/, node_modules/, .claude/, etc.)

# Read the tool input from stdin
INPUT=$(cat)

# Extract the file_path from the JSON input
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0  # No file path — not a write tool, allow
fi

# Resolve to absolute path
SOUL_HUB="$HOME/dev/soul-hub"
CATALOG_SCRIPTS="$SOUL_HUB/catalog/scripts"
CATALOG_AGENTS="$SOUL_HUB/catalog/agents"
PIPELINES="$SOUL_HUB/pipelines"

# Check if path is under allowed directories
case "$FILE_PATH" in
  "$CATALOG_SCRIPTS"/*) exit 0 ;;  # Script blocks
  "$CATALOG_AGENTS"/*)  exit 0 ;;  # Agent blocks
  "$PIPELINES"/*)       exit 0 ;;  # Pipelines + forks
  /tmp/*)               exit 0 ;;  # Temp files
esac

# Blocked
echo "BLOCKED: Builder can only write to catalog/scripts/*, catalog/agents/*, or pipelines/*. Attempted: $FILE_PATH"
exit 2

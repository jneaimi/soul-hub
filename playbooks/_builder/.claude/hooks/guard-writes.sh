#!/bin/bash
# Guard: block file writes outside allowed playbook destinations
# Allowed: playbooks/*, /tmp/*
# Blocked: everything else (src/, node_modules/, catalog/, etc.)

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

SOUL_HUB="$HOME/dev/soul-hub"
PLAYBOOKS="$SOUL_HUB/playbooks"

# Check if path is under allowed directories
ALLOWED=false
case "$FILE_PATH" in
  "$PLAYBOOKS"/*)          ALLOWED=true ;;
  /tmp/*)                  ALLOWED=true ;;
  */.claude/plan*)         ALLOWED=true ;;
  */PLAN.md)               ALLOWED=true ;;
  */.plan*)                ALLOWED=true ;;
esac

if [ "$ALLOWED" = "false" ]; then
  echo "BLOCKED: You cannot modify files outside playbooks/ ($FILE_PATH). Instead, create a fix request:"
  echo ""
  echo "Write a fix request to: playbooks/<playbook-name>/.fix-requests/<timestamp>.md"
  echo "Format:"
  echo "  ---"
  echo "  type: fix-request"
  echo "  file: <path to the file that needs fixing>"
  echo "  severity: blocking|warning"
  echo "  status: pending"
  echo "  ---"
  echo "  # Title"
  echo "  ## Bug (what's wrong)"
  echo "  ## Fix (diff or description)"
  echo "  ## Workaround (if any)"
  echo ""
  echo "The user will review and apply the fix outside the builder."
  exit 2
fi

# --- Content validation for allowed paths ---

BASENAME=$(basename "$FILE_PATH")
CONTENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('tool_input',{}).get('content',''); print(c)" 2>/dev/null)
# Ensure newlines are real (content may come with literal \n from JSON)
CONTENT=$(printf '%b' "$CONTENT")

# playbook.yaml must have roles:, phases:, and output: sections
if [ "$BASENAME" = "playbook.yaml" ] && [ -n "$CONTENT" ]; then
  if ! echo "$CONTENT" | grep -q 'roles:'; then
    echo "BLOCKED: playbook.yaml must contain a 'roles:' section"
    exit 2
  fi
  if ! echo "$CONTENT" | grep -q 'phases:'; then
    echo "BLOCKED: playbook.yaml must contain a 'phases:' section"
    exit 2
  fi
  if ! echo "$CONTENT" | grep -q 'output:'; then
    echo "BLOCKED: playbook.yaml must contain an 'output:' section"
    exit 2
  fi
fi

# Role .md files in roles/ should start with # (heading)
case "$FILE_PATH" in
  */roles/*.md)
    if [ -n "$CONTENT" ]; then
      FIRST_LINE=$(echo "$CONTENT" | head -1)
      if ! echo "$FIRST_LINE" | grep -q '^#'; then
        echo "BLOCKED: Role files in roles/ must start with a # heading"
        exit 2
      fi
    fi
    ;;
esac

# Config files in config/ must be .json not .md
case "$FILE_PATH" in
  */config/*.md)
    echo "BLOCKED: Config files must be .json, not .md"
    exit 2
    ;;
esac

exit 0

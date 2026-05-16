#!/bin/bash
# ADR-046 Pass 2 — Bash-side vault-write chokepoint.
# Closes the shell-out bypass the Pass 1 (Write/Edit/NotebookEdit) hook
# can't reach: `cat > ~/vault/X`, `tee ~/vault/X`, `cp ... ~/vault/X`,
# `sed -i ... ~/vault/X`, etc.
#
# Sibling of ~/.claude/hooks/vault-write-guard.sh — same fail-closed
# posture, same exempt subdirs, same operator message pointing at the
# /vault-write skill.
#
# Known limitations (acknowledged, deferred to the pre-commit backstop
# sibling ADR):
#   - Inline interpreter calls: python3 -c "open('~/vault/...').write(...)"
#   - Arbitrary child processes that the hook never sees
# These rare bypasses are why the deferred git pre-commit hook matters.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
[ -n "$COMMAND" ] || exit 0

# Pattern detection — done in python3 because bash regex doesn't have
# negative lookahead (needed for the exempt-subdir carve-out) and bash
# string handling around quotes is treacherous.
RESULT=$(python3 - "$COMMAND" <<'PYEOF'
import sys
import re

cmd = sys.argv[1]

# Vault path forms: ~/vault/, $HOME/vault/, ${HOME}/vault/, /Users/jneaimi/vault/
# Negative lookahead excludes the exempt subdirs (.vault/, .git/, .gitnexus/, .obsidian/).
# Used for the LITERAL patterns where we identify the exact write target.
VAULT_PATH = r'(?:~|\$HOME|\$\{HOME\}|/Users/jneaimi)/vault/(?!\.vault/|\.git/|\.gitnexus/|\.obsidian/)[^\s\'";|&]*'

# Permissive vault reference — matches `~/vault`, `~/vault/`, `~/vault/foo`, etc.
# Used for BROAD patterns (sed -i, perl -i) where the vault path might be elsewhere
# in the command (e.g., `find ~/vault | xargs sed -i ...`) and we just need to
# know that vault is in scope.
VAULT_REF = r'(?:~|\$HOME|\$\{HOME\}|/Users/jneaimi)/vault(?:/|\b)'

# Write-pattern catalog. Each tuple: (regex, human-readable label).
PATTERNS = [
    # Redirection — any command before, then > or >> with vault target
    (r'>{1,2}\s*[\'"]?' + VAULT_PATH, 'shell-redirect'),
    # tee (optionally with flags like -a) with vault as a target
    (r'\btee\b(?:\s+-[a-zA-Z]+)*\s+[\'"]?' + VAULT_PATH, 'tee'),
    # cp / mv / rsync / install with vault as a destination
    (r'\b(?:cp|mv|rsync|install)\b[^|;&\n]*?\s+[\'"]?' + VAULT_PATH + r'[\'"]?\s*(?:$|[|;&\n])', 'file-op'),
    # touch in vault (creates empty file)
    (r'\btouch\b(?:\s+-[a-zA-Z]+)*\s+[\'"]?' + VAULT_PATH, 'touch'),
]

# sed -i / perl -i are matched broadly: if -i is used AND any vault path
# appears in the command, treat as a write. Catches the xargs case
# (`find ~/vault | xargs sed -i ...`) the literal patterns above miss.
BROAD_PATTERNS = [
    (r'\bsed\b[^|;&\n]*\s-i\b', 'sed-in-place'),
    (r'\bperl\b[^|;&\n]*\s-i\b', 'perl-in-place'),
]

for pat, label in PATTERNS:
    if re.search(pat, cmd):
        print(f'match:{label}')
        sys.exit(0)

for pat, label in BROAD_PATTERNS:
    if re.search(pat, cmd) and re.search(VAULT_REF, cmd):
        print(f'match:{label}')
        sys.exit(0)

print('ok')
PYEOF
)

if [[ "$RESULT" == "ok" || -z "$RESULT" ]]; then
  exit 0
fi

PATTERN="${RESULT#match:}"

cat >&2 <<EOF
BLOCKED: Bash write to vault path is not allowed (ADR-046 Pass 2).

Pattern: $PATTERN
Command (truncated): ${COMMAND:0:200}

Shell-side writes ($PATTERN) targeting ~/vault/ bypass the vault API
and the chokepoint hook on Write/Edit/NotebookEdit. All AI-authored
vault content must go through the API so it gets frontmatter
validation, zone rules, rate-limiting, audit log, dedup, and atomic
commit.

→ Use the /vault-write skill instead:

   ~/.claude/skills/vault-write/scripts/vault-write.sh \\
     --zone "<zone>" \\
     --filename "<filename.md>" \\
     --meta-json '{"type":"...","created":"YYYY-MM-DD","tags":[...]}' \\
     --content "<body>"

For an update:
   vault-write.sh --update "<zone>/<filename.md>" \\
     --meta-json '{...}' --content "..."

Or call the API directly:
   POST http://localhost:2400/api/vault/notes
   PUT  http://localhost:2400/api/vault/notes/<path>

Exempt subdirs (hook passes these through): ~/vault/.vault/, .git/,
.gitnexus/, .obsidian/. If your write targets one of those, re-check
the literal path in the command.

See ~/claude-config/rules/vault.md and ADR-046 for the full rule.
EOF

exit 2

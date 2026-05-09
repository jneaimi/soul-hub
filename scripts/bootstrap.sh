#!/usr/bin/env bash
# Soul Hub bootstrap — Mac / Linux / WSL2 Ubuntu.
# Idempotent: safe to re-run. Does not overwrite existing config.

set -euo pipefail

# ── colors (only when TTY) ────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YLW=$(printf '\033[33m'); BLU=$(printf '\033[34m')
  RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi

step() { printf "%s==>%s %s\n" "$BLU$BOLD" "$RST" "$1"; }
ok()   { printf "  %s✓%s %s\n"   "$GRN" "$RST" "$1"; }
warn() { printf "  %s!%s %s\n"   "$YLW" "$RST" "$1"; }
err()  { printf "  %s✗%s %s\n"   "$RED" "$RST" "$1" >&2; }
die()  { err "$1"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SOUL_HUB_HOME="${SOUL_HUB_HOME:-$HOME/.soul-hub}"
VAULT_DIR_DEFAULT="$HOME/vault"
DEV_DIR_DEFAULT="$HOME/dev"

printf "%sSoul Hub bootstrap%s\n" "$BOLD" "$RST"
printf "%sRepo:%s %s\n" "$DIM" "$RST" "$REPO_ROOT"
printf "%sHome:%s %s\n\n" "$DIM" "$RST" "$SOUL_HUB_HOME"

# ── 1. Node ≥ 20 ──────────────────────────────────────────────────
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  die "node not found. Install Node 20+ from https://nodejs.org or via your package manager."
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $(node -v) is too old. Soul Hub needs Node 20+."
fi
ok "Node $(node -v)"

# ── 2. Claude CLI ─────────────────────────────────────────────────
step "Checking Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  CLAUDE_PATH=$(command -v claude)
  ok "claude → $CLAUDE_PATH"
else
  CLAUDE_PATH=""
  warn "claude not on PATH — install from https://docs.anthropic.com/en/docs/claude-code"
  warn "You can finish bootstrap now and configure paths.claudeBinary later."
fi

# ── 3. npm install ────────────────────────────────────────────────
step "Installing npm dependencies (this also rebuilds node-pty)"
npm install --no-audit --no-fund

# Verify node-pty actually loads (the postinstall swallows errors)
if ! node -e "require('node-pty')" 2>/dev/null; then
  err "node-pty failed to load after install."
  if [ "$(uname -s)" = "Darwin" ]; then
    err "Run: xcode-select --install   (then re-run this script)"
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    err "On WSL: sudo apt install -y build-essential python3"
  else
    err "On Linux: sudo apt install -y build-essential python3   (or your distro equivalent)"
  fi
  exit 1
fi
ok "node-pty loads"

# ── 4. ~/.soul-hub and ~/vault ────────────────────────────────────
step "Preparing user directories"
mkdir -p "$SOUL_HUB_HOME" "$SOUL_HUB_HOME/data" "$SOUL_HUB_HOME/logs"
ok "$SOUL_HUB_HOME"

if [ ! -d "$VAULT_DIR_DEFAULT" ]; then
  mkdir -p "$VAULT_DIR_DEFAULT"
  ok "$VAULT_DIR_DEFAULT (created)"
else
  ok "$VAULT_DIR_DEFAULT (already exists)"
fi

if [ ! -d "$DEV_DIR_DEFAULT" ]; then
  mkdir -p "$DEV_DIR_DEFAULT"
  ok "$DEV_DIR_DEFAULT (created)"
fi

# ── 5. settings.json ──────────────────────────────────────────────
step "Configuring settings.json"
SETTINGS_FILE="$SOUL_HUB_HOME/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  ok "$SETTINGS_FILE (already exists — left untouched)"
else
  # Substitute <REPO_ROOT> placeholder so seeded scheduler tasks (e.g.
  # vault-backup-daily) point at the correct on-disk repo location.
  # sed -i works portably on macOS + Linux with this in-place form.
  node - "$REPO_ROOT/settings.example.json" "$SETTINGS_FILE" "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const [, , src, dst, repoRoot] = process.argv;
const txt = fs.readFileSync(src, 'utf8').replace(/<REPO_ROOT>/g, repoRoot);
fs.writeFileSync(dst, txt);
NODE
  ok "Wrote $SETTINGS_FILE from settings.example.json"

  # Patch claudeBinary if we found one and it's not the default location
  if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_PATH" != "$HOME/.local/bin/claude" ]; then
    node - "$SETTINGS_FILE" "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');
const [, , file, p] = process.argv;
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
j.paths = j.paths || {};
j.paths.claudeBinary = p;
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
NODE
    ok "Patched paths.claudeBinary → $CLAUDE_PATH"
  fi
fi

# ── 6. ~/.soul-hub/.env with SOUL_HUB_SECRET ─────────────────────
step "Configuring secrets file"
ENV_FILE="$SOUL_HUB_HOME/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

if grep -q "^SOUL_HUB_SECRET=" "$ENV_FILE" 2>/dev/null; then
  ok "$ENV_FILE (SOUL_HUB_SECRET already set)"
else
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf "SOUL_HUB_SECRET=%s\n" "$SECRET" >> "$ENV_FILE"
  ok "Generated SOUL_HUB_SECRET in $ENV_FILE"
fi

# ── 7. ~/.claude/CLAUDE.md vault block ────────────────────────────
step "Wiring vault into ~/.claude/CLAUDE.md"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
mkdir -p "$CLAUDE_DIR"
[ -f "$CLAUDE_MD" ] || touch "$CLAUDE_MD"

ACTION=$(node - "$CLAUDE_MD" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const START = '<!-- soul-hub:start -->';
const END = '<!-- soul-hub:end -->';

const block = `${START}
## Soul Hub — Knowledge Context

Before non-trivial work (feature builds, debugging, architecture decisions),
check the vault for prior learnings via the Soul Hub vault API:

\`\`\`bash
# Full-text search (MiniSearch) over every note
curl -s "http://localhost:2400/api/vault/notes?q=your+topic&limit=5"

# Filter by project / type / tag
curl -s "http://localhost:2400/api/vault/notes?project=soul-hub&type=decision&limit=10"

# Note details (frontmatter, body, outgoing links)
curl -s "http://localhost:2400/api/vault/notes/<path>"

# Structural questions (graph, links, neighbors)
curl -s "http://localhost:2400/api/vault/graph?node=<path>"
\`\`\`

**When to check:** before debugging (someone may have hit it before), before
architecture decisions (an ADR may exist), before building features in Soul Hub
or your projects (project-specific patterns may already be documented).

**When to skip:** quick questions, recipe searches, media generation, or when
the user says to skip. Also skip if Soul Hub isn't running on \`:2400\` — the
API needs the server up.
${END}`;

const txt = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const s = txt.indexOf(START);
const e = txt.indexOf(END);

let next, action;
if (s !== -1 && e !== -1 && e > s) {
  next = txt.slice(0, s) + block + txt.slice(e + END.length);
  action = next === txt ? 'unchanged' : 'updated';
} else {
  const sep = txt.length === 0 ? '' : (txt.endsWith('\n\n') ? '' : (txt.endsWith('\n') ? '\n' : '\n\n'));
  next = txt + sep + block + '\n';
  action = 'added';
}

if (next !== txt) fs.writeFileSync(file, next);
process.stdout.write(action);
NODE
)

case "$ACTION" in
  added)     ok "$CLAUDE_MD (soul-hub block added)" ;;
  updated)   ok "$CLAUDE_MD (soul-hub block updated)" ;;
  unchanged) ok "$CLAUDE_MD (soul-hub block already current)" ;;
  *)         warn "Could not patch $CLAUDE_MD (action: ${ACTION:-unknown})" ;;
esac

# ── 8. Vault git history (ADR-019) ───────────────────────────────
step "Initializing vault git repo"
if [ -d "$VAULT_DIR_DEFAULT/.git" ]; then
  ok "$VAULT_DIR_DEFAULT/.git (already initialized)"
else
  # Write .gitignore first — six rules cover the whole vault.
  cat > "$VAULT_DIR_DEFAULT/.gitignore" <<'GITIGNORE'
# Soul Hub vault metadata — regenerated, machine-local
.vault/mtime-cache.json

# macOS noise
.DS_Store
**/.DS_Store

# Vault trash zone — already-deleted notes
.trash/

# Retired Obsidian workspace (defensive — kept ignored in case of re-install)
.obsidian/

# SQLite runtime artifacts (write-active DBs in project subfolders)
*.db
*.db-wal
*.db-shm
GITIGNORE

  git -C "$VAULT_DIR_DEFAULT" init -b main >/dev/null 2>&1 || \
    git -C "$VAULT_DIR_DEFAULT" init >/dev/null

  # Mirror global git identity into the vault repo if available, so the
  # initial commit (and event-driven commits from src/lib/vault/committer.ts)
  # don't fail with "please tell me who you are".
  GLOBAL_NAME=$(git config --global --get user.name 2>/dev/null || true)
  GLOBAL_EMAIL=$(git config --global --get user.email 2>/dev/null || true)

  if [ -n "$GLOBAL_NAME" ] && [ -n "$GLOBAL_EMAIL" ]; then
    git -C "$VAULT_DIR_DEFAULT" config user.name "$GLOBAL_NAME"
    git -C "$VAULT_DIR_DEFAULT" config user.email "$GLOBAL_EMAIL"
    git -C "$VAULT_DIR_DEFAULT" add -A
    if ! git -C "$VAULT_DIR_DEFAULT" diff --cached --quiet ; then
      git -C "$VAULT_DIR_DEFAULT" commit -m "vault: initial commit" >/dev/null
      ok "$VAULT_DIR_DEFAULT/.git (initialized + initial commit)"
    else
      ok "$VAULT_DIR_DEFAULT/.git (initialized — empty vault, no initial commit)"
    fi
  else
    warn "$VAULT_DIR_DEFAULT/.git initialized but global git identity is unset"
    warn "Set: git config --global user.name '...' && git config --global user.email '...'"
    warn "Then re-run this script — the initial commit will be created."
  fi
fi

# ── 9. Final summary ─────────────────────────────────────────────
echo
printf "%sBootstrap complete.%s\n\n" "$GRN$BOLD" "$RST"
printf "Next steps:\n"
printf "  %sDev mode:%s         npm run dev          (http://localhost:5173)\n" "$BOLD" "$RST"
printf "  %sProduction mode:%s  npm run build && npm run prod:start  (http://localhost:2400)\n" "$BOLD" "$RST"
printf "  %sHealth check:%s     npm run doctor\n\n" "$BOLD" "$RST"

if [ -z "$CLAUDE_PATH" ]; then
  printf "%sReminder:%s install Claude Code CLI, then run %snpm run doctor%s to verify.\n\n" "$YLW" "$RST" "$BOLD" "$RST"
fi

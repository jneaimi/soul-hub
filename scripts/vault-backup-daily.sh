#!/usr/bin/env bash
# Daily vault git snapshot — invoked by Soul Hub scheduler task
# `vault-backup-daily` per ADR-019. Safety-net layer below the
# event-driven commits in src/lib/vault/committer.ts.
#
# Stages everything, commits with a dated message, exits 0 on no-op.
# Reads VAULT_DIR from env (set by scheduler) or falls back to ~/vault.

set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$HOME/vault}"

if [ ! -d "$VAULT_DIR/.git" ]; then
  echo "[vault-backup-daily] $VAULT_DIR is not a git repo — run: bash scripts/bootstrap.sh" >&2
  exit 1
fi

git -C "$VAULT_DIR" add -A

if git -C "$VAULT_DIR" diff --cached --quiet ; then
  echo "[vault-backup-daily] no changes to commit (event-driven commits already covered today)"
  exit 0
fi

DATE_STAMP="$(date +%Y-%m-%d)"
STAGED_COUNT="$(git -C "$VAULT_DIR" diff --cached --name-only | wc -l | tr -d ' ')"

git -C "$VAULT_DIR" commit -m "vault: daily snapshot ${DATE_STAMP} (${STAGED_COUNT} files)"
echo "[vault-backup-daily] committed ${STAGED_COUNT} files"

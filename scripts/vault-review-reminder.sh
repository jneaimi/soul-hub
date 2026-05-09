#!/usr/bin/env bash
# One-shot Telegram reminder + self-disable, invoked by Soul Hub scheduler.
#
# Designed for low-touch reminders that point the user at a vault file and
# then take themselves out of the rotation so they don't fire again next
# year on the same date (which is what a plain cron would do).
#
# Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Required env: REMINDER_TASK_ID (the scheduler task id to auto-disable)
# Required env: REMINDER_MESSAGE (the text body to send)

set -euo pipefail

# Pull Telegram credentials from the user's shell rc if not already in env
# (PM2 inherits env from launch shell, but be defensive in case it didn't).
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  eval "$(grep -E '^export (TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)=' "$HOME/.zshrc" 2>/dev/null || true)"
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "[vault-review-reminder] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" >&2
  exit 1
fi

if [ -z "${REMINDER_TASK_ID:-}" ] || [ -z "${REMINDER_MESSAGE:-}" ]; then
  echo "[vault-review-reminder] missing REMINDER_TASK_ID or REMINDER_MESSAGE" >&2
  exit 1
fi

# 1. Send the Telegram message
RESPONSE=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${REMINDER_MESSAGE}")

if ! echo "$RESPONSE" | grep -q '"ok":true' ; then
  echo "[vault-review-reminder] Telegram API error: $RESPONSE" >&2
  exit 1
fi

# 2. Disable this task in settings.json so it doesn't fire again next year
SETTINGS="$HOME/.soul-hub/settings.json"
if [ ! -f "$SETTINGS" ]; then
  echo "[vault-review-reminder] $SETTINGS not found — skipping self-disable" >&2
  exit 0
fi

TMP="$(mktemp)"
jq --arg id "$REMINDER_TASK_ID" \
  '(.scheduler.tasks[] | select(.id == $id) | .enabled) = false' \
  "$SETTINGS" > "$TMP"
mv "$TMP" "$SETTINGS"

# 3. Hot-reload the running scheduler so the disable takes effect immediately
curl -sS -X POST http://localhost:2400/api/settings \
  -H 'Content-Type: application/json' \
  -d "$(cat "$SETTINGS")" > /dev/null 2>&1 || true

echo "[vault-review-reminder] sent + disabled task '${REMINDER_TASK_ID}'"

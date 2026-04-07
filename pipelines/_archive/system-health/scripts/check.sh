#!/bin/bash
set -euo pipefail

OUTPUT="${PIPELINE_OUTPUT:-/dev/stdout}"

HOSTNAME=$(hostname)
DATE=$(date '+%Y-%m-%d %H:%M:%S')
UPTIME=$(uptime | sed 's/.*up /up /' | sed 's/,  *[0-9]* user.*//')
DISK=$(df -h / | awk 'NR==2 {printf "%s used of %s (%s)", $3, $2, $5}')
MEM=$(vm_stat | awk '
  /Pages free/     { free=$3 }
  /Pages active/   { active=$3 }
  /Pages inactive/ { inactive=$3 }
  /Pages wired/    { wired=$4 }
  END {
    gsub(/\./, "", free); gsub(/\./, "", active);
    gsub(/\./, "", inactive); gsub(/\./, "", wired);
    used = (active + wired) * 4096 / 1073741824;
    total = (free + active + inactive + wired) * 4096 / 1073741824;
    printf "%.1fG used of %.1fG", used, total;
  }
')

REPORT="System Health - ${HOSTNAME}
${DATE}

Uptime: ${UPTIME}
Disk (/): ${DISK}
Memory: ${MEM}"

mkdir -p "$(dirname "$OUTPUT")"
echo "$REPORT" > "$OUTPUT"
echo "$REPORT"

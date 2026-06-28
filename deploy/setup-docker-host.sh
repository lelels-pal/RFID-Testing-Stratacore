#!/usr/bin/env bash
# One-time host setup for Docker Compose deployment on Xubuntu
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"

echo "=== Stratacore Docker host setup ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine + Compose plugin first."
  exit 1
fi

if [ ! -f "$DEPLOY/.env.docker" ]; then
  cp "$DEPLOY/env.docker.example" "$DEPLOY/.env.docker"
  echo "Created $DEPLOY/.env.docker — edit Maya keys and secrets before starting."
fi

if [ ! -f "$ROOT/rfids.seed.json" ]; then
  cp "$ROOT/apps/backend/rfids.json.example" "$ROOT/rfids.seed.json"
fi

mkdir -p "$ROOT/deploy/logs"

CRON_LINE="*/5 * * * * cd $ROOT && /usr/bin/node tools/watchdog/service-watchdog.js >> deploy/logs/watchdog.log 2>&1"
( crontab -l 2>/dev/null | grep -F "service-watchdog.js" ) || {
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
  echo "Installed host cron for service-watchdog.js (every 5 minutes)."
}

echo ""
echo "Next steps:"
echo "  1. Edit deploy/.env.docker (Maya keys, ADMIN_PASSWORD, JWT_SECRET, CHARGERS_JSON)"
echo "  2. Add /etc/hosts entries for api/admin/guest/ocpp.stratacore.tech → this machine's LAN IP"
echo "  3. cd deploy && docker compose up -d --build"
echo "  4. bash deploy/health-check.sh"

#!/usr/bin/env bash
# Quick health check — run on the Xubuntu server after deployment
set -euo pipefail

API_BASE="${API_BASE:-http://api.stratacore.tech}"

echo "=== Docker services ==="
if command -v docker >/dev/null 2>&1; then
  docker compose -f "$(dirname "$0")/docker-compose.yml" ps || true
fi

echo ""
echo "=== API health ==="
curl -sf "$API_BASE/api/health" && echo || echo "API health check FAILED"

echo ""
echo "=== Watchdog status (requires ADMIN_TOKEN env) ==="
if [ -n "${ADMIN_TOKEN:-}" ]; then
  curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/watchdog" | jq '.active, .staleSessionMonitor, .healthMonitor.active' || echo "Watchdog check FAILED"
else
  echo "Set ADMIN_TOKEN to check /api/watchdog"
fi

echo ""
echo "=== Web apps ==="
curl -sf -o /dev/null -w "admin: %{http_code}\n" http://admin.stratacore.tech || true
curl -sf -o /dev/null -w "guest: %{http_code}\n" http://guest.stratacore.tech || true

echo ""
echo "=== OCPP proxy ==="
curl -sf -o /dev/null -w "ocpp subdomain: %{http_code}\n" http://ocpp.stratacore.tech || echo "ocpp check skipped"

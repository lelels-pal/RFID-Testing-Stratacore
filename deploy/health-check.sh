#!/usr/bin/env bash
# Quick health check — run on the Xubuntu server after deployment
set -euo pipefail

echo "=== Service status ==="
systemctl is-active stratacore-backend stratacore-kiosk stratacore-guest-app caddy || true

echo ""
echo "=== Listening ports ==="
ss -tlnp | grep -E ':4001|:3001|:3002|:443|:9000' || true

echo ""
echo "=== API health ==="
curl -sf https://api.stratacore.tech/api/health && echo || echo "API health check FAILED"

echo ""
echo "=== Web apps ==="
curl -sf -o /dev/null -w "admin: %{http_code}\n" http://admin.stratacore.tech
curl -sf -o /dev/null -w "guest: %{http_code}\n" https://guest.stratacore.tech

echo ""
echo "=== OCPP proxy (443) ==="
curl -sf -o /dev/null -w "ocpp subdomain: %{http_code}\n" https://ocpp.stratacore.tech || echo "ocpp check skipped (WS endpoint may not return HTTP 200)"

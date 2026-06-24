#!/usr/bin/env bash
# Stratacore LOCAL / LAN setup for Xubuntu — no public DNS or port forwarding.
#
# What this does:
#   - Installs Node, Caddy, builds the apps
#   - Points stratacore.tech subdomains to this machine's LAN IP (/etc/hosts)
#   - Uses HTTP on port 80 only (works with chargers that don't trust self-signed TLS)
#   - Starts systemd services + Caddy
#
# Run: sudo bash deploy/setup-xubuntu-local.sh
#
# For phones/chargers on the same Wi‑Fi to resolve the domain, either:
#   A) Set your router's DNS to this machine's IP and run dnsmasq (see deploy/dnsmasq-local.conf)
#   B) Add the same hosts entries on each device (fine for a fixed kiosk PC)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/stratacore}"
APP_USER="${APP_USER:-stratacore}"
NODE_MAJOR="${NODE_MAJOR:-20}"

# Detect LAN IP (first non-loopback IPv4)
LAN_IP="$(hostname -I | awk '{print $1}')"

echo "==> Stratacore LOCAL setup (LAN only)"
echo "    Repo:   $REPO_DIR"
echo "    LAN IP: $LAN_IP"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup-xubuntu-local.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl git ca-certificates gnupg

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.version.slice(1).split('.')[0]")" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if ! id "$APP_USER" &>/dev/null; then
  useradd --system --home-dir /var/lib/stratacore --shell /usr/sbin/nologin "$APP_USER"
fi

if [[ ! -f "$REPO_DIR/package.json" ]]; then
  echo "ERROR: Clone the repo to $REPO_DIR first."
  exit 1
fi

chown -R "$APP_USER:$APP_USER" "$REPO_DIR"
cd "$REPO_DIR"

missing=0
[[ -f apps/backend/.env ]]       || { echo "MISSING: apps/backend/.env"; missing=1; }
[[ -f apps/kiosk/.env.local ]]     || { echo "MISSING: apps/kiosk/.env.local"; missing=1; }
[[ -f apps/guest-app/.env.local ]] || { echo "MISSING: apps/guest-app/.env.local"; missing=1; }
if [[ "$missing" -eq 1 ]]; then
  echo "Create env files using deploy/env.local.example, then re-run."
  exit 1
fi

sudo -u "$APP_USER" npm install
sudo -u "$APP_USER" npm run build

# --- Local hosts: domain → this machine ---
HOSTS=/etc/hosts
if ! grep -q 'api.stratacore.tech' "$HOSTS"; then
  cat >> "$HOSTS" <<EOF

# stratacore.tech LAN routing (local-only, no public DNS)
$LAN_IP api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
EOF
  echo "Added stratacore.tech → $LAN_IP to /etc/hosts"
else
  echo "Hosts file already has stratacore.tech entries."
fi

cp deploy/systemd/stratacore-backend.service   /etc/systemd/system/
cp deploy/systemd/stratacore-kiosk.service     /etc/systemd/system/
cp deploy/systemd/stratacore-guest-app.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable stratacore-backend stratacore-kiosk stratacore-guest-app

cp deploy/Caddyfile.local-http /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

systemctl restart stratacore-backend
sleep 3
systemctl restart stratacore-kiosk stratacore-guest-app

echo ""
echo "==> Local Stratacore is running"
echo ""
echo "  Admin:  http://admin.stratacore.tech"
echo "  Guest:  http://guest.stratacore.tech"
echo "  API:    http://api.stratacore.tech/api/health"
echo "  OCPP:   ws://ocpp.stratacore.tech/ocpp/<chargerId>"
echo ""
echo "  Server LAN IP: $LAN_IP"
echo ""
echo "Other devices on the same network (phones, chargers) must also resolve"
echo "stratacore.tech to $LAN_IP — use router DNS or deploy/dnsmasq-local.conf"
echo ""
echo "Test: curl -s http://api.stratacore.tech/api/health"

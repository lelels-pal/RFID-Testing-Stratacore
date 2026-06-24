#!/usr/bin/env bash
# Stratacore production setup for Xubuntu / Ubuntu LTS
# Run as root: sudo bash deploy/setup-xubuntu.sh
#
# Prerequisites:
#   - DNS A records for api/admin/guest/ocpp.stratacore.tech → this machine's public IP
#   - Repo cloned to /opt/stratacore (or set REPO_DIR below)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/stratacore}"
APP_USER="${APP_USER:-stratacore}"
NODE_MAJOR="${NODE_MAJOR:-20}"

echo "==> Stratacore Xubuntu setup"
echo "    Repo:  $REPO_DIR"
echo "    User:  $APP_USER"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup-xubuntu.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system packages"
apt-get update
apt-get install -y curl git ca-certificates gnupg ufw

echo "==> Installing Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.version.slice(1).split('.')[0]")" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "    Node $(node -v), npm $(npm -v)"

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
echo "    Caddy $(caddy version | head -1)"

echo "==> Creating app user"
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --home-dir /var/lib/stratacore --shell /usr/sbin/nologin "$APP_USER"
fi
chown -R "$APP_USER:$APP_USER" "$REPO_DIR"

if [[ ! -d "$REPO_DIR/.git" ]] && [[ ! -f "$REPO_DIR/package.json" ]]; then
  echo "ERROR: Clone the repo to $REPO_DIR first, then re-run this script."
  echo "  sudo git clone <your-repo-url> $REPO_DIR"
  exit 1
fi

echo "==> Installing npm dependencies"
cd "$REPO_DIR"
sudo -u "$APP_USER" npm install

echo "==> Checking env files"
missing=0
[[ -f "$REPO_DIR/apps/backend/.env" ]]       || { echo "  MISSING: apps/backend/.env"; missing=1; }
[[ -f "$REPO_DIR/apps/kiosk/.env.local" ]]     || { echo "  MISSING: apps/kiosk/.env.local"; missing=1; }
[[ -f "$REPO_DIR/apps/guest-app/.env.local" ]] || { echo "  MISSING: apps/guest-app/.env.local"; missing=1; }
if [[ "$missing" -eq 1 ]]; then
  echo ""
  echo "Create env files from deploy/env.production.example, then re-run."
  exit 1
fi

echo "==> Building apps"
sudo -u "$APP_USER" npm run build

echo "==> Installing systemd services"
cp "$REPO_DIR/deploy/systemd/stratacore-backend.service"    /etc/systemd/system/
cp "$REPO_DIR/deploy/systemd/stratacore-kiosk.service"      /etc/systemd/system/
cp "$REPO_DIR/deploy/systemd/stratacore-guest-app.service"  /etc/systemd/system/
systemctl daemon-reload
systemctl enable stratacore-backend stratacore-kiosk stratacore-guest-app

echo "==> Configuring Caddy"
cp "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo "==> Configuring firewall (UFW)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Starting Stratacore services"
systemctl restart stratacore-backend
sleep 3
systemctl restart stratacore-kiosk stratacore-guest-app

echo ""
echo "==> Done!"
echo "    API:    https://api.stratacore.tech/api/health"
echo "    Admin:  https://admin.stratacore.tech"
echo "    Guest:  https://guest.stratacore.tech"
echo "    OCPP:   wss://ocpp.stratacore.tech/ocpp/<chargerId>"
echo ""
echo "Logs:"
echo "    journalctl -u stratacore-backend -f"
echo "    journalctl -u stratacore-kiosk -f"
echo "    journalctl -u stratacore-guest-app -f"
echo "    journalctl -u caddy -f"

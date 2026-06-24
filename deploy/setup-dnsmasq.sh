#!/usr/bin/env bash
# Install/start Stratacore dnsmasq on Xubuntu/Ubuntu — same config as Windows Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Stratacore dnsmasq setup (Linux)"

LAN_IP="$(hostname -I | awk '{print $1}')"
if [[ -z "$LAN_IP" ]]; then
  echo "Could not detect LAN IP." >&2
  exit 1
fi

DNSMASQ_DIR="$ROOT/deploy/dnsmasq"
mkdir -p "$DNSMASQ_DIR"

cat > "$DNSMASQ_DIR/stratacore.conf" <<EOF
# Generated $(date -Iseconds) — LAN IP: $LAN_IP
address=/stratacore.tech/$LAN_IP
address=/api.stratacore.tech/$LAN_IP
address=/admin.stratacore.tech/$LAN_IP
address=/guest.stratacore.tech/$LAN_IP
address=/ocpp.stratacore.tech/$LAN_IP
EOF

cp "$DNSMASQ_DIR/stratacore.conf" "$ROOT/deploy/dnsmasq-local.conf"

echo "Generated deploy/dnsmasq/stratacore.conf for $LAN_IP"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Re-run with sudo: sudo bash deploy/setup-dnsmasq.sh"
  exit 1
fi

# systemd-resolved often holds port 53 on Ubuntu — free it for dnsmasq
if systemctl is-active systemd-resolved &>/dev/null; then
  echo "==> Configuring systemd-resolved to avoid port 53 conflict"
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/stratacore-dnsmasq.conf <<'RESOLVED'
[Resolve]
DNS=127.0.0.1
FallbackDNS=8.8.8.8 1.1.1.1
DNSStubListener=no
RESOLVED
  systemctl restart systemd-resolved
fi

echo "==> Installing dnsmasq"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y dnsmasq

cp "$DNSMASQ_DIR/stratacore.conf" /etc/dnsmasq.d/stratacore.conf

# Forward non-stratacore queries upstream
if ! grep -q '^server=' /etc/dnsmasq.d/stratacore.conf 2>/dev/null; then
  cat >> /etc/dnsmasq.conf <<'UPSTREAM'

# Stratacore: upstream DNS for non-local names
server=8.8.8.8
server=1.1.1.1
UPSTREAM
fi

systemctl enable dnsmasq
systemctl restart dnsmasq

if command -v ufw &>/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 53/tcp
  ufw allow 53/udp
fi

echo ""
echo "dnsmasq is running on $LAN_IP"
echo ""
echo "FINAL STEP — set router DHCP DNS to: $LAN_IP"
echo ""
echo "Verify: dig +short admin.stratacore.tech @$LAN_IP"

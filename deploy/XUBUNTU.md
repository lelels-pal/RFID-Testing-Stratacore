# Stratacore — Xubuntu Deployment Guide

Deploy the Stratacore kiosk system on **Xubuntu LTS** (or Ubuntu LTS) for on-prem use. This guide targets a local LAN deployment: you use `stratacore.tech` domain names instead of `localhost`, but **nothing is exposed to the public internet**.

Tested target hardware: Intel i3, 8 GB RAM, 128 GB SSD — more than sufficient for this stack.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [What you need](#what-you-need)
4. [Quick start (local LAN)](#quick-start-local-lan)
5. [Environment files](#environment-files)
6. [Making the domain work on your network](#making-the-domain-work-on-your-network)
7. [HTTP vs HTTPS on LAN](#http-vs-https-on-lan)
8. [Verify the deployment](#verify-the-deployment)
9. [Configure the charger](#configure-the-charger)
10. [Day-to-day operations](#day-to-day-operations)
11. [Updating the app](#updating-the-app)
12. [Troubleshooting](#troubleshooting)
13. [Customizing subdomains](#customizing-subdomains)
14. [Optional: public internet deployment](#optional-public-internet-deployment)
15. [Deploy file reference](#deploy-file-reference)

---

## Overview

Instead of:

```
http://localhost:4001   → backend
http://localhost:3001   → kiosk
http://localhost:3002   → guest app
ws://localhost:9000     → OCPP
```

You run:

```
http://api.stratacore.tech    → backend
http://admin.stratacore.tech  → kiosk admin
http://guest.stratacore.tech  → guest mobile app
ws://ocpp.stratacore.tech     → charger WebSocket
```

**Local LAN deployment does not require:**

- Public DNS records at your domain registrar
- Port forwarding on your router
- Let's Encrypt or other public SSL certificates

**It does require:**

- Devices on your network resolve `*.stratacore.tech` to the server's **LAN IP** (e.g. `192.168.1.50`)
- Caddy as a reverse proxy on the server
- Node.js 18+ to run the apps

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Xubuntu server (e.g. 192.168.1.50)                         │
│                                                             │
│  Caddy :80  ──►  admin.stratacore.tech  ──►  Next.js :3001 │
│              ──►  guest.stratacore.tech ──►  Next.js :3002 │
│              ──►  api.stratacore.tech   ──►  NestJS  :4001 │
│              ──►  ocpp.stratacore.tech  ──►  OCPP WS :9000 │
└─────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲
         │              │              │
    Kiosk PC       Guest phones     EV charger
    (browser)      (QR scan)        (OCPP)
```

| Service | systemd unit | Internal port |
|---------|--------------|---------------|
| Backend API + Socket.IO + OCPP | `stratacore-backend` | 4001 / 9000 |
| Kiosk admin | `stratacore-kiosk` | 3001 |
| Guest mobile app | `stratacore-guest-app` | 3002 |
| Reverse proxy | `caddy` | 80 (and 443 if using HTTPS) |

Only port **80** (or **443** for HTTPS) needs to be reachable on the LAN. App ports stay internal.

---

## What you need

| Item | Notes |
|------|-------|
| Xubuntu / Ubuntu LTS | 22.04 or 24.04 recommended |
| Static LAN IP | Reserve one in your router DHCP settings |
| Git access to this repo | Clone to `/opt/stratacore` |
| Root/sudo access | Required for install script |
| ~2 GB free RAM | Typical usage is 1–2 GB total |
| Optional 2 GB swap | Recommended on 8 GB machines |

No external database is required — the backend uses an in-memory store.

---

## Quick start (local LAN)

### 1. Prepare the server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl
```

Give the machine a **fixed LAN IP** in your router (e.g. `192.168.1.50`).

### 2. Clone the repository

```bash
sudo mkdir -p /opt/stratacore
sudo git clone <YOUR_REPO_URL> /opt/stratacore
cd /opt/stratacore
```

### 3. Create environment files

Copy values from `deploy/env.local.example`:

```bash
sudo nano apps/backend/.env
sudo nano apps/kiosk/.env.local
sudo nano apps/guest-app/.env.local
```

Generate secrets:

```bash
openssl rand -hex 32
```

See [Environment files](#environment-files) below for required values.

### 4. Run the installer

```bash
sudo chmod +x deploy/setup-xubuntu-local.sh deploy/health-check.sh
sudo bash deploy/setup-xubuntu-local.sh
```

The script will:

1. Install Node.js 20 and Caddy
2. Run `npm install` and `npm run build`
3. Add `stratacore.tech` entries to `/etc/hosts` on this server
4. Install and enable systemd services
5. Configure Caddy with `deploy/Caddyfile.local-http`
6. Start everything

### 5. Verify

```bash
sudo bash deploy/health-check.sh
curl -s http://api.stratacore.tech/api/health
```

Open in a browser on the server:

- http://admin.stratacore.tech
- http://guest.stratacore.tech

---

## Environment files

Use **`http://`** URLs for the default local HTTP setup.

### `apps/backend/.env`

```env
PORT=4001
OCPP_WS_PORT=9000
OCPP_WS_PATH=/ocpp
PRICE_PER_KWH=15
JWT_SECRET=<openssl rand -hex 32>
PAYNAMICS_WEBHOOK_SECRET=<openssl rand -hex 32>
PAYNAMICS_CHECKOUT_URL=https://www.paynamics.net/webpaymentservice/checkout
GUEST_APP_URL=http://guest.stratacore.tech
CORS_ALLOWED_ORIGINS=http://admin.stratacore.tech,http://guest.stratacore.tech

CHARGE_START_TIMEOUT_MS=60000
STALE_SESSION_THRESHOLD_MINUTES=10
STALE_SESSION_CHECK_INTERVAL_SECONDS=60
STALE_SESSION_MAX_RECOVERY_PER_CYCLE=10
STALE_SESSION_AUTOSTART=1
WATCHDOG_AUTOSTART=0
HEALTH_MONITOR_AUTOSTART=1
```

### `apps/kiosk/.env.local`

```env
NEXT_PUBLIC_BACKEND_URL=http://api.stratacore.tech
NEXT_PUBLIC_KIOSK_USERNAME=admin
NEXT_PUBLIC_KIOSK_PASSWORD=<strong-password>
NEXT_PUBLIC_STATION_NAME=Charging Station
NEXT_PUBLIC_STATION_LOCATION=
NEXT_PUBLIC_CHARGERS=[{"chargerId":"DELTA123","connectorId":1,"chargerIp":"192.168.137.51"}]
```

### `apps/guest-app/.env.local`

```env
NEXT_PUBLIC_BACKEND_URL=http://api.stratacore.tech
```

> **Important:** `NEXT_PUBLIC_*` values are baked in at build time. After changing them, run `npm run build` and restart the frontend services.

Full template: `deploy/env.local.example`

---

## Making the domain work on your network

The server resolves the domain via `/etc/hosts` (added automatically by the setup script). **Other devices** on the same network also need to resolve `stratacore.tech` to the server IP.

Replace `192.168.1.50` with your server's actual LAN IP.

### Option A — Hosts file (per device)

Add to `/etc/hosts` on Linux/macOS, or `C:\Windows\System32\drivers\etc\hosts` on Windows:

```
192.168.1.50  api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
```

**Good for:** the server itself, a dedicated kiosk PC.  
**Not ideal for:** phones (guest QR scans) or chargers.

### Option B — Corporate IT internal DNS (recommended for large companies)

**Do not change office router DHCP.** Ask IT to add **internal A records** on the corporate DNS server:

```
admin.stratacore.tech   → <Stratacore server LAN IP>
api.stratacore.tech     → same
guest.stratacore.tech   → same
ocpp.stratacore.tech    → same
```

Phones and chargers already use company DNS — they resolve automatically. No per-device setup. See **[PHONE-ACCESS-NO-ROUTER.md](PHONE-ACCESS-NO-ROUTER.md)** for an IT ticket template.

**Good for:** production at large companies, guest QR scans, all chargers.

### Option C — Local DNS with dnsmasq (dedicated site you control)

Same config on Windows and Xubuntu — only when **you own the router** and accept setting DHCP DNS:

**Windows (Docker):** `SETUP-DNSMASQ.bat`

**Xubuntu:**

```bash
sudo bash deploy/setup-dnsmasq.sh
```

Then set **router DHCP DNS** to this machine's LAN IP. **Not for shared company office Wi‑Fi.**

**Good for:** dedicated charging site with its own router/VLAN.

### Option D — Per-phone manual DNS (testing, no IT, no router)

On **one phone**: Wi‑Fi → Configure DNS → Manual → Stratacore server IP. See **[PHONE-ACCESS-NO-ROUTER.md](PHONE-ACCESS-NO-ROUTER.md)**.

---

## HTTP vs HTTPS on LAN

The default local installer uses **HTTP** (`deploy/Caddyfile.local-http`). This avoids certificate warnings and works reliably with chargers using `ws://`.

| | HTTP (default) | HTTPS (optional) |
|---|---|---|
| Caddy config | `deploy/Caddyfile.local-http` | `deploy/Caddyfile.local` |
| URLs | `http://admin.stratacore.tech` | `https://admin.stratacore.tech` |
| Env files | `http://api.stratacore.tech` | `https://api.stratacore.tech` |
| Browsers | No warnings | One-time self-signed cert warning |
| Chargers | `ws://ocpp.stratacore.tech/ocpp/<id>` | `wss://...` (may reject self-signed certs) |

To switch to HTTPS:

```bash
# Update env files to https://, rebuild, then:
sudo cp deploy/Caddyfile.local /etc/caddy/Caddyfile
sudo -u stratacore npm run build
sudo systemctl restart caddy stratacore-kiosk stratacore-guest-app
```

Accept the browser certificate warning once on each kiosk browser.

---

## Verify the deployment

### Automated check

```bash
sudo bash deploy/health-check.sh
```

### Manual checks

```bash
# Service status
systemctl status stratacore-backend stratacore-kiosk stratacore-guest-app caddy

# Listening ports
ss -tlnp | grep -E ':4001|:3001|:3002|:80|:9000'

# API health
curl -s http://api.stratacore.tech/api/health

# Web apps
curl -s -o /dev/null -w "kiosk: %{http_code}\n" http://admin.stratacore.tech
curl -s -o /dev/null -w "guest: %{http_code}\n" http://guest.stratacore.tech

# Charger list
curl -s "http://api.stratacore.tech/api/v1/charging/chargers?ids=DELTA123"
```

Expected API health response:

```json
{"status":"ok","timestamp":"...","service":"stratacore-kiosk-backend"}
```

### End-to-end flow

1. Open **http://admin.stratacore.tech** → log in → confirm dashboard loads.
2. Open **http://guest.stratacore.tech** on a phone (same Wi‑Fi, DNS configured) → confirm guest UI loads.
3. If using QR codes, the link should point to `http://guest.stratacore.tech/claim?token=...`.

---

## Configure the charger

On the physical charger, set the OCPP central system URL:

```
ws://ocpp.stratacore.tech/ocpp/DELTA123
```

Replace `DELTA123` with your charger ID from `NEXT_PUBLIC_CHARGERS`.

The charger must resolve `ocpp.stratacore.tech` to the server IP (via dnsmasq or router DNS).

---

## Day-to-day operations

### Start / stop / restart

```bash
sudo systemctl restart stratacore-backend
sudo systemctl restart stratacore-kiosk
sudo systemctl restart stratacore-guest-app
sudo systemctl restart caddy
```

Restart everything:

```bash
sudo systemctl restart stratacore-backend stratacore-kiosk stratacore-guest-app caddy
```

### View logs

```bash
journalctl -u stratacore-backend -f
journalctl -u stratacore-kiosk -f
journalctl -u stratacore-guest-app -f
journalctl -u caddy -f
```

### Enable services on boot

Already done by the setup script. To confirm:

```bash
systemctl is-enabled stratacore-backend stratacore-kiosk stratacore-guest-app caddy
```

### Optional swap (recommended on 8 GB RAM)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Updating the app

```bash
cd /opt/stratacore
sudo git pull
sudo -u stratacore npm install
sudo -u stratacore npm run build
sudo systemctl restart stratacore-backend stratacore-kiosk stratacore-guest-app
```

If you changed `NEXT_PUBLIC_*` env values, the rebuild step is required before restarting the frontends.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `curl: Could not resolve host` | Domain not in hosts/DNS | Add hosts entry or configure dnsmasq |
| 502 Bad Gateway from Caddy | Backend not running | `journalctl -u stratacore-backend -f` |
| Kiosk loads but no data | Wrong `NEXT_PUBLIC_BACKEND_URL` or stale build | Fix env, `npm run build`, restart kiosk |
| Phone can't open guest URL | Phone DNS doesn't know stratacore.tech | Use dnsmasq + router DNS |
| Charger won't connect | DNS or wrong OCPP URL | Verify `ws://ocpp.stratacore.tech/ocpp/<id>` resolves |
| CORS errors in browser | Mismatch between env and actual URL | Ensure `CORS_ALLOWED_ORIGINS` matches how you access the kiosk/guest apps |
| Port 80 already in use | Another web server running | `sudo ss -tlnp \| grep :80` and stop conflicting service |

### Re-run the installer

Safe to re-run after fixing env files:

```bash
sudo bash deploy/setup-xubuntu-local.sh
```

### Manual install (without script)

```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy — see https://caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo apt install -y caddy

# Build
cd /opt/stratacore
npm install && npm run build

# Systemd
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stratacore-backend stratacore-kiosk stratacore-guest-app

# Caddy
sudo cp deploy/Caddyfile.local-http /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

---

## Customizing subdomains

Subdomain names are **not hardcoded in the kiosk/guest app code**. You change them in **three layers**. The default admin subdomain is **`admin.stratacore.tech`** (port 3001).

Example: rename `admin.stratacore.tech` → `ops.stratacore.tech`

### Layer 1 — Local DNS (hosts or dnsmasq)

**On this server** — edit `/etc/hosts`:

```diff
- 192.168.1.50 api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
+ 192.168.1.50 api.stratacore.tech ops.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
```

**For all LAN devices** — edit `deploy/dnsmasq-local.conf`:

```diff
- address=/admin.stratacore.tech/192.168.1.50
+ address=/ops.stratacore.tech/192.168.1.50
```

Then:

```bash
sudo cp deploy/dnsmasq-local.conf /etc/dnsmasq.d/stratacore.conf
sudo systemctl restart dnsmasq
```

Or re-run `sudo bash deploy/setup-xubuntu-local.sh` after updating the repo files.

### Layer 2 — Caddy (routes domain → port)

Edit `deploy/Caddyfile.local-http` (HTTP) or `deploy/Caddyfile.local` (HTTPS):

```diff
- http://admin.stratacore.tech {
+ http://ops.stratacore.tech {
    reverse_proxy localhost:3001
  }
```

The **port stays 3001** — only the domain name changes. Caddy still forwards to the same kiosk app.

Copy to Caddy and restart:

```bash
sudo cp deploy/Caddyfile.local-http /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Also update `deploy/setup-xubuntu-local.sh` hosts block if you use the installer.

### Layer 3 — Backend CORS (allows the browser to call the API)

Edit `apps/backend/.env`:

```diff
- CORS_ALLOWED_ORIGINS=http://admin.stratacore.tech,http://guest.stratacore.tech
+ CORS_ALLOWED_ORIGINS=http://ops.stratacore.tech,http://guest.stratacore.tech
```

The kiosk app does **not** need its own URL in env — only `NEXT_PUBLIC_BACKEND_URL` (the API). The admin URL is whatever you type in the browser.

Restart backend:

```bash
sudo systemctl restart stratacore-backend
```

No `npm run build` needed unless you changed `NEXT_PUBLIC_*` in kiosk/guest env files.

### Apply and test

```bash
curl -s -o /dev/null -w "admin: %{http_code}\n" http://ops.stratacore.tech
```

Open: **http://ops.stratacore.tech** (or `https://` if using `Caddyfile.local`)

### Rename cheat sheet

| If you rename… | Update hosts / dnsmasq | Update Caddy | Update `apps/backend/.env` | Update kiosk/guest `.env.local` |
|----------------|------------------------|--------------|----------------------------|--------------------------------|
| `admin.*` (kiosk UI) | ✓ | ✓ | ✓ `CORS_ALLOWED_ORIGINS` | — |
| `api.*` | ✓ | ✓ | — | ✓ `NEXT_PUBLIC_BACKEND_URL` + **rebuild** |
| `guest.*` | ✓ | ✓ | ✓ `GUEST_APP_URL` + `CORS_ALLOWED_ORIGINS` | — |
| `ocpp.*` | ✓ | ✓ | — | — (set on physical charger) |

To change the **root domain** (e.g. `stratacore.tech` → `mycompany.local`), also edit `packages/shared/src/urls.ts` → `STRATACORE_DOMAIN`.

---

## Optional: public internet deployment

If you later expose Stratacore to the internet (not the default for this project):

1. Add public DNS A records for `api`, `admin`, `guest`, `ocpp` → your public IP
2. Forward ports 80 and 443 on your router
3. Use `deploy/env.production.example` for env files (`https://` URLs)
4. Run `sudo bash deploy/setup-xubuntu.sh` instead of `setup-xubuntu-local.sh`

That script uses `deploy/Caddyfile` with automatic Let's Encrypt certificates.

---

## Deploy file reference

| File | Purpose |
|------|---------|
| `deploy/setup-xubuntu-local.sh` | **Local LAN installer** (use this) |
| `deploy/setup-xubuntu.sh` | Public internet installer |
| `deploy/env.local.example` | Env template for local HTTP |
| `deploy/env.production.example` | Env template for public HTTPS |
| `deploy/Caddyfile.local-http` | Caddy config — HTTP on LAN |
| `deploy/Caddyfile.local` | Caddy config — HTTPS with self-signed certs |
| `deploy/Caddyfile` | Caddy config — public HTTPS (Let's Encrypt) |
| `deploy/setup-dnsmasq.sh` | **dnsmasq on Xubuntu** (native) |
| `deploy/setup-dnsmasq.ps1` | **dnsmasq on Windows** (Docker) |
| `deploy/dnsmasq/stratacore.conf` | Generated LAN DNS records (shared) |
| `deploy/dnsmasq-local.conf` | Same content (backward-compatible copy) |
| `deploy/health-check.sh` | Post-install verification |
| `deploy/systemd/*.service` | systemd unit files |

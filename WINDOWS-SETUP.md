# Stratacore — Windows Setup Guide

Run the Stratacore kiosk system on a **Windows PC** for local on-prem use. This guide replaces `localhost` URLs with **`stratacore.tech`** domain names on your own machine. Nothing is exposed to the public internet.

For Linux/Xubuntu deployment, see [`deploy/XUBUNTU.md`](deploy/XUBUNTU.md).

## Easiest way (3 shortcuts in repo root)

| Double-click this | When to use |
|-------------------|-------------|
| **`SETUP-STRATACORE.bat`** | **First time only** — hosts file, Caddy, build, start |
| **`START-STRATACORE.bat`** | **Every day** — stop old processes and start everything **in the background** (no extra windows) |
| **`START-STRATACORE-VISIBLE.bat`** | Same as start, but opens 4 console windows (for debugging) |
| **`SETUP-LAN-ACCESS.bat`** | **Once** — universal Wi‑Fi access (dnsmasq + firewall + instructions) |
| **`VERIFY-LAN-ACCESS.bat`** | Check DNS/firewall before testing on phone |
| **`SETUP-DNSMASQ.bat`** | dnsmasq only (included in SETUP-LAN-ACCESS) |
| **`STOP-DNSMASQ.bat`** | Stop dnsmasq Docker container |
| **`RESTART-STRATACORE.bat`** | **Full restart** — stop apps + Docker DNS, then start everything |
| **`VIEW-LOGS.bat`** | Open `deploy\logs\` — backend, kiosk, guest-app, caddy output |
| **`STOP-STRATACORE.bat`** | **Shut down** — free ports 4001, 3001, 3002, 443, 9000 |
| **`OPEN-LAN-FIREWALL.bat`** | Open ports 443 + 9000 (included in SETUP-DNSMASQ) |

Or from terminal:

```powershell
npm run start:stratacore   # daily start
npm run stop:stratacore    # stop all
npm run setup:stratacore   # first-time setup
```

Then open **https://admin.stratacore.tech**

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [What you need](#what-you-need)
4. [Quick start](#quick-start)
5. [Environment files](#environment-files)
6. [Hosts file setup](#hosts-file-setup)
7. [Build and run](#build-and-run)
8. [Verify the deployment](#verify-the-deployment)
9. [HTTP vs HTTPS](#http-vs-https)
10. [Test with a charger simulator](#test-with-a-charger-simulator)
11. [Configure a physical charger](#configure-a-physical-charger)
12. [Day-to-day operations](#day-to-day-operations)
13. [Development mode](#development-mode)
14. [Troubleshooting](#troubleshooting)
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
https://api.stratacore.tech    → backend
https://admin.stratacore.tech  → kiosk admin
https://guest.stratacore.tech  → guest mobile app
wss://ocpp.stratacore.tech     → charger WebSocket
```

**This setup does not require:**

- Public DNS at your domain registrar
- Port forwarding on your router
- A Linux server

**It does require:**

- Node.js 18+
- A Windows hosts file entry pointing `*.stratacore.tech` → `127.0.0.1`
- Caddy as a local reverse proxy
- Four running processes (backend, kiosk, guest app, Caddy)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Your Windows PC (127.0.0.1)                                 │
│                                                              │
│  Caddy :443  ──►  admin.stratacore.tech  ──►  Next.js :3001 │
│               ──►  guest.stratacore.tech ──►  Next.js :3002 │
│               ──►  api.stratacore.tech   ──►  NestJS  :4001 │
│               ──►  ocpp.stratacore.tech  ──►  OCPP WS :9000 │
└──────────────────────────────────────────────────────────────┘
```

| Component | How it runs | Port |
|-----------|-------------|------|
| Backend API + Socket.IO + OCPP | `npm run start --workspace=backend` | 4001 / 9000 |
| Kiosk admin | `npm run start --workspace=kiosk` | 3001 |
| Guest mobile app | `npm run start --workspace=guest-app` | 3002 |
| Reverse proxy | `deploy\bin\caddy.exe` | 443 (or 80 for HTTP) |

---

## What you need

| Item | Notes |
|------|-------|
| Windows 10/11 | Admin access needed once for hosts file |
| Node.js 18+ | Check with `node -v` |
| Git | To clone the repo |
| ~2 GB free RAM | Typical usage is 1–2 GB total |

No external database is required — the backend uses an in-memory store.

---

## Quick start

From the repo root (e.g. `D:\RFID-Testing-Stratacore`):

### 1. Install dependencies

```powershell
cd D:\RFID-Testing-Stratacore
npm install
```

### 2. Create env files

See [Environment files](#environment-files) below, then create:

- `apps\backend\.env`
- `apps\kiosk\.env.local`
- `apps\guest-app\.env.local`

### 3. Run the automated setup

**Easiest — double-click** (UAC will ask for Admin):

```
deploy\setup-stratacore.bat
```

Or from any PowerShell (will prompt for Admin automatically):

```powershell
cd D:\RFID-Testing-Stratacore
powershell -ExecutionPolicy Bypass -File deploy\setup-stratacore.ps1
```

> If you see `ScriptRequiresElevation`, click **Yes** on the UAC prompt, or open PowerShell **Run as administrator** and run the command again.

This script will:

1. Add `stratacore.tech` to your Windows hosts file
2. Download Caddy to `deploy\bin\caddy.exe` (if missing)
3. Run `npm run build`
4. Open four PowerShell windows for backend, kiosk, guest app, and Caddy

### 4. Open in browser

- https://admin.stratacore.tech
- https://guest.stratacore.tech

Accept the self-signed certificate warning once.

---

## Environment files

These files are gitignored — create them locally.

### `apps\backend\.env`

**MySQL mode (shared EdgeTechEV database):**

```env
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3305
DB_USER=ev3_user
DB_PASSWORD=admin123
DB_NAME=ev_charger_backend
USE_SQLITE=false

JWT_SECRET_KEY=change-me-use-a-long-random-string
OPERATOR_BASE_BALANCE=200
OPERATOR_MIN_BALANCE_KWH=5
BACKEND_PORT=4001
OCPP_WS_PORT=9000
OCPP_WS_PATH=/ocpp
PRICE_PER_KWH=15
PAYNAMICS_WEBHOOK_SECRET=change-me-use-a-long-random-string
PAYNAMICS_CHECKOUT_URL=https://www.paynamics.net/webpaymentservice/checkout
GUEST_APP_URL=https://guest.stratacore.tech
CORS_ALLOWED_ORIGINS=https://admin.stratacore.tech,https://guest.stratacore.tech

CHARGE_START_TIMEOUT_MS=60000
STALE_SESSION_THRESHOLD_MINUTES=10
STALE_SESSION_CHECK_INTERVAL_SECONDS=60
STALE_SESSION_MAX_RECOVERY_PER_CYCLE=10
STALE_SESSION_AUTOSTART=1
WATCHDOG_AUTOSTART=0
HEALTH_MONITOR_AUTOSTART=1
```

When `DB_HOST` is set and MySQL connects, Stratacore uses **users** (roles: master/admin/staff), **chargers**, **sessions**, and **operator_energy_requests** from the existing EdgeTechEV database. Admin and operator logins use the same accounts as EdgeTechEV.

After configuring `.env`:

```powershell
cd apps\backend
npm run prisma:generate
```

**File-only fallback** — omit `DB_HOST` or set `USE_SQLITE=true`; uses `rfids.json` and `admin-users.json` (default admin **`master`** / **`master123`**).

### `apps\kiosk\.env.local`

```env
NEXT_PUBLIC_BACKEND_URL=https://api.stratacore.tech
NEXT_PUBLIC_STATION_NAME=Charging Station
NEXT_PUBLIC_STATION_LOCATION=
NEXT_PUBLIC_CHARGERS=[{"chargerId":"DELTA123","connectorId":1,"chargerIp":"192.168.137.51"}]
```

Admin login: open https://admin.stratacore.tech/login — default account **`master`** / **`master123`** (or set `ADMIN_DEFAULT_PASSWORD` in backend `.env` on first run). Roles: `master`, `admin` (full sidebar), `staff` (limited tabs).

### `apps\guest-app\.env.local`

```env
NEXT_PUBLIC_BACKEND_URL=https://api.stratacore.tech
NEXT_PUBLIC_CHARGERS=[{"chargerId":"DELTA123","connectorId":1}]
```

**Operator mobile:** https://guest.stratacore.tech/auth/login — use RFID or username + PIN from the kiosk **Operators** tab.

**Guest QR flow:** https://guest.stratacore.tech/guest?token=... (unchanged).

### Roles, operators, and RFID balance

| Concept | Stratacore field | Notes |
|---------|------------------|-------|
| Base monthly allowance | `monthlyKwhLimit` on RFID card | Set in **Top-Up** tab or when creating an operator |
| Remaining balance | `monthlyKwhLimit - currentMonthKwhConsumed` | Shown as `balance` in operator mobile app |
| Admin users | `apps/backend/admin-users.json` | First run creates `master` (password from `ADMIN_DEFAULT_PASSWORD` or `master123`) |
| Operators | `apps/backend/rfids.json` | Each card can have `username`, `pinHash`, and `role` (`operator` / `staff`) |

Sample operator (seeded in `rfids.json`): RFID **`0429DD0AD86380`**, username **`pingpong`**, PIN **`1234`**, 200 kWh/month.

> **Important:** `NEXT_PUBLIC_*` values are baked in at build time. After changing them, run `npm run build` and restart the kiosk and guest app.

Full HTTP template (no cert warnings): [`deploy/env.local.example`](deploy/env.local.example)

---

## Hosts file setup

Your PC must resolve `stratacore.tech` subdomains to itself.

### Option A — Batch file (recommended)

Right-click **`deploy\update-hosts.bat`** → **Run as administrator**

### Option B — Manual edit

Open as Administrator:

```
C:\Windows\System32\drivers\etc\hosts
```

Add:

```
127.0.0.1 api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
```

### Verify

```powershell
Select-String -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Pattern "stratacore"
```

---

## Build and run

### Automated (recommended)

**Admin PowerShell:**

```powershell
cd D:\RFID-Testing-Stratacore
powershell -ExecutionPolicy Bypass -File deploy\setup-stratacore.ps1
```

### Manual — four separate terminals

**Terminal 1 — Backend**

```powershell
cd D:\RFID-Testing-Stratacore
npm run start --workspace=backend
```

**Terminal 2 — Kiosk** (wait ~3 seconds after backend starts)

```powershell
cd D:\RFID-Testing-Stratacore
npm run start --workspace=kiosk
```

**Terminal 3 — Guest app**

```powershell
cd D:\RFID-Testing-Stratacore
npm run start --workspace=guest-app
```

**Terminal 4 — Caddy**

```powershell
cd D:\RFID-Testing-Stratacore
.\deploy\bin\caddy.exe run --config deploy\Caddyfile.local
```

### Build only (after code or env changes)

```powershell
cd D:\RFID-Testing-Stratacore
npm run build
```

Then restart kiosk, guest app, and backend.

---

## Verify the deployment

### Check ports

```powershell
netstat -ano | findstr "LISTENING" | findstr ":4001 :3001 :3002 :443"
```

### API health

```powershell
curl.exe -sk https://api.stratacore.tech/api/health
```

Expected:

```json
{"status":"ok","timestamp":"...","service":"stratacore-kiosk-backend"}
```

### Web apps

```powershell
curl.exe -sk -o NUL -w "kiosk: %{http_code}`n" https://admin.stratacore.tech
curl.exe -sk -o NUL -w "guest: %{http_code}`n" https://guest.stratacore.tech
```

Both should return **200**.

### Open in browser

```powershell
start https://admin.stratacore.tech
start https://guest.stratacore.tech
```

Log in to the kiosk with the username and password from `apps\kiosk\.env.local`.

### End-to-end checklist

```
[ ] npm install
[ ] apps\backend\.env created
[ ] apps\kiosk\.env.local created
[ ] apps\guest-app\.env.local created
[ ] deploy\update-hosts.bat run as Admin
[ ] npm run build
[ ] Backend, kiosk, guest app, and Caddy all running
[ ] https://api.stratacore.tech/api/health returns ok
[ ] https://admin.stratacore.tech loads and login works
```

---

## HTTP vs HTTPS

The default Windows setup uses **HTTPS** with a self-signed certificate (`deploy\Caddyfile.local`). Your browser will warn once — click **Advanced → Proceed**.

| | HTTPS (default) | HTTP (optional) |
|---|---|---|
| Caddy config | `deploy\Caddyfile.local` | `deploy\Caddyfile.local-http` |
| URLs | `https://admin.stratacore.tech` | `http://admin.stratacore.tech` |
| Env files | `https://api.stratacore.tech` | `http://api.stratacore.tech` |
| Browsers | One-time cert warning | No warnings |
| Chargers | `wss://ocpp.stratacore.tech/...` | `ws://ocpp.stratacore.tech/...` |

To switch to HTTP:

1. Update env files to `http://` (see `deploy\env.local.example`)
2. Rebuild: `npm run build`
3. Start Caddy with:

```powershell
.\deploy\bin\caddy.exe run --config deploy\Caddyfile.local-http
```

---

## Test with a charger simulator

If you don't have a physical charger connected, run the built-in simulator.

**Direct to backend (bypasses Caddy):**

```powershell
cd D:\RFID-Testing-Stratacore
$env:OCPP_HOST="127.0.0.1"; $env:OCPP_PORT="9000"; npm run sim
```

**Through the domain (HTTPS setup):**

```powershell
cd D:\RFID-Testing-Stratacore
$env:OCPP_HOST="ocpp.stratacore.tech"; $env:OCPP_PORT="443"; npm run sim
```

Then open the kiosk dashboard — the simulated charger should appear as connected.

---

## Configure a physical charger

On the charger, set the OCPP central system URL:

```
wss://ocpp.stratacore.tech/ocpp/DELTA123
```

Replace `DELTA123` with your charger ID from `NEXT_PUBLIC_CHARGERS`.

> **Note:** A phone or charger on another device cannot use your PC's hosts file. See [Phone and LAN access](#phone-and-lan-access) below.

---

## Phone and LAN access (no router changes)

**Large company / shared Wi‑Fi:** do **not** change router DNS. See **[deploy/PHONE-ACCESS-NO-ROUTER.md](deploy/PHONE-ACCESS-NO-ROUTER.md)**.

| Situation | What to do |
|-----------|------------|
| **Your phone only (testing now)** | Manual Wi‑Fi DNS → `192.168.254.154` + dnsmasq on PC |
| **Production (large company)** | Ask IT for internal DNS A records (no router/DHCP changes) |
| **Dedicated site you fully control** | Optional router DNS + dnsmasq (see XUBUNTU.md) |

### Quick path — your phone only (no router change)

**On the PC (once):**
1. Docker Desktop running
2. **`SETUP-DNSMASQ.bat`** (starts dnsmasq on your PC)
3. **`START-STRATACORE.bat`** daily

**On your phone only:**
1. Wi‑Fi settings → **Configure DNS** → **Manual**
2. Add **`192.168.254.154`** (your PC's Wi‑Fi IP from `ipconfig`)
3. Open **`https://admin.stratacore.tech`** → accept cert once

Other employees and company router settings are **not affected**.

**Verify PC side:** **`VERIFY-LAN-ACCESS.bat`**

Full steps (iPhone/Android): **[deploy/PHONE-ACCESS-NO-ROUTER.md](deploy/PHONE-ACCESS-NO-ROUTER.md)**

### Production — corporate IT (recommended at scale)

One IT ticket for internal DNS records pointing `admin/api/guest/ocpp.stratacore.tech` to the Stratacore server IP. No router DHCP change. Same URLs on every phone automatically.

### Optional — universal Wi‑Fi (only if YOU control the router)

Use **`SETUP-LAN-ACCESS.bat`** and set router DHCP DNS only on networks you own (e.g. dedicated charging site). **Not for shared company office Wi‑Fi.**

### Xubuntu production (same config)

```bash
sudo bash deploy/setup-dnsmasq.sh
# Set router DHCP DNS to the Xubuntu LAN IP
```

Uses the same `deploy/dnsmasq/stratacore.conf` format. See [`deploy/XUBUNTU.md`](deploy/XUBUNTU.md).

### Manual / alternative options

<details>
<summary>Router custom DNS without dnsmasq</summary>

In router admin, add A records pointing to your Stratacore host LAN IP:

| Hostname |
|----------|
| `admin.stratacore.tech` |
| `api.stratacore.tech` |
| `guest.stratacore.tech` |
| `ocpp.stratacore.tech` |

</details>

### Regenerate after IP change

```powershell
powershell -ExecutionPolicy Bypass -File deploy\generate-dnsmasq-conf.ps1
docker compose -f deploy\docker-compose.dnsmasq.yml up -d --force-recreate
```

---

## Day-to-day operations

### Start (after reboot)

Double-click **`START-STRATACORE.bat`** — starts all services in the background (no extra PowerShell windows) and runs an automatic health check. Logs go to `deploy\logs\`.

For debugging with visible console windows, use **`START-STRATACORE-VISIBLE.bat`** instead.

Manual health check anytime:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\health-check.ps1
```

### Stop

Close the four PowerShell windows, or:

```powershell
Get-NetTCPConnection -LocalPort 4001,3001,3002,443 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
```

### Update after pulling code

```powershell
cd D:\RFID-Testing-Stratacore
git pull
npm install
npm run build
powershell -ExecutionPolicy Bypass -File deploy\setup-stratacore.ps1
```

---

## Development mode

For active coding with hot reload, use dev mode instead of production start:

```powershell
cd D:\RFID-Testing-Stratacore
npm run dev
```

This starts all apps on `localhost` ports (3001, 3002, 4001). Caddy is not required in dev mode unless you want to test with domain names.

Use **production start** (`npm run start` + Caddy) when demoing or testing the full domain-based flow.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Could not resolve host` | Hosts file not updated | Run `deploy\update-hosts.bat` as Admin |
| Certificate / privacy error | Self-signed HTTPS | Accept once, or switch to HTTP config |
| 502 Bad Gateway | Backend not running | Check the Stratacore Backend terminal window |
| Kiosk loads but no data | Stale build or wrong env | Fix env, run `npm run build`, restart kiosk |
| Port already in use | Old process still running | Stop processes on 4001/3001/3002/443 |
| CORS errors | URL mismatch | Ensure env URLs match how you access the apps |
| `caddy.exe` not found | Caddy not downloaded | Re-run `deploy\setup-stratacore.ps1` |
| Phone can't open guest URL | Phone doesn't use PC hosts file | Test in PC browser, or use Xubuntu + dnsmasq |

### Check what's using a port

```powershell
netstat -ano | findstr ":4001"
```

### View backend logs

Check the **Stratacore Backend** PowerShell window, or restart backend in foreground:

```powershell
cd D:\RFID-Testing-Stratacore
npm run start --workspace=backend
```

---

## Customizing subdomains

Subdomain names are **not hardcoded in the kiosk/guest app code**. You change them in **three layers**. The default admin subdomain is **`admin.stratacore.tech`** (port 3001).

Example: rename `admin.stratacore.tech` → `ops.stratacore.tech`

### Layer 1 — Hosts file (DNS on your PC)

Edit as Administrator:

```
C:\Windows\System32\drivers\etc\hosts
```

```diff
- 127.0.0.1 api.stratacore.tech admin.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
+ 127.0.0.1 api.stratacore.tech ops.stratacore.tech guest.stratacore.tech ocpp.stratacore.tech
```

Or update `deploy\update-hosts.bat` in the repo and re-run it as Admin.

### Layer 2 — Caddy (routes domain → port)

Edit `deploy\Caddyfile.local` (HTTPS) or `deploy\Caddyfile.local-http` (HTTP):

```diff
- admin.stratacore.tech {
+ ops.stratacore.tech {
    tls internal
    reverse_proxy localhost:3001
  }
```

The **port stays 3001** — only the domain name changes.

### Layer 3 — Backend CORS (allows the browser to call the API)

Edit `apps\backend\.env`:

```diff
- CORS_ALLOWED_ORIGINS=https://admin.stratacore.tech,https://guest.stratacore.tech
+ CORS_ALLOWED_ORIGINS=https://ops.stratacore.tech,https://guest.stratacore.tech
```

Restart backend and Caddy:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\setup-stratacore.ps1
```

No `npm run build` needed unless you changed `NEXT_PUBLIC_*` in kiosk/guest env files.

### Rename cheat sheet

| If you rename… | Update hosts | Update Caddy | Update backend `.env` | Update kiosk/guest `.env.local` |
|----------------|-------------|--------------|----------------------|--------------------------------|
| `admin.*` (kiosk UI) | ✓ | ✓ | ✓ `CORS_ALLOWED_ORIGINS` | — |
| `api.*` | ✓ | ✓ | — | ✓ `NEXT_PUBLIC_BACKEND_URL` + **rebuild** |
| `guest.*` | ✓ | ✓ | ✓ `GUEST_APP_URL` + `CORS_ALLOWED_ORIGINS` | — |
| `ocpp.*` | ✓ | ✓ | — | — (set on physical charger) |

To change the **root domain** (e.g. `stratacore.tech` → `mycompany.local`), also edit `packages\shared\src\urls.ts` → `STRATACORE_DOMAIN`.

---

## Deploy file reference

| File | Purpose |
|------|---------|
| `deploy\setup-stratacore.ps1` | **One-click Windows setup** (hosts + build + start) |
| `deploy\update-hosts.bat` | Add stratacore.tech to hosts file only |
| `deploy\env.local.example` | Env template for local HTTP |
| `deploy\env.production.example` | Env template for public HTTPS |
| `deploy\Caddyfile.local` | Caddy — HTTPS with self-signed certs |
| `deploy\Caddyfile.local-http` | Caddy — HTTP, no cert warnings |
| `deploy\Caddyfile` | Caddy — public HTTPS (Let's Encrypt) |
| `deploy\bin\caddy.exe` | Caddy binary (auto-downloaded by setup script) |
| `deploy\XUBUNTU.md` | Linux/Xubuntu deployment guide |

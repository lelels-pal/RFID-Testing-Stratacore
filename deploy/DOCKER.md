# Stratacore Docker deployment

One-command stack for a 3-charger on-prem site: backend, kiosk, guest app, Redis, and Caddy.

## Prerequisites

- Docker Engine + Compose plugin on Xubuntu (or any Linux host)
- LAN DNS or `/etc/hosts` for `api.stratacore.tech`, `admin.stratacore.tech`, `guest.stratacore.tech`, `ocpp.stratacore.tech`
- Maya sandbox (or production) API keys

## Quick start

```bash
bash deploy/setup-docker-host.sh
# Edit deploy/.env.docker — set JWT_SECRET, ADMIN_PASSWORD, MAYA_* keys, CHARGERS_JSON
cd deploy
docker compose up -d --build
bash health-check.sh
```

## Services

| Service    | Port  | URL                          |
|-----------|-------|------------------------------|
| backend   | 4001  | http://api.stratacore.tech   |
| OCPP WS   | 9000  | ws://ocpp.stratacore.tech/ocpp/{chargerId} |
| kiosk     | 3001  | http://admin.stratacore.tech |
| guest-app | 3002  | http://guest.stratacore.tech |
| redis     | 6379  | internal only                |
| caddy     | 80/443| reverse proxy                |

All services use `restart: unless-stopped`.

## Admin login

Kiosk uses server-side admin auth — no client-side passwords.

1. Open http://admin.stratacore.tech
2. Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `deploy/.env.docker`
3. Open a bay → QR code is generated via `POST /api/v1/session/initiate` (admin JWT)

## Maya payment (LAN path)

Primary fulfillment does **not** require a public webhook:

1. Guest scans QR → claims session → selects plan
2. Redirect to Maya Checkout
3. Maya returns to `/payment/return?ref=...&outcome=success`
4. Guest app calls `POST /api/v1/payments/verify`
5. Backend confirms with Maya Secret Key → `triggerRemoteStart()` → charge-start watchdog arms

Pre-flight Maya keys:

```bash
node tools/test-maya-tariff-plans.mjs
```

Optional async webhook (not required on LAN):

```
https://<public-host>/api/v1/payments/maya-webhook?token=<MAYA_WEBHOOK_TOKEN>
```

## Watchdog operations

In-process watchdogs autostart via env vars in `deploy/env.docker.example`:

- **Charge-start** — cancels session if no vehicle within `CHARGE_START_TIMEOUT_MS` (default 60s)
- **Stale session** — recovers orphaned sessions after charger disconnect
- **Service watchdog** — polls `/api/health` + OCPP port
- **Health monitor** — CPU/RAM/event-loop snapshots

Verify after deploy (requires admin JWT):

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://api.stratacore.tech/api/watchdog | jq
```

Host cron (installed by `setup-docker-host.sh`):

```bash
*/5 * * * * node tools/watchdog/service-watchdog.js
```

Or manually:

```bash
npm run watchdog:check
```

## 3-charger go-live checklist

- [ ] `deploy/.env.docker` — production secrets set (not defaults)
- [ ] `CHARGERS_JSON` lists all 3 charger IDs and IPs
- [ ] Each charger OCPP URL: `ws://ocpp.stratacore.tech/ocpp/{chargerId}`
- [ ] `node tools/test-maya-tariff-plans.mjs` passes
- [ ] Kiosk login works; each bay shows a QR when IDLE
- [ ] Guest E2E: scan → plan → Maya sandbox → return → charging starts
- [ ] RFID remote start still works per bay
- [ ] `GET /api/watchdog` shows monitors active
- [ ] Charge-start timeout tested (RemoteStart, no plug-in → auto-cancel ~60s)
- [ ] Host cron `service-watchdog.js` installed
- [ ] `bash deploy/health-check.sh` passes

## RFID data

`rfids.json` is gitignored. Seed on first deploy:

```bash
cp apps/backend/rfids.json.example rfids.json
# mount or copy into backend container at /app/rfids.json
```

## Logs

```bash
cd deploy
docker compose logs -f backend
docker compose logs -f kiosk
tail -f deploy/logs/watchdog.log
```

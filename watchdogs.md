# Watchdogs Reference

Portable reference for EV3 watchdog patterns and their implementation in **RFID-Testing-Stratacore** (Stratacore Kiosk System). Use this document when adding resilience to other Node/NestJS or EV charging projects.

---

## Table of Contents

1. [Overview](#overview)
2. [EV3 Source Findings](#ev3-source-findings)
3. [Related Monitors (Not Named Watchdog)](#related-monitors-not-named-watchdog)
4. [Implementation in This Project](#implementation-in-this-project)
5. [Configuration](#configuration)
6. [API Reference](#api-reference)
7. [External Scripts](#external-scripts)
8. [Reuse Checklist for Other Projects](#reuse-checklist-for-other-projects)

---

## Overview

Watchdogs are background processes that detect failure or stuck states and take corrective action: restart a service, cancel a session, or emit an alert.

| Layer | Purpose | Typical trigger |
|-------|---------|-----------------|
| **Infrastructure** | Keep MariaDB / Redis / OS services alive | Service stopped, TCP down |
| **Application services** | Keep API + OCPP + frontends running | HTTP health fails |
| **Charging sessions** | Prevent stuck UI / orphaned billing | No vehicle plugged in, charger disconnect |

---

## EV3 Source Findings

Source repo: `D:\ev3`

### 1. Service Watchdog (scheduled script)

| Field | Value |
|-------|-------|
| **File** | `backend/scripts/service_watchdog.py` |
| **Deployment** | Windows scheduled task `EV3_Service_Watchdog` via `SETUP_SCHEDULED_TASKS.ps1` |
| **Interval** | Every 5 minutes |
| **Monitors** | MariaDB Windows service + live DB connectivity |
| **Action** | `net start MariaDB`, log to `backend/logs/watchdog.log` |
| **Exit code** | `0` healthy, `1` issues detected |

**Design notes:**
- Runs outside the main app so it survives backend crashes.
- Verifies both *service state* and *actual connectivity* (service can be RUNNING but DB unreachable).

---

### 2. StrataSecure Service Watchdog (in-process orchestrator)

| Field | Value |
|-------|-------|
| **File** | `stratasecure/backend/main.py` |
| **Classes** | `WatchdogConfig`, `ServiceManager.watchdog_loop()` |
| **Port** | StrataSecure API `:3009` |
| **Interval** | 30 seconds (configurable) |
| **Auto-restart targets** | `backend_api` (:3003), `ocpp_server` (:3005) |
| **Skipped** | `mariadb`, `redis` (infrastructure, `auto_restart=False`) |

**Rate limiting:**
- Restart cooldown: 60 seconds per service
- Max restarts: 5 per hour per service

**API:**
- `GET /api/watchdog` — status + restart history
- `POST /api/watchdog/start` | `/stop`
- `PUT /api/watchdog/config`

**Auto-start:** `WATCHDOG_AUTOSTART=1` (off in dev by default)

**UI:** StrataSecure Next.js app `/watchdog` page + dashboard toggle

---

### 3. EV3 Lite Service Watcher (Windows service)

| Field | Value |
|-------|-------|
| **File** | `installer/watcher/ev3_service_watcher.py` |
| **Service** | `StrataCoreLiteWatcher` (`installer/winsw/EV3LiteWatcher.xml`) |
| **Config** | `installer/watcher/lite-services.json` |
| **Interval** | 20 seconds |
| **Failure threshold** | 3 consecutive failures before restart |
| **Restart cooldown** | 15 seconds |

**Monitored services (Lite appliance):**

| Service | Check | Port |
|---------|-------|------|
| Backend | HTTP `/api/health` | 3003 |
| Frontend | HTTP `/` | 3000 |
| OCPP | TCP | 3005 |
| MariaDB | TCP | 3306 |

**Design notes:**
- Checks Windows service state *and* application health (HTTP/TCP).
- Runs as its own Windows service with `onfailure action="restart"`.

---

## Related Monitors (Not Named Watchdog)

These are closely related resilience patterns from EV3 worth porting alongside watchdogs.

### Stale Session Monitor

| Field | Value |
|-------|-------|
| **File** | `backend/services/stale_session_monitor.py` |
| **Threshold** | 10 minutes without heartbeat |
| **Interval** | 60 seconds |
| **Max per cycle** | 10 recoveries |

**Triggers recovery when:**
1. Session status is `active`
2. Charger `last_heartbeat` is older than threshold
3. Charger is **not** in `connected_charge_points`

**Handles:** power loss, unclean WebSocket close, missing `StopTransaction`.

---

### Autonomous Health Monitor

| Field | Value |
|-------|-------|
| **File** | `backend/utils/autonomous_monitor.py` |
| **Interval** | 30 seconds |
| **Threshold** | Overall health < 80 triggers diagnostics |

**Checks:**
- System: CPU + memory via `psutil`
- Database: `health_check_database()`
- Network: HTTP probes
- Business: KPI-derived score

**Difference from watchdog:** observes and alerts; does not restart services by default.

---

### OCPP Watchdog Message (protocol-level)

OCPP 2.0.1 defines a `Watchdog` message type in `ocpp/v201/enums.py`. This is a **charger firmware** concept, not an EV3 application watchdog. Not implemented in this kiosk stack (OCPP 1.6J).

---

## Implementation in This Project

### Architecture

```
apps/backend/src/modules/watchdog/
├── charge-start-watchdog.service.ts   # No-vehicle timeout after RemoteStart
├── stale-session-watchdog.service.ts  # Orphan session recovery
├── service-watchdog.service.ts        # StrataSecure-style HTTP/TCP polling
├── health-monitor.service.ts          # Process/memory/event-loop health
├── watchdog-event-log.service.ts      # Shared event ring buffer
├── watchdog.service.ts                # Facade + status API
├── watchdog.controller.ts             # REST endpoints
├── watchdog.module.ts
└── watchdog.types.ts

tools/watchdog/
├── service-watchdog.js                # External scheduled checker (EV3 script port)
├── service-watcher.js                 # Continuous watcher (EV3 Lite port)
├── services.json                      # Watcher config
└── setup-watchdog-task.ps1            # Windows scheduled task installer
```

### 1. Charge Start Watchdog

**Problem:** Guest pays / RFID starts remote session, but driver never plugs in. UI stays on "Preparing" forever.

**Behavior:**
- Armed after successful `RemoteStartTransaction`
- Cleared when status becomes `Charging`, session ends, or fault occurs
- On timeout: cancel session on charger, emit `SESSION_ERROR`, log `charge_start_timeout` event

**Env:** `CHARGE_START_TIMEOUT_MS` (default `60000`)

**Used by:** `ChargingService` via `ChargeStartWatchdogService`

---

### 2. Stale Session Watchdog

**Problem:** Charger disconnects without `StopTransaction`. Session stays active in backend + kiosk.

**Behavior:**
- Polls active sessions every 60s (after 30s boot delay)
- If charger disconnected and `lastSeenAt` > 10 minutes → recover session
- Recovery: clear maps, cancel on charger, emit error to WebSocket clients

**Env:**
- `STALE_SESSION_THRESHOLD_MINUTES=10`
- `STALE_SESSION_CHECK_INTERVAL_SECONDS=60`
- `STALE_SESSION_AUTOSTART=1`

---

### 3. Service Watchdog (in-process)

**Problem:** Backend or OCPP listener dies silently; no external orchestrator notices.

**Behavior:**
- Polls `GET /api/health` and OCPP TCP port
- Optional auto-restart via shell command (`WATCHDOG_RESTART_COMMAND`)
- Rate-limited restarts (cooldown + hourly cap)
- Event log for `auto_restart`, `restart_success`, `restart_failed`

**Env:**
- `WATCHDOG_AUTOSTART=0` (enable with `1` in production)
- `WATCHDOG_CHECK_INTERVAL_SECONDS=30`
- `WATCHDOG_RESTART_COOLDOWN_SECONDS=60`
- `WATCHDOG_MAX_RESTARTS_PER_HOUR=5`

---

### 4. Health Monitor

**Problem:** Slow memory leak or event-loop blocking degrades service before hard failure.

**Behavior:**
- Tracks heap usage ratio + event-loop lag every 30s
- Emits `health_degraded` event when overall score < threshold
- Keeps last 100 snapshots in memory

**Env:**
- `HEALTH_MONITOR_AUTOSTART=1`
- `HEALTH_MONITOR_THRESHOLD=80`
- `HEALTH_MONITOR_INTERVAL_SECONDS=30`

---

### 5. External Service Watchdog (scheduled)

**Port of:** `D:\ev3\backend\scripts\service_watchdog.py`

```bash
node tools/watchdog/service-watchdog.js
```

Checks backend HTTP + OCPP TCP. Logs to `apps/backend/logs/watchdog.log`. Exit code 1 on failure ( suitable for monitoring alerts ).

**Windows task:** run `tools/watchdog/setup-watchdog-task.ps1` as Administrator.

---

### 6. External Service Watcher (continuous)

**Port of:** `D:\ev3\installer\watcher\ev3_service_watcher.py`

```bash
node tools/watchdog/service-watcher.js --config tools/watchdog/services.json
```

Continuous polling with failure thresholds and optional `restart_command` per service.

---

## Configuration

Copy `apps/backend/.env.example` watchdog section into your `.env`:

```env
CHARGE_START_TIMEOUT_MS=60000
STALE_SESSION_THRESHOLD_MINUTES=10
STALE_SESSION_CHECK_INTERVAL_SECONDS=60
STALE_SESSION_AUTOSTART=1
WATCHDOG_AUTOSTART=0
WATCHDOG_CHECK_INTERVAL_SECONDS=30
HEALTH_MONITOR_AUTOSTART=1
```

**Production recommendation:**
- `WATCHDOG_AUTOSTART=1` on deployed backend
- Run external `service-watchdog.js` via cron / Windows Task Scheduler
- Set `WATCHDOG_RESTART_COMMAND` only when a process manager (PM2, NSSM) can safely restart the app

---

## API Reference

Base URL: `http://localhost:4001`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness probe for service watchdog |
| GET | `/api/watchdog` | Full watchdog status |
| POST | `/api/watchdog/start` | Start in-process service watchdog |
| POST | `/api/watchdog/stop` | Stop in-process service watchdog |
| PUT | `/api/watchdog/config` | Update interval / cooldown / max restarts |
| GET | `/api/watchdog/events?limit=50` | Recent watchdog events |
| POST | `/api/watchdog/stale-sessions/check` | Manual stale session sweep |
| POST | `/api/watchdog/stale-sessions/start` | Start stale session monitor |
| POST | `/api/watchdog/stale-sessions/stop` | Stop stale session monitor |
| POST | `/api/watchdog/health/start` | Start health monitor |
| POST | `/api/watchdog/health/stop` | Stop health monitor |

**Event types:** `watchdog`, `watchdog_error`, `auto_restart`, `restart_success`, `restart_failed`, `stale_session`, `charge_start_timeout`, `health_degraded`

---

## External Scripts

| Script | EV3 equivalent | When to use |
|--------|----------------|-------------|
| `tools/watchdog/service-watchdog.js` | `service_watchdog.py` | Cron / Task Scheduler, every 5 min |
| `tools/watchdog/service-watcher.js` | `ev3_service_watcher.py` | Dedicated long-running process / Windows service |
| `tools/watchdog/setup-watchdog-task.ps1` | `SETUP_SCHEDULED_TASKS.ps1` | One-time Windows setup |

**npm scripts (root):**

```bash
npm run watchdog:check      # One-shot health check
npm run watchdog:watch      # Continuous watcher
```

---

## Reuse Checklist for Other Projects

When porting to a new project:

- [ ] **Health endpoint** — Add `GET /api/health` returning `{ status: 'ok' }`
- [ ] **Charge start timeout** — Timer after authorize/start if no energy flow
- [ ] **Stale session recovery** — Track active sessions + connection state; sweep on interval
- [ ] **Service polling** — HTTP + TCP checks for each critical dependency
- [ ] **Rate-limited restart** — Cooldown + max restarts/hour before auto-restart
- [ ] **Event log** — Ring buffer of watchdog actions for ops dashboard
- [ ] **External checker** — Script outside main process for crash survival
- [ ] **Env-driven autostart** — Dev off (`WATCHDOG_AUTOSTART=0`), prod on
- [ ] **Document thresholds** — Timeouts, intervals, and failure thresholds in `.env.example`

---

## EV3 → Stratacore Mapping

| EV3 component | Stratacore implementation |
|---------------|----------------------------|
| `service_watchdog.py` | `tools/watchdog/service-watchdog.js` |
| StrataSecure `watchdog_loop` | `ServiceWatchdogService` |
| `ev3_service_watcher.py` | `tools/watchdog/service-watcher.js` |
| `stale_session_monitor.py` | `StaleSessionWatchdogService` |
| `AutonomousHealthMonitor` | `HealthMonitorService` (lightweight) |
| Charging "no vehicle" timer | `ChargeStartWatchdogService` |
| StrataSecure `/api/watchdog` | `WatchdogController` |

---

## Files Changed in This Repo

- `apps/backend/src/modules/watchdog/*` — NestJS watchdog module
- `apps/backend/src/modules/health/health.controller.ts` — Health probe
- `apps/backend/src/modules/charging/charging.service.ts` — Uses watchdog services
- `apps/backend/src/app.module.ts` — Registers WatchdogModule
- `apps/backend/.env.example` — Watchdog env vars
- `tools/watchdog/*` — External scripts + config
- `watchdogs.md` — This document

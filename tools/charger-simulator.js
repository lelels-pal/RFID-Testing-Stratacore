/**
 * Virtual OCPP 1.6J Charge Point Simulator.
 *
 * Connects to the backend CSMS (SteveOcppAdapter on port 9220) as one or more
 * charge points so the full payment -> RemoteStart -> charging -> telemetry flow
 * can be tested end-to-end without physical hardware.
 *
 * Behaviour per charger:
 *   - Connects to ws://<host>:<port>/ocpp/<chargerId>
 *   - Stays idle (no BootNotification) so the kiosk QR screen is not disturbed.
 *     NOTE: the backend treats an "Available" StatusNotification as a completed
 *     session, so we intentionally stay quiet until a RemoteStart arrives.
 *   - On RemoteStartTransaction  -> replies Accepted, sends StartTransaction,
 *     then streams MeterValues every 2s with rising energy.
 *   - On RemoteStopTransaction   -> replies Accepted, sends StopTransaction.
 *
 * Usage:
 *   node tools/charger-simulator.js
 *   OCPP_HOST=localhost OCPP_PORT=9220 node tools/charger-simulator.js
 */

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const HOST = process.env.OCPP_HOST || 'localhost';
const PORT = process.env.OCPP_PORT || '9000';
const PATH = process.env.OCPP_PATH || '/ocpp';
const CHARGER_IDS = (process.env.CHARGER_IDS || 'BENY-002,BENY-001')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Optional auto-tap on connect, useful for demos/tests without typing commands.
// Format: SIM_AUTOTAP="BENY-001:RFID-ALPHA,BENY-002:RFID-LIMIT"
const AUTO_TAPS = new Map();
(process.env.SIM_AUTOTAP || '')
  .split(',')
  .map((pair) => pair.trim())
  .filter(Boolean)
  .forEach((pair) => {
    const [cid, card] = pair.split(':').map((s) => s.trim());
    if (cid && card) AUTO_TAPS.set(cid, card);
  });

const CALL = 2;
const CALLRESULT = 3;
const CALLERROR = 4;

// Simulated charging profile (~7.2 kW single-phase by default).
// Override with env vars, e.g. SIM_POWER_W=22000 SIM_TICK_MS=1000 for a faster demo.
const POWER_W = Number(process.env.SIM_POWER_W) || 7200;
const VOLTAGE_V = Number(process.env.SIM_VOLTAGE_V) || 230;
const CURRENT_A = Number(process.env.SIM_CURRENT_A) || Number((POWER_W / VOLTAGE_V).toFixed(1));
const TICK_MS = Number(process.env.SIM_TICK_MS) || 1000;
const WH_PER_TICK = (POWER_W * TICK_MS) / 1000 / 3600; // Wh delivered each tick

function startChargePoint(chargerId) {
  const url = `ws://${HOST}:${PORT}${PATH}/${chargerId}`;
  let ws;
  let meterTimer = null;
  let energyWh = 0;
  let transactionId = null;
  // Outstanding CALL requests awaiting a CALLRESULT, keyed by message id.
  const pending = new Map();

  function connect() {
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[SIM ${chargerId}] connected to ${url} (idle, awaiting RemoteStart)`);
      const autoCard = AUTO_TAPS.get(chargerId);
      if (autoCard) {
        setTimeout(() => physicalTap(autoCard), 1500);
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;

      const type = msg[0];
      if (type === CALL) {
        const [, uniqueId, action, payload] = msg;
        handleCall(uniqueId, action, payload || {});
      } else if (type === CALLRESULT) {
        const [, uniqueId, payload] = msg;
        const handler = pending.get(uniqueId);
        if (handler) {
          pending.delete(uniqueId);
          handler(payload);
        }
        if (payload && payload.transactionId != null) {
          transactionId = payload.transactionId;
        }
      } else if (type === CALLERROR) {
        console.warn(`[SIM ${chargerId}] CALLERROR:`, msg.slice(2));
      }
    });

    ws.on('close', () => {
      console.log(`[SIM ${chargerId}] disconnected. Reconnecting in 3s...`);
      stopMetering();
      setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
      console.error(`[SIM ${chargerId}] socket error: ${err.message}`);
    });
  }

  function send(arr) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(arr));
    }
  }

  const result = (uniqueId, payload) => send([CALLRESULT, uniqueId, payload]);
  const call = (action, payload, onResult) => {
    const uniqueId = randomUUID();
    if (onResult) pending.set(uniqueId, onResult);
    send([CALL, uniqueId, action, payload]);
  };

  // Simulate a driver physically tapping their RFID card on the charger.
  // Mirrors real OCPP hardware: Authorize first, and only start a transaction
  // if the central system accepts the card (active + quota remaining).
  function physicalTap(cardId, connectorId = 1) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log(`[SIM ${chargerId}] cannot tap: not connected.`);
      return;
    }
    if (transactionId != null || meterTimer) {
      console.log(`[SIM ${chargerId}] already has an active session. Stop it first.`);
      return;
    }
    console.log(`[SIM ${chargerId}] 🪪 Physical tap with card ${cardId} -> sending Authorize`);
    call('Authorize', { idTag: cardId }, (payload) => {
      const status = payload && payload.idTagInfo ? payload.idTagInfo.status : 'Unknown';
      if (status === 'Accepted') {
        console.log(`[SIM ${chargerId}] ✅ Authorize Accepted -> starting transaction`);
        energyWh = 0;
        transactionId = null;
        beginTransaction(connectorId, cardId);
      } else {
        console.log(`[SIM ${chargerId}] ⛔ Authorize ${status} -> charging denied (card blocked, invalid, or quota exhausted)`);
      }
    });
  }

  function handleCall(uniqueId, action, payload) {
    switch (action) {
      case 'RemoteStartTransaction': {
        console.log(`[SIM ${chargerId}] <- RemoteStartTransaction (idTag=${payload.idTag}) -> Accepted`);
        result(uniqueId, { status: 'Accepted' });
        const connectorId = payload.connectorId || 1;
        const idTag = payload.idTag || 'GUEST';
        energyWh = 0;
        transactionId = null;
        // Real chargers report Preparing, then the driver plugs in and a
        // StartTransaction follows. Simulate that short delay.
        setTimeout(() => beginTransaction(connectorId, idTag), 1500);
        break;
      }
      case 'RemoteStopTransaction': {
        console.log(`[SIM ${chargerId}] <- RemoteStopTransaction -> Accepted`);
        result(uniqueId, { status: 'Accepted' });
        endTransaction();
        break;
      }
      default:
        // Generic accept for anything else (Reset, ChangeConfiguration, etc.)
        result(uniqueId, { status: 'Accepted' });
    }
  }

  function beginTransaction(connectorId, idTag) {
    console.log(`[SIM ${chargerId}] -> StartTransaction`);
    call('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });

    stopMetering();
    meterTimer = setInterval(() => {
      energyWh += WH_PER_TICK;
      call('MeterValues', {
        connectorId,
        transactionId: transactionId != null ? transactionId : undefined,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              { measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: energyWh.toFixed(1) },
              { measurand: 'Power.Active.Import', unit: 'W', value: String(POWER_W) },
              { measurand: 'Current.Import', unit: 'A', value: String(CURRENT_A) },
              { measurand: 'Voltage', unit: 'V', value: String(VOLTAGE_V) },
            ],
          },
        ],
      });
    }, TICK_MS);
  }

  function endTransaction() {
    stopMetering();
    console.log(`[SIM ${chargerId}] -> StopTransaction (meterStop=${energyWh.toFixed(1)} Wh)`);
    call('StopTransaction', {
      transactionId: transactionId != null ? transactionId : undefined,
      meterStop: Math.round(energyWh),
      timestamp: new Date().toISOString(),
    });
    transactionId = null;
  }

  function stopMetering() {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  }

  connect();

  return {
    chargerId,
    tap: physicalTap,
    stop: endTransaction,
  };
}

console.log('==============================================');
console.log(' Stratacore Virtual Charge Point Simulator');
console.log(` Target CSMS : ws://${HOST}:${PORT}${PATH}`);
console.log(` Chargers    : ${CHARGER_IDS.join(', ')}`);
console.log('==============================================');
console.log(' Commands (type + Enter):');
console.log('   tap <chargerId> <cardId>   simulate a physical RFID tap on the charger');
console.log('   stop <chargerId>           stop the charger session locally');
console.log('   list                       list connected chargers');
console.log(` e.g.  tap ${CHARGER_IDS[0]} RFID-ALPHA`);
console.log('==============================================');

const points = new Map();
CHARGER_IDS.forEach((id) => points.set(id, startChargePoint(id)));

// Interactive command interface so a physical card tap can be tested without
// the kiosk. This exercises the OCPP Authorize -> StartTransaction path.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, arg1, arg2] = line.trim().split(/\s+/);
  if (!cmd) return;

  if (cmd === 'list') {
    console.log(`[SIM] Chargers: ${[...points.keys()].join(', ')}`);
    return;
  }

  if (cmd === 'tap') {
    const point = points.get(arg1);
    if (!point) {
      console.log(`[SIM] Unknown charger "${arg1}". Known: ${[...points.keys()].join(', ')}`);
      return;
    }
    if (!arg2) {
      console.log('[SIM] Usage: tap <chargerId> <cardId>');
      return;
    }
    point.tap(arg2);
    return;
  }

  if (cmd === 'stop') {
    const point = points.get(arg1);
    if (!point) {
      console.log(`[SIM] Unknown charger "${arg1}".`);
      return;
    }
    point.stop();
    return;
  }

  console.log(`[SIM] Unknown command "${cmd}". Try: tap, stop, list`);
});




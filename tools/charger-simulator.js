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
const CHARGER_IDS = (process.env.CHARGER_IDS || 'BENY-002')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const CALL = 2;
const CALLRESULT = 3;
const CALLERROR = 4;

// Simulated charging profile (~7.2 kW single-phase)
const POWER_W = 7200;
const VOLTAGE_V = 230;
const CURRENT_A = 31.3;
const TICK_MS = 2000;
const WH_PER_TICK = (POWER_W * TICK_MS) / 1000 / 3600; // Wh delivered each tick

function startChargePoint(chargerId) {
  const url = `ws://${HOST}:${PORT}${PATH}/${chargerId}`;
  let ws;
  let meterTimer = null;
  let energyWh = 0;
  let transactionId = null;

  function connect() {
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[SIM ${chargerId}] connected to ${url} (idle, awaiting RemoteStart)`);
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
        const [, , payload] = msg;
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
  const call = (action, payload) => send([CALL, randomUUID(), action, payload]);

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
}

console.log('==============================================');
console.log(' Stratacore Virtual Charge Point Simulator');
console.log(` Target CSMS : ws://${HOST}:${PORT}${PATH}`);
console.log(` Chargers    : ${CHARGER_IDS.join(', ')}`);
console.log('==============================================');

CHARGER_IDS.forEach(startChargePoint);




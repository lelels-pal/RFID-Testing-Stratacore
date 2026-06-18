import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createHash, randomBytes, createHmac } from 'crypto';
import jwt from 'jsonwebtoken';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const PORT = Number(process.env.PORT) || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_ephemeral_jwt_key_1234';
const PAYNAMICS_WEBHOOK_SECRET = process.env.PAYNAMICS_WEBHOOK_SECRET || 'paynamics_webhook_signing_secret_key';
const GUEST_APP_URL = process.env.GUEST_APP_URL;

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY REDIS MOCK (TTL-aware key/value store)
// ═══════════════════════════════════════════════════════════════
interface RedisEntry { value: string; expiresAt: number; }
const redisStore = new Map<string, RedisEntry>();

function redisGet(key: string): string | null {
  const entry = redisStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { redisStore.delete(key); return null; }
  return entry.value;
}
function redisSet(key: string, value: string, ttlSeconds?: number): void {
  const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity;
  redisStore.set(key, { value, expiresAt });
}
function redisDel(key: string): void { redisStore.delete(key); }

function inferRequestOrigin(req: Request): string {
  const originHeader = req.get('origin');
  if (originHeader) return originHeader;

  const refererHeader = req.get('referer');
  if (refererHeader) {
    try {
      const refererUrl = new URL(refererHeader);
      return `${refererUrl.protocol}//${refererUrl.host}`;
    } catch {
      // Ignore malformed referer and fall back to host headers.
    }
  }

  const protocol = req.protocol || 'http';
  const forwardedHost = req.get('x-forwarded-host');
  const host = forwardedHost || req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function buildGuestClaimUrl(req: Request, rawToken: string): string {
  if (GUEST_APP_URL) {
    return `${GUEST_APP_URL.replace(/\/$/, '')}/claim?token=${rawToken}`;
  }

  const requestOrigin = inferRequestOrigin(req);
  const requestUrl = new URL(requestOrigin);
  return `${requestUrl.protocol}//${requestUrl.hostname}:3002/claim?token=${rawToken}`;
}

// ═══════════════════════════════════════════════════════════════
// MOCK OCPP / STEVE CSMS ADAPTER
// ═══════════════════════════════════════════════════════════════
type ChargerStatus = 'Available' | 'Preparing' | 'Charging' | 'SuspendedEVSE' | 'SuspendedEV' | 'Finishing' | 'Faulted' | 'Unavailable';

interface ChargerRecord { status: ChargerStatus; activeTransactionId?: number; }
const mockChargers = new Map<string, ChargerRecord>();
mockChargers.set('CP-MNL-001', { status: 'Available' });
mockChargers.set('CP-MNL-002', { status: 'Available' });

async function ocppRemoteStart(chargerId: string, connectorId: number, idTag: string) {
  console.log(`[OCPP] RemoteStartTransaction → charger=${chargerId} conn=${connectorId} idTag=${idTag}`);
  await delay(600); // simulate network
  const cp = mockChargers.get(chargerId);
  if (!cp) return { success: false, status: 'Unknown' as const, errorMessage: `Charger ${chargerId} not registered.` };
  if (cp.status !== 'Available' && cp.status !== 'Preparing') {
    return { success: false, status: 'Rejected' as const, errorMessage: `Charger in state: ${cp.status}` };
  }
  const txId = Math.floor(Math.random() * 1000000);
  mockChargers.set(chargerId, { status: 'Preparing', activeTransactionId: txId });
  return { success: true, status: 'Accepted' as const, transactionId: String(txId) };
}

async function ocppRemoteStop(chargerId: string, transactionId: number) {
  console.log(`[OCPP] RemoteStopTransaction → charger=${chargerId} tx=${transactionId}`);
  await delay(400);
  const cp = mockChargers.get(chargerId);
  if (!cp) return { success: false, status: 'Unknown' as const, errorMessage: `Charger ${chargerId} not found.` };
  mockChargers.set(chargerId, { status: 'Available' });
  return { success: true, status: 'Accepted' as const };
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET EVENT NAMES (mirrors @packages/shared)
// ═══════════════════════════════════════════════════════════════
const WsEvents = {
  SESSION_CLAIMED:   'session:claimed',
  PAYMENT_PENDING:   'payment:pending',
  PAYMENT_APPROVED:  'payment:approved',
  CHARGER_PREPARING: 'charger:preparing',
  CHARGER_STARTING:  'charger:starting',
  METER_UPDATE:      'charger:meter_update',
  SESSION_COMPLETED: 'session:completed',
  SESSION_ERROR:     'session:error',
  SUBSCRIBE_CHARGER: 'subscribe:charger',
};

// ═══════════════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO BOOTSTRAP
// ═══════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

// Track active telemetry intervals
const telemetryIntervals = new Map<string, NodeJS.Timeout>();

// ───────────────────────────────────────────────────────────────
// WebSocket Connection Handling
// ───────────────────────────────────────────────────────────────
io.on('connection', (socket: Socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  socket.on(WsEvents.SUBSCRIBE_CHARGER, (data: { chargerId: string }) => {
    const room = `charger_room:${data.chargerId}`;
    socket.join(room);
    console.log(`[WS] ${socket.id} joined room ${room}`);
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

// ── POST /api/v1/session/initiate ─────────────────────────────
// Called by the Physical Kiosk to generate an ephemeral QR token
app.post('/api/v1/session/initiate', (req: Request, res: Response) => {
  const { chargerId, connectorId } = req.body;
  if (!chargerId || connectorId === undefined) {
    res.status(400).json({ error: 'chargerId and connectorId are required.' });
    return;
  }

  const rawToken = randomBytes(32).toString('hex');
  const hashedKey = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 120_000); // 2 minutes

  redisSet(`qr:${hashedKey}`, JSON.stringify({ chargerId, connectorId, createdAt: Date.now() }), 120);

  const qrUrl = buildGuestClaimUrl(req, rawToken);
  console.log(`[Auth] QR initiated for ${chargerId}. Token: ${rawToken.slice(0, 8)}...`);

  res.json({ qrToken: rawToken, qrUrl, expiresAt: expiresAt.toISOString(), chargerId, connectorId });
});

// ── POST /api/v1/session/verify ───────────────────────────────
// Called by the Guest Mobile App after scanning the QR code
app.post('/api/v1/session/verify', (req: Request, res: Response) => {
  const { qrToken } = req.body;
  const fingerprint = req.headers['x-device-fingerprint'] as string;

  if (!qrToken) { res.status(400).json({ error: 'qrToken is required.' }); return; }
  if (!fingerprint) { res.status(400).json({ error: 'x-device-fingerprint header missing.' }); return; }

  const hashedKey = createHash('sha256').update(qrToken).digest('hex');
  const redisKey = `qr:${hashedKey}`;
  const dataRaw = redisGet(redisKey);

  if (!dataRaw) {
    console.log(`[Auth] Verify FAILED – token expired or already consumed.`);
    res.status(401).json({ error: 'QR Code is invalid or has expired.' });
    return;
  }

  // ⚡ Atomic consume – single-use guarantee
  redisDel(redisKey);

  const { chargerId, connectorId } = JSON.parse(dataRaw);
  console.log(`[Auth] QR verified for ${chargerId}. Notifying Kiosk via WS.`);

  // Notify the Kiosk Screen via WS
  io.to(`charger_room:${chargerId}`).emit(WsEvents.SESSION_CLAIMED, {
    chargerId, connectorId, claimedAt: new Date().toISOString(),
  });

  // Generate JWT bound to device fingerprint
  const hashedFP = createHash('sha256').update(fingerprint).digest('hex');
  const accessToken = jwt.sign({ chargerId, connectorId, claimSignature: hashedFP }, JWT_SECRET, { expiresIn: '1h' });

  res.json({ accessToken, chargerId, connectorId, status: 'Preparing' });
});

// ── POST /api/v1/charging/checkout ────────────────────────────
// Called by the Guest App with JWT to create a Paynamics checkout
app.post('/api/v1/charging/checkout', (req: Request, res: Response) => {
  const authHeader = req.headers['authorization'] as string;
  const fingerprint = req.headers['x-device-fingerprint'] as string;

  if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'Auth token missing.' }); return; }
  if (!fingerprint) { res.status(400).json({ error: 'x-device-fingerprint header missing.' }); return; }

  // Validate JWT + fingerprint binding
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const currentFP = createHash('sha256').update(fingerprint).digest('hex');
    if (decoded.claimSignature !== currentFP) {
      res.status(401).json({ error: 'Session binding validation failed.' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Invalid or expired guest session.' });
    return;
  }

  const { chargerId, connectorId, tariffPlanId } = req.body;
  const checkoutId = `pnx_tx_${Math.floor(Math.random() * 1_000_000)}`;
  const redirectUrl = `https://www.paynamics.net/webpaymentservice/checkout/${checkoutId}/simulate`;

  redisSet(`checkout:${checkoutId}`, JSON.stringify({ chargerId, connectorId, tariffPlanId, status: 'PENDING' }), 600);
  console.log(`[Payment] Checkout created: ${checkoutId} for ${chargerId}`);

  res.json({ checkoutId, redirectUrl });
});

// ── POST /api/v1/payments/paynamics-webhook ───────────────────
// Called by Paynamics (or simulated by the guest app for demo)
app.post('/api/v1/payments/paynamics-webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-paynamics-signature'] as string;
  const payload = req.body;

  if (!signature) { res.status(400).json({ error: 'Webhook signature missing.' }); return; }

  console.log(`[Payment] Paynamics notification received. ID: ${payload.id}, Status: ${payload.status}`);

  // Validate checkout session exists
  const checkoutKey = `checkout:${payload.id}`;
  const checkoutRaw = redisGet(checkoutKey);
  if (!checkoutRaw) {
    console.log(`[Payment] Checkout session not found: ${payload.id}`);
    res.status(400).json({ error: 'Checkout session not found.' });
    return;
  }

  const checkoutData = JSON.parse(checkoutRaw);

  if (payload.status === 'PAYMENT_SUCCESS') {
    console.log(`[Payment] ✅ Payment confirmed for ${payload.id}. Triggering RemoteStart.`);

    redisSet(`payment_status:${payload.id}`, 'SUCCESS', 3600);
    redisDel(checkoutKey);

    // Notify WS clients
    io.to(`charger_room:${checkoutData.chargerId}`).emit(WsEvents.PAYMENT_APPROVED, {
      chargerId: checkoutData.chargerId,
      connectorId: checkoutData.connectorId,
      paymentId: payload.id,
    });

    // Trigger OCPP RemoteStart asynchronously
    triggerRemoteStartFlow(checkoutData.chargerId, checkoutData.connectorId, payload.id).catch(err => {
      console.error(`[OCPP] RemoteStart failed:`, err);
    });

    res.json({ status: 'PROCESSED' });
  } else {
    res.json({ status: 'IGNORED' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CHARGING ORCHESTRATION
// ═══════════════════════════════════════════════════════════════
async function triggerRemoteStartFlow(chargerId: string, connectorId: number, paymentId: string) {
  const idTag = `GUEST-${paymentId.slice(-8).toUpperCase()}`;
  const result = await ocppRemoteStart(chargerId, connectorId, idTag);

  if (!result.success || result.status !== 'Accepted') {
    console.log(`[OCPP] Remote start REJECTED: ${result.errorMessage}`);
    io.to(`charger_room:${chargerId}`).emit(WsEvents.SESSION_ERROR, {
      chargerId,
      connectorId,
      message: result.errorMessage || 'Charger remote start rejected.',
    });
    return;
  }

  console.log(`[OCPP] Remote start ACCEPTED. TxId: ${result.transactionId}`);

  // Notify: Preparing – "Plug in your vehicle"
  io.to(`charger_room:${chargerId}`).emit(WsEvents.CHARGER_PREPARING, {
    chargerId, connectorId,
    message: 'Remote start accepted. Please plug the cable into your vehicle.',
  });

  // Simulate plug-in delay, then start telemetry loop
  await delay(3000);
  startTelemetryLoop(chargerId, connectorId, paymentId);
}

function startTelemetryLoop(chargerId: string, connectorId: number, paymentId: string) {
  console.log(`[Telemetry] Starting live meter stream for ${chargerId}`);

  // Broadcast: Charging Started
  io.to(`charger_room:${chargerId}`).emit(WsEvents.CHARGER_STARTING, {
    chargerId, connectorId, message: 'Charger activated. Power flow started.',
  });

  let energyKwh = 0.0;
  let secondsElapsed = 0;
  const rateKw = 7.4;
  const voltage = 230;
  const current = 32;
  const pricePerKwh = 15.0; // PHP

  const intervalKey = `${chargerId}:${paymentId}`;

  const interval = setInterval(async () => {
    secondsElapsed += 2;
    energyKwh += (rateKw * 2) / 3600;
    const estimatedCost = energyKwh * pricePerKwh;

    const telemetry = {
      chargerId,
      connectorId,
      sessionId: paymentId,
      timestamp: new Date().toISOString(),
      powerKw: rateKw,
      energyDeliveredKwh: parseFloat(energyKwh.toFixed(4)),
      durationSeconds: secondsElapsed,
      currentAmps: current,
      voltageVolts: voltage,
      estimatedCost: parseFloat(estimatedCost.toFixed(2)),
    };

    io.to(`charger_room:${chargerId}`).emit(WsEvents.METER_UPDATE, telemetry);

    // Auto-stop after 0.1 kWh for demo
    if (energyKwh >= 0.1) {
      console.log(`[Telemetry] Demo threshold reached (0.1 kWh). Stopping.`);
      clearInterval(interval);
      telemetryIntervals.delete(intervalKey);

      await ocppRemoteStop(chargerId, 999999);
      mockChargers.set(chargerId, { status: 'Available' });

      io.to(`charger_room:${chargerId}`).emit(WsEvents.SESSION_COMPLETED, {
        chargerId, connectorId,
        message: 'Charging session completed successfully.',
        totalKwh: parseFloat(energyKwh.toFixed(4)),
        totalCost: parseFloat(estimatedCost.toFixed(2)),
      });
    }
  }, 2000);

  telemetryIntervals.set(intervalKey, interval);
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════
httpServer.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  STRATACORE EV CHARGING BACKEND              ║`);
  console.log(`║  API:  http://localhost:${PORT}               ║`);
  console.log(`║  WS:   ws://localhost:${PORT}                 ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`Mock Chargers: CP-MNL-001, CP-MNL-002 (Status: Available)`);
  console.log(`Endpoints:`);
  console.log(`  POST /api/v1/session/initiate`);
  console.log(`  POST /api/v1/session/verify`);
  console.log(`  POST /api/v1/charging/checkout`);
  console.log(`  POST /api/v1/payments/paynamics-webhook`);
  console.log(`  GET  /health\n`);
});

'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';

// ─── Inline shared constants (mirrors @packages/shared) ───
const WsEvents = {
  SESSION_CLAIMED:   'session:claimed',
  PAYMENT_APPROVED:  'payment:approved',
  CHARGER_PREPARING: 'charger:preparing',
  CHARGER_STARTING:  'charger:starting',
  METER_UPDATE:      'charger:meter_update',
  SESSION_COMPLETED: 'session:completed',
  SESSION_ERROR:     'session:error',
  SUBSCRIBE_CHARGER: 'subscribe:charger',
};

interface MeterUpdate {
  chargerId: string;
  connectorId: number;
  sessionId: string;
  timestamp: string;
  powerKw: number;
  energyDeliveredKwh: number;
  durationSeconds: number;
  currentAmps: number;
  voltageVolts: number;
  estimatedCost: number;
}

// ─── Config ───
function getBackendUrl() {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) return process.env.NEXT_PUBLIC_BACKEND_URL;
  if (typeof window !== 'undefined') return `${window.location.protocol}//${window.location.hostname}:4001`;
  return 'http://localhost:4001';
}

function GuestAppContent() {
  const searchParams = useSearchParams();
  const tokenFromUrl = searchParams.get('token') || '';
  const backendUrl = getBackendUrl();

  const [step, setStep] = useState<'HANDSHAKE' | 'SELECT_PLAN' | 'PAYING' | 'CHARGING' | 'COMPLETED' | 'ERROR'>('HANDSHAKE');
  const [chargerId, setChargerId] = useState('');
  const [connectorId, setConnectorId] = useState(0);
  const [accessToken, setAccessToken] = useState('');
  const [checkoutId, setCheckoutId] = useState('');
  const [statusMessage, setStatusMessage] = useState('Validating Charger Link...');
  const [telemetry, setTelemetry] = useState<MeterUpdate | null>(null);

  const getFingerprint = () => {
    if (typeof window === 'undefined') return 'server';
    return `${navigator.userAgent}-${window.screen.width}x${window.screen.height}`;
  };

  useEffect(() => {
    if (tokenFromUrl) {
      setStatusMessage('Charger QR code detected. Press button below to claim charger.');
    } else {
      setStep('ERROR');
      setStatusMessage('Invalid QR Code. Please scan the QR displayed on the Physical Kiosk screen.');
    }
  }, [tokenFromUrl]);

  const claimCharger = async () => {
    try {
      setStatusMessage('Claiming session...');
      const response = await fetch(`${backendUrl}/api/v1/session/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': getFingerprint() },
        body: JSON.stringify({ qrToken: tokenFromUrl }),
      });

      if (!response.ok) throw new Error('Token verification rejected. The QR might have expired.');

      const data = await response.json();
      setAccessToken(data.accessToken);
      setChargerId(data.chargerId);
      setConnectorId(data.connectorId);

      const s: Socket = io(backendUrl);
      s.on('connect', () => { s.emit(WsEvents.SUBSCRIBE_CHARGER, { chargerId: data.chargerId }); });
      s.on(WsEvents.PAYMENT_APPROVED, () => { setStep('CHARGING'); setStatusMessage('Payment cleared. Initializing charger power...'); });
      s.on(WsEvents.CHARGER_PREPARING, (msg: { message: string }) => { setStep('CHARGING'); setStatusMessage(msg.message || 'Connecting to EV...'); });
      s.on(WsEvents.CHARGER_STARTING, () => { setStep('CHARGING'); setStatusMessage('Charging Active'); });
      s.on(WsEvents.METER_UPDATE, (metrics: MeterUpdate) => { setTelemetry(metrics); });
      s.on(WsEvents.SESSION_COMPLETED, () => { setStep('COMPLETED'); setStatusMessage('Session Completed.'); });
      s.on(WsEvents.SESSION_ERROR, (msg: { message?: string }) => {
        setStep('ERROR');
        setStatusMessage(msg?.message || 'The charger could not start the session. Please contact the Admin office.');
      });

      setStep('SELECT_PLAN');
    } catch (err) {
      setStep('ERROR');
      setStatusMessage((err as Error).message || 'Failed to claim charger.');
    }
  };

  const checkoutPlan = async (tariffPlanId: string) => {
    try {
      setStatusMessage('Creating payment checkout...');
      const response = await fetch(`${backendUrl}/api/v1/charging/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'x-device-fingerprint': getFingerprint() },
        body: JSON.stringify({ chargerId, connectorId, tariffPlanId }),
      });
      const data = await response.json();
      setCheckoutId(data.checkoutId);
      setStep('PAYING');
      setStatusMessage('Simulating Paynamics Gateway');
    } catch {
      setStep('ERROR');
      setStatusMessage('Failed to create payment checkout.');
    }
  };

  const triggerMockPaymentWebhook = async () => {
    try {
      setStatusMessage('Submitting payment notification...');
      const payload = { id: checkoutId, status: 'PAYMENT_SUCCESS', metadata: { chargerId, connectorId } };

      const response = await fetch(`${backendUrl}/api/v1/payments/paynamics-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paynamics-signature': 'mock_sha256_sig_valid_matching_secret_hmac' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error('Notification process failed.');
      setStatusMessage('Payment confirmed. Waiting for charging sequence...');
    } catch {
      setStep('ERROR');
      setStatusMessage('Paynamics notification simulation failed.');
    }
  };

  const [isStopping, setIsStopping] = useState(false);

  const stopCharging = async () => {
    try {
      setIsStopping(true);
      setStatusMessage('Stopping charging session...');
      const response = await fetch(`${backendUrl}/api/v1/charging/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'x-device-fingerprint': getFingerprint(),
        },
        body: JSON.stringify({ transactionId: telemetry ? Number(telemetry.sessionId) || undefined : undefined }),
      });
      if (!response.ok) throw new Error('Stop request was rejected by the charger.');
      // SESSION_COMPLETED will arrive via WebSocket and move us to the finished screen.
    } catch (err) {
      setStatusMessage((err as Error).message || 'Failed to stop charging.');
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.logo}>STRATACORE <span style={styles.logoSub}>GUEST</span></div>
      </header>

      <main style={styles.main}>
        {step === 'HANDSHAKE' && (
          <div style={styles.card}>
            <div style={styles.icon}>🔋</div>
            <h1 style={styles.title}>Secure Handshake</h1>
            <p style={styles.subtitle}>{statusMessage}</p>
            {tokenFromUrl && <button style={styles.btn} onClick={claimCharger}>Claim Charger</button>}
          </div>
        )}

        {step === 'SELECT_PLAN' && (
          <div style={styles.card}>
            <h1 style={styles.title}>Select Charging Plan</h1>
            <p style={styles.subtitle}>Charger ID: {chargerId} (Connector #{connectorId})</p>
            <div style={styles.plansContainer}>
              <button style={styles.planBtn} onClick={() => checkoutPlan('PREPAID_15KWH')}>
                <div style={styles.planTitle}>Quick Charge (15 kWh)</div>
                <div style={styles.planPrice}>₱225.00</div>
                <div style={styles.planLabel}>~100km Range | AC Standard</div>
              </button>
              <button style={styles.planBtn} onClick={() => checkoutPlan('PREPAID_30KWH')}>
                <div style={styles.planTitle}>Full Charge (30 kWh)</div>
                <div style={styles.planPrice}>₱450.00</div>
                <div style={styles.planLabel}>~200km Range | AC Extended</div>
              </button>
            </div>
          </div>
        )}

        {step === 'PAYING' && (
          <div style={styles.card}>
            <h1 style={styles.title}>Paynamics Checkout</h1>
            <p style={styles.subtitle}>Reference: {checkoutId}</p>
            <p style={styles.infoText}>Click below to simulate a successful Paynamics payment notification.</p>
            <button style={styles.payBtn} onClick={triggerMockPaymentWebhook}>
              Simulate Payment Success (Paynamics)
            </button>
          </div>
        )}

        {step === 'CHARGING' && (
          <div style={styles.card}>
            <h1 style={{...styles.title, color: '#e2790d'}}>Live Charger Status</h1>
            <p style={styles.subtitle}>{statusMessage}</p>

            {telemetry ? (
              <div style={styles.telemetryContainer}>
                <div style={styles.progressCircle}>
                  <div style={styles.progressVal}>{telemetry.energyDeliveredKwh.toFixed(3)}</div>
                  <div style={styles.progressLabel}>kWh</div>
                </div>
                <div style={styles.stats}>
                  <div style={styles.statRow}><span style={styles.statLabel}>Cost:</span><span style={styles.statValue}>₱{telemetry.estimatedCost.toFixed(2)}</span></div>
                  <div style={styles.statRow}><span style={styles.statLabel}>Duration:</span><span style={styles.statValue}>{Math.floor(telemetry.durationSeconds / 60)}m {telemetry.durationSeconds % 60}s</span></div>
                  <div style={styles.statRow}><span style={styles.statLabel}>Power:</span><span style={styles.statValue}>{telemetry.powerKw} kW</span></div>
                  <div style={styles.statRow}><span style={styles.statLabel}>Current:</span><span style={styles.statValue}>{telemetry.currentAmps}A @ {telemetry.voltageVolts}V</span></div>
                </div>
              </div>
            ) : (
              <div style={styles.waitingTelemetry}>
                <div style={styles.pulseNode} />
                <p>Waiting for OCPP RemoteStartTransaction response...</p>
              </div>
            )}

            {telemetry && (
              <button style={styles.stopBtn} onClick={stopCharging} disabled={isStopping}>
                {isStopping ? 'Stopping…' : 'Stop Charging'}
              </button>
            )}
          </div>
        )}

        {step === 'COMPLETED' && (
          <div style={styles.card}>
            <div style={styles.successIcon}>✓</div>
            <h1 style={styles.title}>Session Finished</h1>
            <p style={styles.subtitle}>Payment successfully processed. Charger unplugged.</p>
            <p style={styles.infoText}>A digital audit receipt has been logged.</p>
          </div>
        )}

        {step === 'ERROR' && (
          <div style={{...styles.card, borderColor: '#d2290f'}}>
            <h1 style={{...styles.title, color: '#d2290f'}}>Error</h1>
            <p style={styles.subtitle}>{statusMessage}</p>
            <button style={styles.btn} onClick={() => window.location.reload()}>Retry Link</button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function GuestAppPage() {
  return (
    <Suspense fallback={<div style={{ color: '#fff', textAlign: 'center', marginTop: 100 }}>Loading application...</div>}>
      <GuestAppContent />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { backgroundColor: '#000000', color: '#fff', fontFamily: '"Inter", "Outfit", sans-serif', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 20 },
  header: { width: '100%', maxWidth: 450, display: 'flex', justifyContent: 'center', padding: '15px 0', borderBottom: '1px solid #2a2a2a', marginBottom: 30 },
  logo: { fontSize: 20, fontWeight: 800, letterSpacing: 1, color: '#e2790d' },
  logoSub: { color: '#fff', fontWeight: 300 },
  main: { width: '100%', maxWidth: 450 },
  card: { backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: 16, padding: '30px 20px', textAlign: 'center' as const, boxShadow: '0 8px 20px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center' },
  icon: { fontSize: 50, marginBottom: 15 },
  title: { fontSize: 24, fontWeight: 700, marginBottom: 10 },
  subtitle: { color: '#9ca3af', fontSize: 14, lineHeight: 1.5, marginBottom: 25 },
  infoText: { color: '#9ca3af', fontSize: 13, lineHeight: 1.5, marginBottom: 20 },
  btn: { backgroundColor: '#e2790d', color: '#000000', border: 'none', borderRadius: 30, padding: '12px 30px', fontWeight: 700, cursor: 'pointer', width: '100%' },
  payBtn: { backgroundColor: '#56ce55', color: '#000000', border: 'none', borderRadius: 30, padding: '14px 20px', fontWeight: 700, cursor: 'pointer', width: '100%', boxShadow: '0 4px 10px rgba(86,206,85,0.3)' },
  plansContainer: { width: '100%', display: 'flex', flexDirection: 'column' as const, gap: 15 },
  planBtn: { backgroundColor: '#1c1c1c', border: '1px solid rgba(226,121,13,0.3)', borderRadius: 10, padding: 15, textAlign: 'left' as const, color: '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column' as const },
  planTitle: { fontSize: 15, fontWeight: 600, marginBottom: 4 },
  planPrice: { fontSize: 20, fontWeight: 800, color: '#e2790d', marginBottom: 6 },
  planLabel: { fontSize: 11, color: '#9ca3af' },
  telemetryContainer: { width: '100%' },
  progressCircle: { width: 140, height: 140, border: '4px solid #e2790d', borderRadius: '50%', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', margin: '0 auto 30px auto', boxShadow: '0 0 15px rgba(226,121,13,0.25)' },
  progressVal: { fontSize: 32, fontWeight: 800, color: '#e2790d' },
  progressLabel: { fontSize: 12, color: '#9ca3af', fontWeight: 500 },
  stats: { width: '100%', textAlign: 'left' as const },
  statRow: { display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #2a2a2a' },
  statLabel: { color: '#9ca3af', fontSize: 13 },
  statValue: { fontWeight: 600, fontSize: 14 },
  waitingTelemetry: { padding: '30px 0', color: '#9ca3af', fontSize: 13, textAlign: 'center' as const },
  pulseNode: { width: 12, height: 12, backgroundColor: '#e2790d', borderRadius: '50%', margin: '0 auto 15px auto' },
  successIcon: { fontSize: 50, color: '#56ce55', marginBottom: 15 },
  stopBtn: { marginTop: 24, backgroundColor: '#d2290f', color: '#fff', border: 'none', borderRadius: 30, padding: '14px 20px', fontWeight: 700, fontSize: 15, cursor: 'pointer', width: '100%', boxShadow: '0 4px 12px rgba(210,41,15,0.35)' },
};

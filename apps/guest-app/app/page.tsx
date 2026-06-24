'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { getApiBaseUrl } from '@packages/shared';

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

type Step = 'HANDSHAKE' | 'SELECT_PLAN' | 'PAYING' | 'CHARGING' | 'COMPLETED' | 'ERROR';

const STEP_ORDER: Step[] = ['HANDSHAKE', 'SELECT_PLAN', 'PAYING', 'CHARGING', 'COMPLETED'];

function getBackendUrl() {
  return getApiBaseUrl({
    envUrl: process.env.NEXT_PUBLIC_BACKEND_URL,
    origin:
      typeof window !== 'undefined'
        ? { protocol: window.location.protocol, hostname: window.location.hostname }
        : undefined,
  });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function StepIndicator({ current }: { current: Step }) {
  if (current === 'ERROR') return null;

  const currentIdx = STEP_ORDER.indexOf(current);

  return (
    <div className="step-track" aria-label="Charging progress">
      {STEP_ORDER.map((step, i) => (
        <React.Fragment key={step}>
          <div
            className={`step-dot ${i < currentIdx ? 'done' : ''} ${i === currentIdx ? 'active' : ''}`}
            aria-current={i === currentIdx ? 'step' : undefined}
          >
            {i < currentIdx ? '✓' : i + 1}
          </div>
          {i < STEP_ORDER.length - 1 && (
            <div className={`step-line ${i < currentIdx ? 'done' : ''}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function EnergyGauge({ kwh, maxKwh = 30 }: { kwh: number; maxKwh?: number }) {
  const pct = Math.min(kwh / maxKwh, 1);
  const circumference = 2 * Math.PI * 45;
  const offset = circumference * (1 - pct);

  return (
    <div className="gauge-wrap">
      <svg className="gauge-ring" width="160" height="160" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="45" fill="none" stroke="#2a2a2a" strokeWidth="6" />
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="#e2790d"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="gauge-center">
        <div className="gauge-value">{kwh.toFixed(2)}</div>
        <div className="gauge-unit">kWh delivered</div>
      </div>
    </div>
  );
}

function GuestAppContent() {
  const searchParams = useSearchParams();
  const tokenFromUrl = searchParams.get('token') || '';
  const backendUrl = getBackendUrl();

  const [step, setStep] = useState<Step>('HANDSHAKE');
  const [chargerId, setChargerId] = useState('');
  const [connectorId, setConnectorId] = useState(0);
  const [accessToken, setAccessToken] = useState('');
  const [checkoutId, setCheckoutId] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [statusMessage, setStatusMessage] = useState('Scan detected — ready to connect');
  const [telemetry, setTelemetry] = useState<MeterUpdate | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  const getFingerprint = () => {
    if (typeof window === 'undefined') return 'server';
    return `${navigator.userAgent}-${window.screen.width}x${window.screen.height}`;
  };

  useEffect(() => {
    if (tokenFromUrl) {
      setStatusMessage('Your charger link is valid. Tap below to get started.');
    } else {
      setStep('ERROR');
      setStatusMessage('No charger link found. Please scan the QR code on the kiosk screen.');
    }
  }, [tokenFromUrl]);

  const claimCharger = async () => {
    try {
      setIsClaiming(true);
      setStatusMessage('Connecting to charger…');
      const response = await fetch(`${backendUrl}/api/v1/session/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': getFingerprint() },
        body: JSON.stringify({ qrToken: tokenFromUrl }),
      });

      if (!response.ok) throw new Error('This link may have expired. Please scan the QR code again.');

      const data = await response.json();
      setAccessToken(data.accessToken);
      setChargerId(data.chargerId);
      setConnectorId(data.connectorId);

      const s: Socket = io(backendUrl);
      s.on('connect', () => { s.emit(WsEvents.SUBSCRIBE_CHARGER, { chargerId: data.chargerId }); });
      s.on(WsEvents.PAYMENT_APPROVED, () => {
        setStep('CHARGING');
        setStatusMessage('Payment confirmed — starting your session');
      });
      s.on(WsEvents.CHARGER_PREPARING, (msg: { message: string }) => {
        setStep('CHARGING');
        setStatusMessage(msg.message || 'Plug in your vehicle to begin');
      });
      s.on(WsEvents.CHARGER_STARTING, () => {
        setStep('CHARGING');
        setStatusMessage('Charging in progress');
      });
      s.on(WsEvents.METER_UPDATE, (metrics: MeterUpdate) => { setTelemetry(metrics); });
      s.on(WsEvents.SESSION_COMPLETED, () => {
        setStep('COMPLETED');
        setStatusMessage('Your session is complete');
      });
      s.on(WsEvents.SESSION_ERROR, (msg: { message?: string }) => {
        setStep('ERROR');
        setStatusMessage(msg?.message || 'The charger could not start. Please contact station staff.');
      });

      setStep('SELECT_PLAN');
    } catch (err) {
      setStep('ERROR');
      setStatusMessage((err as Error).message || 'Could not connect to the charger.');
    } finally {
      setIsClaiming(false);
    }
  };

  const checkoutPlan = async (tariffPlanId: string) => {
    try {
      setSelectedPlan(tariffPlanId);
      setIsCheckingOut(true);
      setStatusMessage('Setting up secure checkout…');
      const response = await fetch(`${backendUrl}/api/v1/charging/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-device-fingerprint': getFingerprint(),
        },
        body: JSON.stringify({ chargerId, connectorId, tariffPlanId }),
      });
      if (!response.ok) throw new Error('Checkout failed');
      const data = await response.json();
      setCheckoutId(data.checkoutId);
      setRedirectUrl(data.redirectUrl || '');
      setStep('PAYING');
      setStatusMessage('Complete payment to unlock charging');
    } catch {
      setStep('ERROR');
      setStatusMessage('Could not start checkout. Please try again.');
    } finally {
      setIsCheckingOut(false);
    }
  };

  const stopCharging = async () => {
    try {
      setIsStopping(true);
      setStatusMessage('Stopping session…');
      const response = await fetch(`${backendUrl}/api/v1/charging/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-device-fingerprint': getFingerprint(),
        },
        body: JSON.stringify({ transactionId: telemetry ? Number(telemetry.sessionId) || undefined : undefined }),
      });
      if (!response.ok) throw new Error('Stop request was rejected.');
    } catch (err) {
      setStatusMessage((err as Error).message || 'Could not stop charging.');
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="guest-app">
      <header className="guest-header">
        <div className="guest-logo">
          STRATACORE <span className="guest-logo-sub">CHARGE</span>
        </div>
      </header>

      <main className="guest-main">
        <StepIndicator current={step} />

        {step === 'HANDSHAKE' && (
          <div className="card">
            <div className="card-icon">⚡</div>
            <h1 className="card-title">Ready to Charge</h1>
            <p className="card-subtitle">{statusMessage}</p>
            {tokenFromUrl && (
              <button
                className="btn btn-primary"
                onClick={claimCharger}
                disabled={isClaiming}
              >
                {isClaiming ? (
                  <>
                    <span className="spinner" aria-hidden />
                    Connecting…
                  </>
                ) : (
                  'Connect to Charger'
                )}
              </button>
            )}
          </div>
        )}

        {step === 'SELECT_PLAN' && (
          <div className="card">
            <h1 className="card-title">Choose Your Plan</h1>
            <div className="charger-badge">
              Charger <strong>{chargerId}</strong> · Connector #{connectorId}
            </div>
            <p className="card-subtitle" style={{ marginBottom: 16 }}>
              Select a prepaid package. Charging starts automatically after payment.
            </p>

            <div className="plans">
              <button
                className={`plan-card recommended ${isCheckingOut && selectedPlan === 'PREPAID_15KWH' ? 'loading' : ''}`}
                onClick={() => checkoutPlan('PREPAID_15KWH')}
                disabled={isCheckingOut}
              >
                <span className="plan-badge">POPULAR</span>
                <div className="plan-title">Quick Charge</div>
                <div className="plan-price">₱225.00</div>
                <div className="plan-meta">15 kWh · ~100 km range · AC Standard</div>
              </button>
              <button
                className="plan-card"
                onClick={() => checkoutPlan('PREPAID_30KWH')}
                disabled={isCheckingOut}
              >
                <div className="plan-title">Full Charge</div>
                <div className="plan-price">₱450.00</div>
                <div className="plan-meta">30 kWh · ~200 km range · AC Extended</div>
              </button>
            </div>

            {isCheckingOut && (
              <p className="card-subtitle" style={{ marginTop: 16, marginBottom: 0 }}>
                <span className="spinner spinner-light" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
                Preparing checkout…
              </p>
            )}
          </div>
        )}

        {step === 'PAYING' && (
          <div className="card">
            <div className="card-icon">💳</div>
            <h1 className="card-title">Complete Payment</h1>
            <p className="card-subtitle">
              You&apos;ll be redirected to our secure payment partner. Charging begins right after confirmation.
            </p>

            {checkoutId && (
              <div className="payment-box">
                <div className="payment-ref-label">Reference</div>
                <div className="payment-ref">{checkoutId}</div>
              </div>
            )}

            {redirectUrl ? (
              <a href={redirectUrl} target="_blank" rel="noopener noreferrer" className="btn btn-success">
                Continue to Payment →
              </a>
            ) : (
              <div className="waiting-block">
                <div className="waiting-dots">
                  <span /><span /><span />
                </div>
                <p>Loading payment gateway…</p>
              </div>
            )}

            <p className="card-subtitle" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
              Keep this page open — we&apos;ll update automatically when payment clears.
            </p>
          </div>
        )}

        {step === 'CHARGING' && (
          <div className="card">
            <div className="status-banner">
              <span className="status-dot" />
              {statusMessage}
            </div>

            {telemetry ? (
              <>
                <EnergyGauge kwh={telemetry.energyDeliveredKwh} maxKwh={30} />
                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-label">Estimated cost</div>
                    <div className="stat-value">₱{telemetry.estimatedCost.toFixed(2)}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Duration</div>
                    <div className="stat-value">{formatDuration(telemetry.durationSeconds)}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Power</div>
                    <div className="stat-value">{telemetry.powerKw} kW</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Voltage / Amps</div>
                    <div className="stat-value">{telemetry.voltageVolts}V · {telemetry.currentAmps}A</div>
                  </div>
                </div>

                <button
                  className="btn btn-danger"
                  onClick={stopCharging}
                  disabled={isStopping}
                >
                  {isStopping ? (
                    <>
                      <span className="spinner spinner-light" aria-hidden />
                      Stopping…
                    </>
                  ) : (
                    'Stop Charging'
                  )}
                </button>
              </>
            ) : (
              <div className="waiting-block">
                <div className="waiting-dots">
                  <span /><span /><span />
                </div>
                <p>Waiting for charger to respond…</p>
                <p style={{ fontSize: 12, marginTop: 8 }}>Make sure your vehicle is plugged in.</p>
              </div>
            )}
          </div>
        )}

        {step === 'COMPLETED' && (
          <div className="card">
            <div className="card-icon success">✓</div>
            <h1 className="card-title">All Done!</h1>
            <p className="card-subtitle">
              Payment processed successfully. You can safely unplug your vehicle.
            </p>
            {telemetry && (
              <div className="stats-grid" style={{ marginBottom: 8 }}>
                <div className="stat-card">
                  <div className="stat-label">Energy delivered</div>
                  <div className="stat-value">{telemetry.energyDeliveredKwh.toFixed(2)} kWh</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Total cost</div>
                  <div className="stat-value">₱{telemetry.estimatedCost.toFixed(2)}</div>
                </div>
              </div>
            )}
            <p className="card-subtitle" style={{ marginBottom: 0, fontSize: 12 }}>
              A receipt has been recorded for your session.
            </p>
          </div>
        )}

        {step === 'ERROR' && (
          <div className="card error">
            <div className="card-icon error">!</div>
            <h1 className="card-title danger">Something Went Wrong</h1>
            <p className="card-subtitle">{statusMessage}</p>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Try Again
            </button>
            {!tokenFromUrl && (
              <p className="card-subtitle" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
                Open the camera on your phone and scan the QR code displayed on the kiosk.
              </p>
            )}
          </div>
        )}

        <p className="footer-hint">
          Stratacore EV Charging · Secure prepaid sessions
        </p>
      </main>
    </div>
  );
}

export default function GuestAppPage() {
  return (
    <Suspense
      fallback={
        <div className="loading-screen">
          <span className="spinner" aria-hidden />
          Loading…
        </div>
      }
    >
      <GuestAppContent />
    </Suspense>
  );
}

'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { getApiBaseUrl, WebSocketEvents } from '@packages/shared';

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


function StepIndicator({ current }: { current: Step }) {
  if (current === 'ERROR') return null;
  const currentIdx = STEP_ORDER.indexOf(current);
  return (
    <div className="step-track" aria-label="Charging progress">
      {STEP_ORDER.map((step, i) => (
        <React.Fragment key={step}>
          <div className={`step-dot ${i < currentIdx ? 'done' : ''} ${i === currentIdx ? 'active' : ''}`}>
            {i < currentIdx ? '✓' : i + 1}
          </div>
          {i < STEP_ORDER.length - 1 && <div className={`step-line ${i < currentIdx ? 'done' : ''}`} />}
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
        <circle cx="50" cy="50" r="45" fill="none" stroke="#e2790d" strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} />
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
      s.on('connect', () => { s.emit(WebSocketEvents.SUBSCRIBE_CHARGER, { chargerId: data.chargerId }); });
      s.on(WebSocketEvents.PAYMENT_APPROVED, () => { setStep('CHARGING'); setStatusMessage('Payment confirmed — starting your session'); });
      s.on(WebSocketEvents.CHARGER_PREPARING, (msg: { message: string }) => { setStep('CHARGING'); setStatusMessage(msg.message || 'Plug in your vehicle'); });
      s.on(WebSocketEvents.CHARGER_STARTING, () => { setStep('CHARGING'); setStatusMessage('Charging in progress'); });
      s.on(WebSocketEvents.METER_UPDATE, (metrics: MeterUpdate) => { setTelemetry(metrics); });
      s.on(WebSocketEvents.SESSION_COMPLETED, () => { setStep('COMPLETED'); setStatusMessage('Your session is complete'); });
      s.on(WebSocketEvents.SESSION_ERROR, (msg: { message?: string }) => { setStep('ERROR'); setStatusMessage(msg?.message || 'The charger could not start.'); });
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
      setIsCheckingOut(true);
      const response = await fetch(`${backendUrl}/api/v1/charging/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'x-device-fingerprint': getFingerprint() },
        body: JSON.stringify({ chargerId, connectorId, tariffPlanId }),
      });
      if (!response.ok) throw new Error('Checkout failed');
      const data = await response.json();
      setCheckoutId(data.checkoutId);
      setRedirectUrl(data.redirectUrl || '');
      setStep('PAYING');
    } catch {
      setStep('ERROR');
      setStatusMessage('Could not start checkout.');
    } finally {
      setIsCheckingOut(false);
    }
  };

  const stopCharging = async () => {
    try {
      setIsStopping(true);
      await fetch(`${backendUrl}/api/v1/charging/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'x-device-fingerprint': getFingerprint() },
        body: JSON.stringify({}),
      });
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="guest-app">
      <header className="guest-header"><div className="guest-logo">STRATACORE <span className="guest-logo-sub">CHARGE</span></div></header>
      <main className="guest-main">
        <StepIndicator current={step} />
        {step === 'HANDSHAKE' && (
          <div className="card">
            <div className="card-icon">⚡</div>
            <h1 className="card-title">Ready to Charge</h1>
            <p className="card-subtitle">{statusMessage}</p>
            {tokenFromUrl && <button className="btn btn-primary" onClick={claimCharger} disabled={isClaiming}>{isClaiming ? 'Connecting…' : 'Connect to Charger'}</button>}
          </div>
        )}
        {step === 'SELECT_PLAN' && (
          <div className="card">
            <h1 className="card-title">Choose Your Plan</h1>
            <div className="plans">
              <button className="plan-card recommended" onClick={() => checkoutPlan('PREPAID_15KWH')} disabled={isCheckingOut}><div className="plan-title">Quick Charge</div><div className="plan-price">₱225</div><div className="plan-meta">15 kWh</div></button>
              <button className="plan-card" onClick={() => checkoutPlan('PREPAID_30KWH')} disabled={isCheckingOut}><div className="plan-title">Full Charge</div><div className="plan-price">₱450</div><div className="plan-meta">30 kWh</div></button>
            </div>
          </div>
        )}
        {step === 'PAYING' && (
          <div className="card">
            <h1 className="card-title">Complete Payment</h1>
            {checkoutId && <div className="payment-ref">{checkoutId}</div>}
            {redirectUrl && <a href={redirectUrl} target="_blank" rel="noopener noreferrer" className="btn btn-success">Continue to Payment →</a>}
          </div>
        )}
        {step === 'CHARGING' && (
          <div className="card">
            <div className="status-banner">{statusMessage}</div>
            {telemetry ? (
              <>
                <EnergyGauge kwh={telemetry.energyDeliveredKwh} />
                <button className="btn btn-danger" onClick={stopCharging} disabled={isStopping}>Stop Charging</button>
              </>
            ) : <p>Waiting for charger…</p>}
          </div>
        )}
        {step === 'COMPLETED' && <div className="card"><h1 className="card-title">All Done!</h1><p className="card-subtitle">{statusMessage}</p></div>}
        {step === 'ERROR' && <div className="card error"><h1 className="card-title danger">Error</h1><p className="card-subtitle">{statusMessage}</p></div>}
      </main>
    </div>
  );
}

export default function GuestPage() {
  return (
    <Suspense fallback={<div className="loading-screen">Loading…</div>}>
      <GuestAppContent />
    </Suspense>
  );
}

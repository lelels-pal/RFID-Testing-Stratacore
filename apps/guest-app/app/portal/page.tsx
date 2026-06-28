'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Zap,
  CheckCircle2,
  XCircle,
  Loader2,
  MapPin,
  ChevronRight,
  Battery,
  ArrowLeft,
  AlertCircle,
  Nfc,
  Play,
  StopCircle,
  History,
  LogOut,
  User,
} from 'lucide-react';
import Link from 'next/link';
import {
  WebSocketEvents,
  WsMeterUpdatePayload,
  WsSessionErrorPayload,
  ChargerConnectionInfo,
} from '@packages/shared';
import { EnergyRing } from '@/components/EnergyRing';
import { getApiBase } from '@/lib/api-base';
import { getChargerConfigs } from '@/lib/chargers';
import {
  getToken,
  fetchProfile,
  fetchSessions,
  requestExtraKwh,
  fetchMyEnergyRequests,
  clearAuth,
  type UiEnergyRequest,
} from '@/lib/auth';
import { getRfidProfile, clearRfidProfile, type RfidProfile } from '@/lib/rfid';

type Step = 'landing' | 'select-kwh' | 'select-charger' | 'error';

function formatKwh(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseKwh(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxExtraKwh(balance: number, monthlyAllowance: number): number {
  return Math.max(0, monthlyAllowance - balance);
}

function requestStatusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'accepted':
      return { label: 'Added', className: 'bg-emerald-500/20 text-emerald-400' };
    case 'declined':
      return { label: 'Declined', className: 'bg-red-500/20 text-red-400' };
    case 'pending':
    default:
      return { label: 'Pending', className: 'bg-amber-500/20 text-amber-300' };
  }
}

export default function PortalPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const chargers = getChargerConfigs();

  const stationIdParam = searchParams.get('station_id') || searchParams.get('nasid') || '1';
  const stationId = parseInt(stationIdParam, 10) || 1;
  const mode = searchParams.get('mode');

  const [step, setStep] = useState<Step>('landing');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rfidProfile, setRfidProfile] = useState<RfidProfile | null>(null);
  const [operatorBalance, setOperatorBalance] = useState<number | null>(null);
  const [baseBalanceKwh, setBaseBalanceKwh] = useState<number>(200);
  const [customKwh, setCustomKwh] = useState<number>(5);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [chargingSessions, setChargingSessions] = useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [energyRequests, setEnergyRequests] = useState<UiEnergyRequest[]>([]);
  const [energyRequestsLoading, setEnergyRequestsLoading] = useState(false);
  const [requestSubmitSuccess, setRequestSubmitSuccess] = useState('');
  const [showRequestConfirmModal, setShowRequestConfirmModal] = useState(false);
  const [quotaAlert, setQuotaAlert] = useState('');

  const [connections, setConnections] = useState<Record<string, ChargerConnectionInfo>>({});
  const [activeCharger, setActiveCharger] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<WsMeterUpdatePayload | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace('/auth/login');
      return;
    }

    setRfidProfile(getRfidProfile());
    if (mode === 'authenticated') {
      setStep('select-kwh');
    }

    fetchProfile()
      .then((profile) => {
        setOperatorBalance(parseKwh(profile.balance));
        const base = parseKwh(profile.base_balance_kwh, 200);
        setBaseBalanceKwh(base > 0 ? base : 200);
        if (profile.rfid_tag) {
          setRfidProfile({
            rfid_tag: profile.rfid_tag,
            name: profile.cardholderName,
            username: profile.username,
          });
        }
      })
      .catch(() => {
        clearAuth();
        router.replace('/auth/login');
      })
      .finally(() => setLoading(false));
  }, [router, mode]);

  useEffect(() => {
    if (!getToken()) return;

    const loadBalance = () => {
      fetchProfile()
        .then((profile) => {
          setOperatorBalance(parseKwh(profile.balance));
          const base = parseKwh(profile.base_balance_kwh, 200);
          setBaseBalanceKwh(base > 0 ? base : 200);
        })
        .catch(() => setOperatorBalance(null));
    };

    loadBalance();
    const interval = setInterval(loadBalance, 30000);
    return () => clearInterval(interval);
  }, [step]);

  useEffect(() => {
    if (step !== 'select-kwh' || !getToken()) return;

    let cancelled = false;
    setEnergyRequestsLoading(true);
    fetchMyEnergyRequests()
      .then((data) => {
        if (!cancelled) setEnergyRequests(data.requests || []);
      })
      .catch(() => {
        if (!cancelled) setEnergyRequests([]);
      })
      .finally(() => {
        if (!cancelled) setEnergyRequestsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [step, requestSubmitSuccess]);

  useEffect(() => {
    if (step !== 'select-kwh' || operatorBalance == null) return;
    const maxRequest = getMaxExtraKwh(operatorBalance, baseBalanceKwh);
    if (maxRequest <= 0) return;
    const minRequest = Math.min(5, maxRequest);
    setCustomKwh((prev) => Math.min(Math.max(prev, minRequest), maxRequest));
  }, [step, operatorBalance, baseBalanceKwh]);

  useEffect(() => {
    if (step !== 'landing' || !getToken()) return;
    setSessionsLoading(true);
    fetchSessions(20, 0)
      .then((data) => setChargingSessions(data.sessions || []))
      .catch(() => setChargingSessions([]))
      .finally(() => setSessionsLoading(false));
  }, [step]);

  useEffect(() => {
    const poll = async () => {
      const token = getToken();
      if (!token) return;
      const ids = chargers.map((c) => c.chargerId).join(',');
      const res = await fetch(
        `${getApiBase()}/api/v1/operator/charging/chargers?ids=${encodeURIComponent(ids)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const data: ChargerConnectionInfo[] = await res.json();
        setConnections(Object.fromEntries(data.map((c) => [c.chargerId, c])));
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [chargers]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const socket: Socket = io(getApiBase());
    const subscribed = new Set<string>();

    socket.on('connect', () => {
      for (const c of chargers) {
        if (!subscribed.has(c.chargerId)) {
          socket.emit(WebSocketEvents.SUBSCRIBE_CHARGER, { chargerId: c.chargerId });
          subscribed.add(c.chargerId);
        }
      }
      if (activeCharger && !subscribed.has(activeCharger)) {
        socket.emit(WebSocketEvents.SUBSCRIBE_CHARGER, { chargerId: activeCharger });
        subscribed.add(activeCharger);
      }
    });

    socket.on(WebSocketEvents.METER_UPDATE, (m: WsMeterUpdatePayload) => {
      if (activeCharger && m.chargerId === activeCharger) setTelemetry(m);
    });

    socket.on(WebSocketEvents.SESSION_COMPLETED, () => {
      setActiveCharger(null);
      setTelemetry(null);
      fetchProfile().then((p) => setOperatorBalance(parseKwh(p.balance)));
    });

    socket.on(WebSocketEvents.SESSION_ERROR, (msg: WsSessionErrorPayload) => {
      const isQuota =
        msg.reason === 'quota_buffer' ||
        msg.reason === 'quota_exhausted' ||
        /allocation|quota|limit|exhausted/i.test(msg.message || '');

      if (isQuota) {
        setQuotaAlert(msg.message || 'Your monthly kWh allocation is nearly exhausted.');
        setStep('select-kwh');
      } else if (activeCharger && msg.chargerId === activeCharger) {
        setError(msg.message || 'Charging session ended unexpectedly.');
        setStep('error');
      }

      if (activeCharger && (!msg.chargerId || msg.chargerId === activeCharger)) {
        setActiveCharger(null);
        setTelemetry(null);
      }
      fetchProfile().then((p) => setOperatorBalance(parseKwh(p.balance)));
    });

    return () => {
      socket.disconnect();
    };
  }, [activeCharger, chargers]);

  const handleChargeNow = () => {
    if (!getRfidProfile()) {
      router.push('/auth/login');
      return;
    }
    setStep('select-kwh');
  };

  const handleOpenRequestConfirm = () => {
    const balance = operatorBalance ?? 0;
    const maxRequest = getMaxExtraKwh(balance, baseBalanceKwh);
    if (maxRequest <= 0) {
      setError('You are already at your monthly allowance limit.');
      setStep('error');
      return;
    }
    if (customKwh > maxRequest) {
      setError(`You can only request up to ${formatKwh(maxRequest)} kWh this month.`);
      setStep('error');
      return;
    }
    setShowRequestConfirmModal(true);
  };

  const handleRequestToAdmin = async () => {
    const balance = operatorBalance ?? 0;
    const maxRequest = getMaxExtraKwh(balance, baseBalanceKwh);
    if (maxRequest <= 0 || customKwh > maxRequest) {
      setShowRequestConfirmModal(false);
      setError('You are already at your monthly allowance limit.');
      setStep('error');
      return;
    }

    setSubmittingRequest(true);
    setError(null);
    setRequestSubmitSuccess('');
    try {
      await requestExtraKwh(customKwh);
      setShowRequestConfirmModal(false);
      setRequestSubmitSuccess('Request sent. Your administrator will review it.');
      setQuotaAlert('');
    } catch (err) {
      setError((err as Error).message || 'Failed to submit request');
      setShowRequestConfirmModal(false);
      setStep('error');
    } finally {
      setSubmittingRequest(false);
    }
  };

  const handleLogout = () => {
    clearAuth();
    clearRfidProfile();
    router.replace('/');
  };

  const startCharging = async (chargerId: string, connectorId: number) => {
    setStarting(true);
    setError(null);
    setQuotaAlert('');
    try {
      const token = getToken();
      const res = await fetch(`${getApiBase()}/api/v1/operator/charging/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ chargerId, connectorId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Could not start charger');
      }
      setActiveCharger(chargerId);
      setStep('landing');
    } catch (e) {
      setError((e as Error).message);
      setStep('error');
    } finally {
      setStarting(false);
    }
  };

  const stopCharging = async () => {
    if (!activeCharger) return;
    const token = getToken();
    await fetch(`${getApiBase()}/api/v1/operator/charging/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ chargerId: activeCharger }),
    });
    setActiveCharger(null);
    setTelemetry(null);
    fetchProfile().then((p) => setOperatorBalance(parseKwh(p.balance)));
  };

  const Header = ({ backStep, backLabel }: { backStep?: Step; backLabel?: string }) => (
    <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {backStep && (
            <button
              onClick={() => setStep(backStep)}
              className="text-gray-400 hover:text-white transition-colors p-1 -ml-1"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div className="w-10 h-10 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl flex items-center justify-center shrink-0">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold bg-gradient-to-r from-orange-400 to-red-400 bg-clip-text text-transparent">
              STRATACORE
            </h1>
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {backLabel ?? `EV Charging Station #${stationId}`}
            </p>
          </div>
        </div>
        <Link href="/profile" className="text-gray-400 hover:text-white p-1">
          <User className="w-5 h-5" />
        </Link>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div
        className="min-h-screen text-white flex items-center justify-center"
        style={{ background: 'linear-gradient(135deg, #120b08 0%, #1f1b18 48%, #050505 100%)' }}
      >
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-orange-400 animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-mono">LOADING...</p>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div
        className="min-h-screen text-white flex items-center justify-center p-4"
        style={{ background: 'linear-gradient(135deg, #120b08 0%, #1f1b18 48%, #050505 100%)' }}
      >
        <div className="max-w-md w-full bg-red-500/10 border border-red-500/30 rounded-2xl p-8 text-center">
          <XCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-red-400 mb-2">Something Went Wrong</h1>
          <p className="text-gray-300 mb-6">{error}</p>
          <button
            onClick={() => {
              setStep('landing');
              setError(null);
            }}
            className="bg-red-500 hover:bg-red-600 px-8 py-3 rounded-xl font-semibold transition-all w-full"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (step === 'landing') {
    const isLoggedIn = !!getToken() && !!rfidProfile;
    const firstName = rfidProfile?.name.split(' ')[0] ?? '';
    const balanceKwh = operatorBalance ?? 0;
    const balanceDisplay = formatKwh(balanceKwh);
    const allowanceKwh = baseBalanceKwh > 0 ? baseBalanceKwh : 200;
    const allowanceDisplay = formatKwh(allowanceKwh);

    if (!isLoggedIn) {
      return (
        <div className="min-h-screen bg-stone-950 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-orange-400 animate-spin" />
        </div>
      );
    }

    return (
      <div className="min-h-dvh text-white flex flex-col bg-[#1c1208]">
        <div className="relative px-4 pt-5 pb-9 rounded-b-[2.75rem] overflow-hidden shrink-0 shadow-[0_20px_50px_rgba(124,45,18,0.45)]">
          <div
            className="absolute inset-0"
            style={{
              background: [
                'radial-gradient(ellipse 120% 80% at 50% -20%, rgba(255,237,213,0.45) 0%, transparent 55%)',
                'radial-gradient(ellipse 60% 40% at 100% 0%, rgba(254,215,170,0.35) 0%, transparent 50%)',
                'linear-gradient(175deg, #9a3412 0%, #c2410c 22%, #ea580c 48%, #f97316 68%, #fb923c 82%, #7c2d12 100%)',
              ].join(', '),
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/30 pointer-events-none" />
          <div className="relative max-w-md mx-auto">
            <div className="flex items-start justify-between gap-3 mb-5">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/30 backdrop-blur-md border border-white/25 px-3 py-1 text-[11px] font-semibold text-white shadow-sm">
                  <MapPin className="w-3 h-3 shrink-0" />
                  EV Charging Station #{stationId}
                </span>
                <h1 className="text-[1.65rem] font-bold text-white tracking-tight mt-3 drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)]">
                  Hello, {firstName}
                </h1>
                <p className="text-white/90 text-sm mt-1 font-medium">You&apos;re on track to charge</p>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="w-11 h-11 rounded-2xl bg-white flex items-center justify-center shrink-0 shadow-lg shadow-black/20 border border-white/80 active:scale-95 transition-transform"
                aria-label="Log out"
              >
                <LogOut className="w-4 h-4 text-stone-900" />
              </button>
            </div>

            <div className="text-center mb-3">
              <div className="inline-flex items-center gap-2 mb-1">
                <Nfc className="w-4 h-4 text-white/90 shrink-0" />
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/90">RFID Tag</p>
              </div>
              <p className="font-mono text-base font-bold text-white tracking-wide truncate px-2">
                {rfidProfile!.rfid_tag}
              </p>
            </div>

            <EnergyRing value={balanceKwh} max={allowanceKwh}>
              <div className="text-center">
                <div className="w-9 h-9 rounded-full bg-white/25 flex items-center justify-center mx-auto mb-2 shadow-md border border-white/30">
                  <Battery className="w-4 h-4 text-white" />
                </div>
                <p className="text-white text-sm font-bold tracking-wide">Energy Balance</p>
                <p className="text-5xl font-extrabold text-white leading-none mt-1.5 tabular-nums">
                  {balanceDisplay}
                </p>
                <p className="text-white text-sm font-semibold mt-1.5">kWh remaining</p>
                <p className="text-white/75 text-xs mt-0.5">of {allowanceDisplay} kWh allowance</p>
              </div>
            </EnergyRing>

            {activeCharger && telemetry && (
              <div className="mt-4 rounded-2xl bg-black/25 border border-white/20 p-4 text-center">
                <p className="text-white/90 text-sm font-semibold mb-1">Charging on {activeCharger}</p>
                <p className="text-white text-sm">
                  {telemetry.energyDeliveredKwh.toFixed(2)} kWh · {telemetry.powerKw.toFixed(1)} kW
                </p>
                <button
                  onClick={stopCharging}
                  className="mt-3 w-full flex items-center justify-center gap-2 rounded-xl bg-white/20 py-2.5 text-sm font-semibold"
                >
                  <StopCircle className="w-4 h-4" /> Stop
                </button>
              </div>
            )}

            <div className="mt-5 space-y-3">
              {!activeCharger && (
                <button
                  onClick={() => setStep('select-charger')}
                  className="w-full flex bg-white/90 hover:bg-white text-orange-700 font-bold py-3.5 rounded-2xl transition-all items-center justify-center gap-2 shadow-lg shadow-black/25 active:scale-[0.98]"
                >
                  <Play className="w-5 h-5 fill-orange-600 text-orange-600" />
                  <span>Start Charging</span>
                </button>
              )}
              <button
                onClick={handleChargeNow}
                className="w-full flex bg-white hover:bg-orange-50 text-orange-700 font-bold py-3.5 rounded-2xl transition-all items-center justify-center gap-2 shadow-lg shadow-black/25 border border-white/90 active:scale-[0.98]"
              >
                <Zap className="w-5 h-5 fill-orange-600 text-orange-600" />
                <span>Request for Extra</span>
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 -mt-5 px-4 pb-6 relative z-10 flex flex-col min-h-0">
          <div className="flex-1 flex flex-col bg-stone-900 border border-stone-800/80 rounded-[1.75rem] shadow-2xl shadow-black/30 p-5 min-h-0">
            <h2 className="text-lg font-bold text-stone-100 mb-4 shrink-0">Charging Sessions</h2>
            <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
              {sessionsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 text-orange-400 animate-spin" />
                </div>
              ) : chargingSessions.length === 0 ? (
                <div className="text-center py-12 text-stone-500">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No charging sessions yet</p>
                </div>
              ) : (
                chargingSessions.map((s: any) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded-2xl bg-stone-800/55 border border-stone-700/50 px-4 py-3.5"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-stone-100 text-sm truncate">
                        {s.charge_point_id || 'Charger'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-mono text-sm text-stone-100">
                        {s.energy_kwh != null ? `${s.energy_kwh} kWh` : '—'}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'select-kwh') {
    const balanceKwh = operatorBalance ?? 0;
    const allowanceKwh = baseBalanceKwh > 0 ? baseBalanceKwh : 200;
    const maxRequestKwh = getMaxExtraKwh(balanceKwh, allowanceKwh);
    const minKwh = maxRequestKwh > 0 ? Math.min(5, maxRequestKwh) : 0;
    const maxKwh = maxRequestKwh;
    const quickOptions = [5, 10, 20, 30].filter((kwh) => kwh <= maxRequestKwh);
    const atMonthlyLimit = maxRequestKwh <= 0;

    return (
      <div
        className="min-h-screen text-white"
        style={{ background: 'linear-gradient(135deg, #120b08 0%, #1f1b18 48%, #050505 100%)' }}
      >
        <Header backStep="landing" backLabel={rfidProfile ? rfidProfile.name : 'Request Energy'} />
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
          {quotaAlert && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              {quotaAlert}
            </div>
          )}

          <section>
            <h2 className="text-lg font-bold text-white mb-1">How much energy do you need?</h2>
            <p className="text-sm text-gray-400 mb-2">Request additional kWh from your administrator</p>
            <p className="text-xs text-orange-300/90 mb-6">
              Monthly allowance: {formatKwh(allowanceKwh)} kWh · Current balance: {formatKwh(balanceKwh)} kWh
              {!atMonthlyLimit && (
                <>
                  {' '}
                  · You can request up to{' '}
                  <span className="font-semibold">{formatKwh(maxRequestKwh)} kWh</span>
                </>
              )}
            </p>

            {atMonthlyLimit ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-center">
                <p className="text-amber-200 font-semibold">Monthly limit reached</p>
                <p className="text-sm text-amber-100/80 mt-2">
                  Your balance is already at or above the monthly allowance of {formatKwh(allowanceKwh)} kWh.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-2 mb-6">
                  {quickOptions.map((kwh) => (
                    <button
                      key={kwh}
                      onClick={() => setCustomKwh(kwh)}
                      className={`py-3 rounded-xl border-2 transition-all ${
                        customKwh === kwh
                          ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                          : 'border-gray-700 bg-black/30 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <p className="font-bold">{kwh}</p>
                      <p className="text-xs">kWh</p>
                    </button>
                  ))}
                </div>

                <div className="bg-slate-950/30 border border-slate-700 rounded-2xl p-4 mb-4">
                  <label className="text-xs text-gray-400 mb-2 block">Custom Amount</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={minKwh}
                      max={maxKwh}
                      value={customKwh}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (!isNaN(val)) setCustomKwh(Math.max(minKwh, Math.min(maxKwh, val)));
                      }}
                      className="flex-1 bg-slate-950 border border-slate-700 rounded-2xl px-4 py-3 text-white text-xl font-bold text-center focus:border-orange-500 focus:outline-none"
                    />
                    <span className="text-gray-400 font-semibold">kWh</span>
                  </div>
                  <input
                    type="range"
                    min={minKwh}
                    max={maxKwh}
                    step={1}
                    value={customKwh}
                    onChange={(e) => setCustomKwh(parseInt(e.target.value, 10))}
                    className="w-full mt-4 accent-orange-500"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>{minKwh} kWh</span>
                    <span>{maxKwh} kWh max</span>
                  </div>
                </div>
              </>
            )}
          </section>

          {!atMonthlyLimit && (
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Requested energy</span>
                <span className="text-white font-semibold">{customKwh} kWh</span>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Your administrator will review and approve this request.
              </p>
            </div>
          )}

          <button
            onClick={handleOpenRequestConfirm}
            disabled={submittingRequest || atMonthlyLimit}
            className={`w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-3 shadow-lg shadow-orange-500/20 transition-all duration-200 active:scale-[0.98] ${
              submittingRequest || atMonthlyLimit
                ? 'bg-gray-600 cursor-not-allowed opacity-70'
                : 'bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600'
            }`}
          >
            {submittingRequest ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Submitting...</span>
              </>
            ) : (
              <>
                <span>Request to Admin</span>
                <ChevronRight className="w-5 h-5" />
              </>
            )}
          </button>

          {showRequestConfirmModal && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
              <div className="bg-gradient-to-br from-stone-900 to-stone-950 border border-stone-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
                <div className="text-center mb-5">
                  <div className="w-14 h-14 bg-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-3 border border-orange-500/30">
                    <Zap className="w-7 h-7 text-orange-400" />
                  </div>
                  <h3 className="text-lg font-bold text-white mb-1">Confirm request</h3>
                  <p className="text-stone-400 text-sm">Send this kWh request to your administrator?</p>
                </div>
                <div className="bg-black/30 border border-stone-800 rounded-xl p-4 mb-5 space-y-2.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-stone-500">Requested energy</span>
                    <span className="text-white font-semibold">{formatKwh(customKwh)} kWh</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">Current balance</span>
                    <span className="text-white">{formatKwh(balanceKwh)} kWh</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">Monthly allowance</span>
                    <span className="text-white">{formatKwh(allowanceKwh)} kWh</span>
                  </div>
                  <div className="border-t border-stone-800 pt-2.5 flex justify-between">
                    <span className="text-stone-400">If approved</span>
                    <span className="text-emerald-400 font-semibold">
                      {formatKwh(Math.min(allowanceKwh, balanceKwh + customKwh))} kWh
                    </span>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowRequestConfirmModal(false)}
                    disabled={submittingRequest}
                    className="flex-1 py-3 rounded-xl border border-stone-600 text-stone-300 font-semibold hover:bg-stone-800/50 transition disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestToAdmin}
                    disabled={submittingRequest}
                    className="flex-1 py-3 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white font-semibold hover:from-orange-600 hover:to-red-600 transition disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {submittingRequest ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      'Confirm request'
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {requestSubmitSuccess && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {requestSubmitSuccess}
            </div>
          )}

          <section className="bg-slate-950/30 border border-slate-700 rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <History className="w-4 h-4 text-orange-400" />
              Request History
            </h3>
            {energyRequestsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
              </div>
            ) : energyRequests.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">No requests yet</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {energyRequests.map((req) => {
                  const meta = requestStatusMeta(req.status);
                  const when = req.reviewed_at || req.created_at;
                  return (
                    <div
                      key={req.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-black/25 border border-slate-800 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-white text-sm">+{formatKwh(req.kwh_amount)} kWh</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {when
                            ? new Date(when).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })
                            : '—'}
                        </p>
                        {req.status === 'declined' && req.admin_note && (
                          <p className="text-xs text-red-300/80 mt-1 truncate">{req.admin_note}</p>
                        )}
                      </div>
                      <span className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full ${meta.className}`}>
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  if (step === 'select-charger') {
    return (
      <div
        className="min-h-screen text-white"
        style={{ background: 'linear-gradient(135deg, #120b08 0%, #1f1b18 48%, #050505 100%)' }}
      >
        <Header backStep="landing" backLabel="Select Charger" />
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
          {chargers.map((c) => {
            const conn = connections[c.chargerId];
            const online = conn?.connected;
            return (
              <button
                key={c.chargerId}
                disabled={!online || starting}
                onClick={() => startCharging(c.chargerId, c.connectorId)}
                className="w-full text-left rounded-2xl border border-slate-700 bg-slate-950/50 p-4 disabled:opacity-50 hover:border-orange-500/40 transition-colors"
              >
                <p className="font-semibold text-white">{c.chargerId}</p>
                <p className="text-sm text-gray-400 mt-1">
                  {online ? conn?.status || 'Available' : 'Offline — not connected via OCPP'}
                </p>
              </button>
            );
          })}
          {chargers.length === 0 && (
            <div className="flex items-center gap-2 text-gray-500 text-sm bg-black/30 border border-gray-700 rounded-xl p-4">
              <AlertCircle className="w-4 h-4 shrink-0" />
              No chargers configured.
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

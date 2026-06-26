'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import {
  Zap,
  Play,
  StopCircle,
  Battery,
  LogOut,
  User,
  ChevronRight,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import Link from 'next/link';
import { WebSocketEvents, WsMeterUpdatePayload, ChargerConnectionInfo } from '@packages/shared';
import { EnergyRing } from '@/components/EnergyRing';
import { getApiBase } from '@/lib/api-base';
import { getChargerConfigs } from '@/lib/chargers';
import {
  clearAuth,
  fetchMyEnergyRequests,
  fetchProfile,
  getToken,
  requestExtraKwh,
} from '@/lib/auth';

type View = 'landing' | 'chargers' | 'request-extra';

export default function PortalPage() {
  const router = useRouter();
  const chargers = getChargerConfigs();
  const [view, setView] = useState<View>('landing');
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof fetchProfile>> | null>(null);
  const [connections, setConnections] = useState<Record<string, ChargerConnectionInfo>>({});
  const [activeCharger, setActiveCharger] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<WsMeterUpdatePayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [extraKwh, setExtraKwh] = useState('');
  const [requests, setRequests] = useState<any[]>([]);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    (async () => {
      try {
        setProfile(await fetchProfile());
        setRequests(await fetchMyEnergyRequests());
      } catch {
        clearAuth();
        router.replace('/auth/login');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    const poll = async () => {
      const ids = chargers.map((c) => c.chargerId).join(',');
      const res = await fetch(`${getApiBase()}/api/v1/charging/chargers?ids=${encodeURIComponent(ids)}`);
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
    if (!activeCharger) return;
    const socket: Socket = io(getApiBase());
    socket.on('connect', () => {
      socket.emit(WebSocketEvents.SUBSCRIBE_CHARGER, { chargerId: activeCharger });
    });
    socket.on(WebSocketEvents.METER_UPDATE, (m: WsMeterUpdatePayload) => {
      if (m.chargerId === activeCharger) setTelemetry(m);
    });
    socket.on(WebSocketEvents.SESSION_COMPLETED, () => {
      setActiveCharger(null);
      setTelemetry(null);
      fetchProfile().then(setProfile);
    });
    return () => { socket.disconnect(); };
  }, [activeCharger]);

  const startCharging = async (chargerId: string, connectorId: number) => {
    setStarting(true);
    setError('');
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
      setView('landing');
    } catch (e) {
      setError((e as Error).message);
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
    fetchProfile().then(setProfile);
  };

  const submitExtra = async () => {
    const amount = Number(extraKwh);
    if (!amount || amount <= 0) return;
    await requestExtraKwh(amount);
    setExtraKwh('');
    setRequests(await fetchMyEnergyRequests());
    setView('landing');
  };

  if (loading || !profile) {
    return <div className="min-h-screen flex items-center justify-center text-stone-400"><Loader2 className="animate-spin w-8 h-8" /></div>;
  }

  const remaining = profile.balance;
  const limit = profile.base_balance_kwh;

  return (
    <div className="min-h-dvh text-white pb-8" style={{ background: 'linear-gradient(180deg, #0c0a09 0%, #141210 100%)' }}>
      <header className="flex items-center justify-between px-5 py-4 border-b border-stone-800">
        <div className="flex items-center gap-2"><Zap className="text-orange-500 w-5 h-5" /><span className="font-bold tracking-wide">STRATACORE</span></div>
        <div className="flex gap-3">
          <Link href="/profile" className="text-stone-400"><User className="w-5 h-5" /></Link>
          <button onClick={() => { clearAuth(); router.push('/auth/login'); }} className="text-stone-400"><LogOut className="w-5 h-5" /></button>
        </div>
      </header>

      {error && (
        <div className="mx-5 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 flex gap-2 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {view === 'landing' && (
        <main className="px-5 pt-8 max-w-lg mx-auto">
          <p className="text-center text-stone-400 text-sm mb-2">Welcome, {profile.cardholderName}</p>
          <EnergyRing value={remaining} max={limit}>
            <p className="text-4xl font-bold">{remaining.toFixed(1)}</p>
            <p className="text-stone-400 text-sm">kWh remaining</p>
            <p className="text-stone-500 text-xs mt-1">of {limit} kWh monthly</p>
          </EnergyRing>
          <p className="text-center text-xs text-stone-500 mt-4 font-mono">{profile.rfid_tag}</p>

          {activeCharger && telemetry && (
            <div className="mt-6 rounded-2xl border border-orange-500/30 bg-orange-500/10 p-4">
              <p className="text-orange-300 font-semibold mb-2">Charging on {activeCharger}</p>
              <p>{telemetry.energyDeliveredKwh.toFixed(2)} kWh · {telemetry.powerKw.toFixed(1)} kW</p>
              <button onClick={stopCharging} className="mt-3 w-full flex items-center justify-center gap-2 rounded-xl bg-stone-800 py-3">
                <StopCircle className="w-5 h-5" /> Stop
              </button>
            </div>
          )}

          <div className="mt-8 space-y-3">
            {!activeCharger && (
              <button onClick={() => setView('chargers')} className="w-full flex items-center justify-between rounded-2xl bg-orange-600 px-5 py-4 font-semibold">
                <span className="flex items-center gap-2"><Play className="w-5 h-5" /> Start Charging</span>
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
            <button onClick={() => setView('request-extra')} className="w-full flex items-center justify-between rounded-2xl border border-stone-700 bg-stone-900/60 px-5 py-4">
              <span className="flex items-center gap-2"><Battery className="w-5 h-5 text-orange-400" /> Request Extra kWh</span>
              <ChevronRight className="w-5 h-5 text-stone-500" />
            </button>
          </div>
        </main>
      )}

      {view === 'chargers' && (
        <main className="px-5 pt-6 max-w-lg mx-auto">
          <button onClick={() => setView('landing')} className="text-stone-400 text-sm mb-4">← Back</button>
          <h2 className="text-xl font-bold mb-4">Select Charger</h2>
          <div className="space-y-3">
            {chargers.map((c) => {
              const conn = connections[c.chargerId];
              const online = conn?.connected;
              return (
                <button
                  key={c.chargerId}
                  disabled={!online || starting}
                  onClick={() => startCharging(c.chargerId, c.connectorId)}
                  className="w-full text-left rounded-2xl border border-stone-700 bg-stone-900/80 p-4 disabled:opacity-50"
                >
                  <p className="font-semibold">{c.chargerId}</p>
                  <p className="text-sm text-stone-400">{online ? conn?.status || 'Available' : 'Offline — not connected via OCPP'}</p>
                </button>
              );
            })}
          </div>
        </main>
      )}

      {view === 'request-extra' && (
        <main className="px-5 pt-6 max-w-lg mx-auto">
          <button onClick={() => setView('landing')} className="text-stone-400 text-sm mb-4">← Back</button>
          <h2 className="text-xl font-bold mb-2">Request Extra kWh</h2>
          <p className="text-stone-400 text-sm mb-4">Admin will review and add to your monthly allowance.</p>
          <input
            type="number"
            className="w-full rounded-xl bg-stone-900 border border-stone-700 px-4 py-3 mb-3"
            placeholder="kWh amount"
            value={extraKwh}
            onChange={(e) => setExtraKwh(e.target.value)}
          />
          <button onClick={submitExtra} className="w-full rounded-xl bg-orange-600 py-3 font-semibold">Submit Request</button>
          {requests.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="text-sm text-stone-400">Recent requests</p>
              {requests.slice(0, 5).map((r) => (
                <div key={r.id} className="text-sm flex justify-between border-b border-stone-800 py-2">
                  <span>{r.kwhAmount} kWh</span>
                  <span className="text-stone-500">{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Zap,
  Users,
  Gauge,
  BatteryCharging,
  WalletCards,
  TrendingUp,
  Play,
  StopCircle,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  AppSettings,
  EnergyRequest,
  RfidCard,
  SessionLogEntry,
} from '@packages/shared';
import { useAuth, canAccessTab } from '@/contexts/AuthContext';
import { useKioskData } from '@/hooks/useKioskData';
import { apiFetch } from '@/lib/api-client';
import { DataTable, MetricCard, Panel, SectionHeader, StatusPill } from '@/components/dashboard/ui';
import { STATION_NAME } from '@/lib/config';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type TabId = 'dashboard' | 'chargepoints' | 'finance' | 'energy' | 'history' | 'operators' | 'topup';

function formatKwh(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') || 'dashboard') as TabId;
  const { user } = useAuth();
  const kiosk = useKioskData(true);

  const [sessions, setSessions] = useState<SessionLogEntry[]>([]);
  const [energyRequests, setEnergyRequests] = useState<EnergyRequest[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedCharger, setSelectedCharger] = useState<string | null>(null);
  const [selectedRfid, setSelectedRfid] = useState('');
  const [actionError, setActionError] = useState('');

  const [newCard, setNewCard] = useState({
    rfidCardId: '',
    cardholderName: '',
    username: '',
    pin: '',
    monthlyKwhLimit: '200',
  });
  const [defaultLimit, setDefaultLimit] = useState('200');

  useEffect(() => {
    if (!canAccessTab(user?.role ?? null, tab)) return;
    (async () => {
      const [sessRes, setRes, reqRes] = await Promise.all([
        apiFetch('/api/v1/charging/sessions?days=30'),
        apiFetch('/api/v1/settings'),
        user?.role !== 'staff' ? apiFetch('/api/v1/admin/energy-requests') : Promise.resolve(null),
      ]);
      if (sessRes.ok) setSessions(await sessRes.json());
      if (setRes.ok) {
        const s: AppSettings = await setRes.json();
        setSettings(s);
        setDefaultLimit(String(s.defaultMonthlyKwhLimit));
      }
      if (reqRes?.ok) setEnergyRequests(await reqRes.json());
    })();
  }, [tab, user?.role]);

  const metrics = useMemo(() => {
    const online = Object.values(kiosk.chargerConnections).filter((c) => c.connected).length;
    const active = Object.values(kiosk.sessions).filter((s) => s.status === 'CHARGING' || s.status === 'PREPARING').length;
    const totalKwh = sessions.reduce((s, e) => s + e.energyKwh, 0);
    const allocated = kiosk.rfidCards.reduce((s, c) => s + c.monthlyKwhLimit, 0);
    return { online, active, totalKwh, allocated, operators: kiosk.rfidCards.length };
  }, [kiosk.chargerConnections, kiosk.sessions, kiosk.rfidCards, sessions]);

  const handleCreateOperator = async () => {
    setActionError('');
    const res = await apiFetch('/api/v1/charging/rfid', {
      method: 'POST',
      body: JSON.stringify({
        rfidCardId: newCard.rfidCardId,
        cardholderName: newCard.cardholderName,
        username: newCard.username || undefined,
        pin: newCard.pin || undefined,
        monthlyKwhLimit: Number(newCard.monthlyKwhLimit) || settings?.defaultMonthlyKwhLimit || 200,
        role: 'operator',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setActionError(err.message || 'Failed to create operator');
      return;
    }
    setNewCard({ rfidCardId: '', cardholderName: '', username: '', pin: '', monthlyKwhLimit: defaultLimit });
    kiosk.fetchRfids();
  };

  const handleSaveDefaultLimit = async () => {
    await apiFetch('/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultMonthlyKwhLimit: Number(defaultLimit) }),
    });
  };

  const reviewRequest = async (id: string, action: 'approve' | 'decline') => {
    await apiFetch(`/api/v1/admin/energy-requests/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const reqRes = await apiFetch('/api/v1/admin/energy-requests');
    if (reqRes.ok) setEnergyRequests(await reqRes.json());
    kiosk.fetchRfids();
  };

  if (!canAccessTab(user?.role ?? null, tab)) {
    return <p className="text-stone-400">You do not have access to this section.</p>;
  }

  if (tab === 'dashboard') {
    return (
      <section className="space-y-6">
        <SectionHeader eyebrow="Overview" title={STATION_NAME} description="Live station metrics and operator energy" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={<Zap className="w-5 h-5" />} label="Online Chargers" value={metrics.online} detail={`of ${kiosk.chargers.length}`} tone="green" />
          <MetricCard icon={<BatteryCharging className="w-5 h-5" />} label="Active Sessions" value={metrics.active} detail="charging now" tone="orange" />
          <MetricCard icon={<Users className="w-5 h-5" />} label="Operators" value={metrics.operators} detail="RFID registered" tone="blue" />
          <MetricCard icon={<Gauge className="w-5 h-5" />} label="Energy (30d)" value={`${formatKwh(metrics.totalKwh)} kWh`} detail="all sessions" tone="purple" />
        </div>
        <Panel title="Operator Balance Distribution">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={kiosk.rfidCards.map((c) => ({
                name: c.cardholderName,
                remaining: Math.max(0, c.monthlyKwhLimit - c.currentMonthKwhConsumed),
                used: c.currentMonthKwhConsumed,
              }))}>
                <CartesianGrid stroke="#444" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="#aaa" tick={{ fontSize: 11 }} />
                <YAxis stroke="#aaa" />
                <Tooltip />
                <Bar dataKey="remaining" fill="#f97316" name="Remaining kWh" radius={[6, 6, 0, 0]} />
                <Bar dataKey="used" fill="#78716c" name="Used kWh" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </section>
    );
  }

  if (tab === 'chargepoints') {
    return (
      <section className="space-y-6">
        <SectionHeader title="Chargepoints" description="Remote start/stop and live OCPP status" />
        {actionError && <p className="text-red-400 text-sm">{actionError}</p>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {kiosk.chargers.map((charger, idx) => {
            const conn = kiosk.chargerConnections[charger.chargerId];
            const session = kiosk.sessions[charger.chargerId];
            const online = conn?.connected;
            return (
              <Panel key={charger.chargerId} title={`Bay ${idx + 1} — ${charger.chargerId}`}>
                <div className="space-y-3">
                  <StatusPill label={online ? conn?.status || 'Online' : 'Offline'} tone={online ? 'green' : 'gray'} />
                  <p className="text-sm text-stone-400">{session?.statusMessage}</p>
                  {session?.telemetry && (
                    <p className="text-orange-300 font-semibold">
                      {session.telemetry.energyDeliveredKwh.toFixed(2)} kWh · {session.telemetry.powerKw.toFixed(1)} kW
                    </p>
                  )}
                  <select
                    className="w-full rounded-lg bg-stone-950 border border-stone-700 px-3 py-2 text-sm"
                    value={selectedCharger === charger.chargerId ? selectedRfid : ''}
                    onChange={(e) => {
                      setSelectedCharger(charger.chargerId);
                      setSelectedRfid(e.target.value);
                    }}
                  >
                    <option value="">Select operator RFID</option>
                    {kiosk.rfidCards.filter((c) => c.isActive).map((c) => (
                      <option key={c.rfidCardId} value={c.rfidCardId}>
                        {c.cardholderName} ({c.rfidCardId})
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <button
                      className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-orange-600 py-2 text-sm font-semibold"
                      onClick={async () => {
                        try {
                          setActionError('');
                          if (!selectedRfid) throw new Error('Select RFID');
                          await kiosk.startRfid(charger.chargerId, charger.connectorId, selectedRfid);
                        } catch (e) {
                          setActionError((e as Error).message);
                        }
                      }}
                    >
                      <Play className="w-4 h-4" /> Start
                    </button>
                    <button
                      className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-stone-700 py-2 text-sm"
                      onClick={() => kiosk.stopCharger(charger.chargerId).catch((e) => setActionError(e.message))}
                    >
                      <StopCircle className="w-4 h-4" /> Stop
                    </button>
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
        <Panel title="OCPP Trace (recent)">
          <div className="max-h-64 overflow-y-auto text-xs font-mono space-y-1">
            {kiosk.ocppTrace.slice(0, 30).map((e, i) => (
              <div key={i} className="text-stone-400">
                [{e.timestamp}] {e.chargerId} {e.action || e.messageType}
              </div>
            ))}
          </div>
        </Panel>
        {kiosk.rfidDeniedModal && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-stone-900 border border-stone-700 rounded-2xl p-6 max-w-md">
              <h3 className="text-lg font-bold text-red-400 mb-2">RFID Denied</h3>
              <p className="text-stone-300 text-sm mb-4">{kiosk.rfidDeniedModal.message}</p>
              <button className="rounded-lg bg-orange-600 px-4 py-2" onClick={() => kiosk.setRfidDeniedModal(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  if (tab === 'finance') {
    const cost = sessions.reduce((s, e) => s + e.costEstimate, 0);
    const kwh = sessions.reduce((s, e) => s + e.energyKwh, 0);
    return (
      <section className="space-y-6">
        <SectionHeader eyebrow="Energy accounting" title="Finance" description="Cost estimates from session log" />
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard icon={<WalletCards className="w-5 h-5" />} label="Estimated Cost" value={`₱${cost.toFixed(2)}`} detail="30 day total" tone="orange" />
          <MetricCard icon={<TrendingUp className="w-5 h-5" />} label="Energy Delivered" value={`${formatKwh(kwh)} kWh`} detail="30 day total" tone="green" />
          <MetricCard icon={<Gauge className="w-5 h-5" />} label="Rate" value={`₱${settings?.costPerKwh ?? 15}/kWh`} detail="configured" tone="blue" />
        </div>
      </section>
    );
  }

  if (tab === 'energy') {
    return (
      <section className="space-y-6">
        <SectionHeader title="Energy" description="Operator allocation and extra-kWh requests" />
        <Panel title="Pending Requests">
          <DataTable
            headers={['Operator', 'kWh', 'Status', 'Action']}
            rows={energyRequests
              .filter((r) => r.status === 'pending')
              .map((r) => [
                r.cardholderName,
                String(r.kwhAmount),
                r.status,
                user?.role !== 'staff' ? (
                  <span key={r.id} className="flex gap-2">
                    <button className="text-green-400 text-xs" onClick={() => reviewRequest(r.id, 'approve')}>Approve</button>
                    <button className="text-red-400 text-xs" onClick={() => reviewRequest(r.id, 'decline')}>Decline</button>
                  </span>
                ) : '—',
              ])}
          />
        </Panel>
        <Panel title="Operator kWh Remaining">
          <DataTable
            headers={['Operator', 'RFID', 'Used', 'Limit', 'Remaining']}
            rows={kiosk.rfidCards.map((c) => [
              c.cardholderName,
              c.rfidCardId,
              formatKwh(c.currentMonthKwhConsumed),
              formatKwh(c.monthlyKwhLimit),
              formatKwh(Math.max(0, c.monthlyKwhLimit - c.currentMonthKwhConsumed)),
            ])}
          />
        </Panel>
      </section>
    );
  }

  if (tab === 'history') {
    return (
      <section className="space-y-6">
        <SectionHeader title="History" description="Completed charging sessions" />
        <Panel title="Session Log (30 days)">
          <DataTable
            headers={['Ended', 'Type', 'Operator', 'Charger', 'kWh', 'Cost']}
            rows={sessions.map((s) => [
              new Date(s.endedAt).toLocaleString(),
              s.sessionType,
              s.cardholderName || '—',
              s.chargerId,
              s.energyKwh.toFixed(2),
              `₱${s.costEstimate.toFixed(2)}`,
            ])}
          />
        </Panel>
      </section>
    );
  }

  if (tab === 'operators') {
    const readOnly = user?.role === 'staff';
    return (
      <section className="space-y-6">
        <SectionHeader title="Operators" description="Fleet operators with RFID and monthly kWh allowance" />
        {actionError && <p className="text-red-400 text-sm">{actionError}</p>}
        {!readOnly && (
          <Panel title="Register Operator">
            <div className="grid gap-3 md:grid-cols-2">
              <input className="rounded-lg bg-stone-950 border border-stone-700 px-3 py-2" placeholder="RFID UID" value={newCard.rfidCardId} onChange={(e) => setNewCard({ ...newCard, rfidCardId: e.target.value })} />
              <input className="rounded-lg bg-stone-950 border border-stone-700 px-3 py-2" placeholder="Full name" value={newCard.cardholderName} onChange={(e) => setNewCard({ ...newCard, cardholderName: e.target.value })} />
              <input className="rounded-lg bg-stone-950 border border-stone-700 px-3 py-2" placeholder="Username (optional)" value={newCard.username} onChange={(e) => setNewCard({ ...newCard, username: e.target.value })} />
              <input className="rounded-lg bg-stone-950 border border-stone-700 px-3 py-2" placeholder="Mobile PIN" type="password" value={newCard.pin} onChange={(e) => setNewCard({ ...newCard, pin: e.target.value })} />
              <input className="rounded-lg bg-stone-950 border border-stone-700 px-3 py-2" placeholder="Monthly kWh" value={newCard.monthlyKwhLimit} onChange={(e) => setNewCard({ ...newCard, monthlyKwhLimit: e.target.value })} />
              <button className="rounded-lg bg-orange-600 py-2 font-semibold flex items-center justify-center gap-2" onClick={handleCreateOperator}>
                <Plus className="w-4 h-4" /> Add Operator
              </button>
            </div>
          </Panel>
        )}
        <Panel title="Registered Operators">
          <DataTable
            headers={['Name', 'RFID', 'Username', 'Used/Limit', 'Status']}
            rows={kiosk.rfidCards.map((c: RfidCard) => [
              c.cardholderName,
              c.rfidCardId,
              c.username || '—',
              `${formatKwh(c.currentMonthKwhConsumed)} / ${formatKwh(c.monthlyKwhLimit)}`,
              <StatusPill key={c.rfidCardId} label={c.isActive ? 'Active' : 'Blocked'} tone={c.isActive ? 'green' : 'red'} />,
            ])}
          />
        </Panel>
      </section>
    );
  }

  if (tab === 'topup') {
    return (
      <section className="space-y-6">
        <SectionHeader title="Top-Up" description="Base balance for new operators and quota management" />
        <Panel title="Default Monthly Allowance (base_balance_kwh)">
          <div className="flex gap-3 items-center max-w-md">
            <input className="flex-1 rounded-lg bg-stone-950 border border-stone-700 px-3 py-2" value={defaultLimit} onChange={(e) => setDefaultLimit(e.target.value)} />
            <button className="rounded-lg bg-orange-600 px-4 py-2 flex items-center gap-2" onClick={handleSaveDefaultLimit}>
              <RefreshCw className="w-4 h-4" /> Save
            </button>
          </div>
          <p className="text-xs text-stone-500 mt-2">Applied when registering new operators without an explicit limit.</p>
        </Panel>
        <Panel title="Reset / Adjust Quota">
          <DataTable
            headers={['Operator', 'Used', 'Limit', 'Reset']}
            rows={kiosk.rfidCards.map((c) => [
              c.cardholderName,
              formatKwh(c.currentMonthKwhConsumed),
              formatKwh(c.monthlyKwhLimit),
              <button
                key={c.rfidCardId}
                className="text-orange-400 text-xs"
                onClick={async () => {
                  await apiFetch(`/api/v1/charging/rfid/${c.rfidCardId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ currentMonthKwhConsumed: 0 }),
                  });
                  kiosk.fetchRfids();
                }}
              >
                Reset usage
              </button>,
            ])}
          />
        </Panel>
      </section>
    );
  }

  return null;
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="text-stone-400">Loading dashboard...</div>}>
      <DashboardContent />
    </Suspense>
  );
}

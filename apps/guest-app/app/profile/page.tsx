'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, LogOut, Loader2, User, History, Nfc } from 'lucide-react';
import { getUser, getToken, clearAuth, fetchProfile, fetchSessions } from '@/lib/auth';
import { clearRfidProfile } from '@/lib/rfid';

function formatKwh(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseKwh(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof fetchProfile>> | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'sessions'>('overview');

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.push('/auth/login');
      return;
    }

    window.history.pushState(null, '', window.location.href);
    const handlePopState = (e: PopStateEvent) => {
      e.preventDefault();
      window.history.pushState(null, '', window.location.href);
      if (confirm('Do you want to log out?')) handleLogout();
    };

    window.addEventListener('popstate', handlePopState);
    loadData();

    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [p, s] = await Promise.all([fetchProfile(), fetchSessions()]);
      setProfile(p);
      setSessions(s.sessions || []);
    } catch {
      clearAuth();
      router.push('/auth/login');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    clearAuth();
    clearRfidProfile();
    router.push('/');
  };

  const authUser = getUser();
  const balanceKwh = parseKwh(profile?.balance);
  const balanceDisplay = formatKwh(balanceKwh);
  const allowanceKwh = parseKwh(profile?.base_balance_kwh, 200) || 200;
  const allowanceDisplay = formatKwh(allowanceKwh);

  if (loading || !profile) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[#f97316] animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <header className="bg-[#1a1a1a] border-b border-[#27272a] p-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#f97316] rounded-full flex items-center justify-center">
              <User className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold">{profile.cardholderName || 'My Account'}</h1>
              <p className="text-xs text-gray-400">{profile.username || profile.rfid_tag}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="text-gray-400 hover:text-red-400 p-2">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="bg-gradient-to-br from-[#f97316] to-[#c2410c] rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-5 h-5 text-white/70" />
            <p className="text-white/70 text-sm">Energy Balance</p>
          </div>
          <p className="text-3xl font-bold text-white mt-1 tabular-nums">
            {balanceDisplay} <span className="text-lg font-semibold text-white/80">kWh</span>
          </p>
          <p className="text-white/60 text-xs mt-1">of {allowanceDisplay} kWh monthly allowance</p>
          <div className="flex gap-3 mt-4">
            <button
              onClick={() => router.push('/portal?mode=authenticated')}
              className="bg-white/20 hover:bg-white/30 text-white text-sm px-4 py-2 rounded-xl transition-colors flex items-center gap-1"
            >
              <Zap className="w-4 h-4" /> Request for Extra
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#27272a] text-center">
            <p className="text-2xl font-bold text-white">{sessions.length}</p>
            <p className="text-xs text-gray-400">Sessions</p>
          </div>
          <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#27272a] text-center">
            <p className="text-2xl font-bold text-white">
              {parseKwh(profile.currentMonthKwhConsumed).toFixed(1)}
            </p>
            <p className="text-xs text-gray-400">kWh Used</p>
          </div>
        </div>

        <div className="flex gap-1 bg-[#1a1a1a] rounded-xl p-1">
          {(['overview', 'sessions'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === t ? 'bg-[#f97316] text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {t === 'overview' ? 'Overview' : 'Sessions'}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <div className="bg-[#1a1a1a] rounded-xl p-5 border border-[#27272a] space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[#0a0a0a] px-4 py-3">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Username</p>
                <p className="text-sm text-white font-medium">{profile.username || authUser?.username || '—'}</p>
              </div>
            </div>
            {profile.rfid_tag && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-[#0a0a0a] px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 mb-0.5">RFID Tag</p>
                  <p className="font-mono text-sm text-[#f97316] truncate">{profile.rfid_tag}</p>
                </div>
                <Nfc className="w-4 h-4 text-gray-500 shrink-0" />
              </div>
            )}
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="space-y-2">
            {sessions.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No charging sessions yet</p>
              </div>
            ) : (
              sessions.map((s: any) => (
                <div key={s.id} className="bg-[#1a1a1a] rounded-xl p-4 border border-[#27272a]">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-white text-sm">{s.charge_point_id}</p>
                      <p className="text-xs text-gray-500">
                        {s.start_time ? new Date(s.start_time).toLocaleDateString() : '-'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm text-white">
                        {s.energy_kwh ? `${s.energy_kwh} kWh` : '-'}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}

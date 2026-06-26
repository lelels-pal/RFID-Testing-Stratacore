'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { clearAuth, fetchMySessions, fetchProfile, getToken } from '@/lib/auth';
import { OperatorProfile, SessionLogEntry } from '@packages/shared';

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const [sessions, setSessions] = useState<SessionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    (async () => {
      try {
        setProfile(await fetchProfile());
        setSessions(await fetchMySessions(30));
      } catch {
        clearAuth();
        router.replace('/auth/login');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  if (loading || !profile) {
    return <div className="min-h-screen flex items-center justify-center text-stone-400"><Loader2 className="animate-spin w-8 h-8" /></div>;
  }

  return (
    <div className="min-h-dvh text-white px-5 py-6" style={{ background: 'linear-gradient(180deg, #0c0a09 0%, #141210 100%)' }}>
      <Link href="/portal" className="inline-flex items-center gap-2 text-stone-400 text-sm mb-6"><ArrowLeft className="w-4 h-4" /> Portal</Link>
      <h1 className="text-2xl font-bold mb-1">{profile.cardholderName}</h1>
      <p className="text-stone-500 text-sm font-mono mb-6">{profile.rfid_tag}</p>
      <div className="grid grid-cols-2 gap-3 mb-8">
        <div className="rounded-xl border border-stone-700 p-4"><p className="text-stone-400 text-xs">Remaining</p><p className="text-2xl font-bold text-orange-400">{profile.balance.toFixed(1)} kWh</p></div>
        <div className="rounded-xl border border-stone-700 p-4"><p className="text-stone-400 text-xs">Monthly limit</p><p className="text-2xl font-bold">{profile.base_balance_kwh} kWh</p></div>
      </div>
      <h2 className="font-semibold mb-3">Session History</h2>
      {sessions.length === 0 ? (
        <p className="text-stone-500 text-sm">No sessions yet.</p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li key={s.id} className="rounded-xl border border-stone-800 p-3 text-sm">
              <div className="flex justify-between"><span>{s.chargerId}</span><span>{s.energyKwh.toFixed(2)} kWh</span></div>
              <div className="text-stone-500 text-xs mt-1">{new Date(s.endedAt).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

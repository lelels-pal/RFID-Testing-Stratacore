'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Zap, Loader2, AlertCircle, Eye, EyeOff, MapPin } from 'lucide-react';
import { getToken, login } from '@/lib/auth';
import { syncRfidProfileFromUser } from '@/lib/rfid';
import { buildPortalReturnUrl } from '@/lib/portal-query';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = buildPortalReturnUrl(searchParams);
  const stationId = searchParams.get('station_id') || searchParams.get('nasid') || '1';

  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getToken()) router.replace(returnUrl);
  }, [router, returnUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user } = await login(identifier.trim(), pin);
      syncRfidProfileFromUser(user);
      router.push(returnUrl);
    } catch (err) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-dvh text-white flex flex-col"
      style={{
        background:
          'radial-gradient(ellipse 80% 60% at 50% 45%, rgba(249,115,22,0.18) 0%, transparent 55%), linear-gradient(180deg, #0c0a09 0%, #141210 50%, #0a0908 100%)',
      }}
    >
      <div className="flex-1 flex flex-col justify-center px-5 py-8 max-w-md mx-auto w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center mx-auto mb-5 shadow-xl shadow-orange-900/40 border border-white/10">
            <Zap className="w-8 h-8 text-white" />
          </div>
          <p className="text-orange-400/80 text-xs font-semibold uppercase tracking-[0.2em] mb-2">
            Stratacore
          </p>
          <h1 className="text-3xl font-bold text-white tracking-tight mb-2">Welcome back</h1>
          <p className="text-stone-400 text-sm flex items-center justify-center gap-1">
            <MapPin className="w-3.5 h-3.5" />
            EV Charging Station #{stationId}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="rounded-[1.75rem] border border-stone-800/80 bg-stone-900/70 backdrop-blur-sm p-6 space-y-5 shadow-2xl shadow-black/30">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-stone-500 mb-2">
                RFID / Username
              </label>
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full bg-stone-950/80 border border-stone-700/80 rounded-2xl px-4 py-3.5 text-white placeholder:text-stone-600 focus:outline-none focus:border-orange-500/80 focus:ring-2 focus:ring-orange-500/20 transition-all"
                placeholder="Enter RFID or username"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-widest text-stone-500 mb-2">
                PIN
              </label>
              <div className="relative">
                <input
                  type={showPin ? 'text' : 'password'}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  className="w-full bg-stone-950/80 border border-stone-700/80 rounded-2xl px-4 py-3.5 pr-12 text-white placeholder:text-stone-600 focus:outline-none focus:border-orange-500/80 focus:ring-2 focus:ring-orange-500/20 transition-all"
                  placeholder="Enter your PIN"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300 transition-colors p-1"
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                >
                  {showPin ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 text-red-400 text-sm bg-red-500/10 border border-red-500/25 rounded-2xl p-3.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-400 hover:to-red-500 text-white font-semibold py-4 rounded-2xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-orange-900/30 active:scale-[0.98]"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign In'}
            </button>
          </div>
        </form>

        <p className="text-center text-stone-600 text-xs mt-6">
          Sign in with your operator RFID or username and the PIN provided by your administrator.
        </p>
      </div>
    </div>
  );
}

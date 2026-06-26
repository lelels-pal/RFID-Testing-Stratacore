'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, Loader2, Eye, EyeOff } from 'lucide-react';
import { login } from '@/lib/auth';

export default function OperatorLoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(identifier.trim(), pin);
      router.push('/portal');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-dvh text-white flex flex-col px-5"
      style={{ background: 'radial-gradient(ellipse 80% 60% at 50% 45%, rgba(249,115,22,0.18) 0%, transparent 55%), linear-gradient(180deg, #0c0a09 0%, #141210 50%, #0a0908 100%)' }}
    >
      <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-orange-600 flex items-center justify-center mx-auto mb-4">
            <Zap className="w-8 h-8" />
          </div>
          <p className="text-orange-400/80 text-xs font-semibold uppercase tracking-widest mb-2">Stratacore</p>
          <h1 className="text-3xl font-bold">Operator Sign In</h1>
          <p className="text-stone-400 text-sm mt-2">RFID tag or username + PIN</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <input
            className="w-full rounded-xl bg-stone-900/80 border border-stone-700 px-4 py-3.5"
            placeholder="RFID or username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <div className="relative">
            <input
              className="w-full rounded-xl bg-stone-900/80 border border-stone-700 px-4 py-3.5 pr-12"
              placeholder="PIN"
              type={showPin ? 'text' : 'password'}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500" onClick={() => setShowPin(!showPin)}>
              {showPin ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          <button type="submit" disabled={loading} className="w-full rounded-xl bg-orange-600 hover:bg-orange-500 py-3.5 font-semibold flex justify-center gap-2">
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

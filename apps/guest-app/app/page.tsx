'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Zap } from 'lucide-react';
import { getToken } from '@/lib/auth';
import { buildLoginUrl, buildPortalReturnUrl } from '@/lib/portal-query';

export default function SplashPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [fadeOut, setFadeOut] = useState(false);

  const loginPath = buildLoginUrl(searchParams);

  useEffect(() => {
    if (getToken()) {
      router.replace(buildPortalReturnUrl(searchParams));
      return;
    }

    const fadeTimer = setTimeout(() => setFadeOut(true), 2200);
    const navTimer = setTimeout(() => router.replace(loginPath), 2800);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(navTimer);
    };
  }, [router, loginPath, searchParams]);

  const goToLogin = () => {
    setFadeOut(true);
    setTimeout(() => router.replace(loginPath), 300);
  };

  return (
    <div
      className={`min-h-dvh flex flex-col items-center justify-center px-6 transition-opacity duration-500 ${
        fadeOut ? 'opacity-0' : 'opacity-100'
      }`}
      style={{
        background:
          'radial-gradient(ellipse 90% 60% at 50% 0%, rgba(249,115,22,0.35) 0%, transparent 55%), linear-gradient(180deg, #0c0a09 0%, #141210 45%, #0a0908 100%)',
      }}
      onClick={goToLogin}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') goToLogin();
      }}
      aria-label="Continue to sign in"
    >
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-72 h-72 bg-orange-500/20 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-48 h-48 bg-red-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative text-center space-y-8 max-w-sm">
        <div className="relative mx-auto w-28 h-28">
          <div className="absolute inset-0 bg-orange-500/30 rounded-[2rem] blur-xl animate-pulse" />
          <div className="relative w-28 h-28 rounded-[2rem] bg-gradient-to-br from-orange-500 via-orange-500 to-red-600 flex items-center justify-center shadow-2xl shadow-orange-900/50 border border-white/10">
            <Zap className="w-14 h-14 text-white" strokeWidth={1.75} />
          </div>
        </div>

        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-orange-300 via-orange-400 to-red-400 bg-clip-text text-transparent">
            STRATACORE
          </h1>
          <p className="text-stone-400 text-lg font-medium">EV Charging Platform</p>
          <p className="text-stone-500 text-sm">Operator mobile access</p>
        </div>

        <div className="pt-4 space-y-3">
          <div className="flex justify-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-2 h-2 rounded-full bg-orange-400/80 animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
          <p className="text-stone-600 text-xs">Tap anywhere to continue</p>
        </div>
      </div>
    </div>
  );
}

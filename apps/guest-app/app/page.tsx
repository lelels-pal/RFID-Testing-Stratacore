'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { getToken } from '@/lib/auth';

function SplashRouter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  useEffect(() => {
    if (token) {
      router.replace(`/guest?token=${encodeURIComponent(token)}`);
      return;
    }
    if (getToken()) router.replace('/portal');
    else router.replace('/auth/login');
  }, [token, router]);

  return (
    <div className="min-h-screen flex items-center justify-center text-stone-400">
      Loading…
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense>
      <SplashRouter />
    </Suspense>
  );
}

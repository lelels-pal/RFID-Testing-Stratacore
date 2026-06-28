'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { getApiBaseUrl } from '@packages/shared';

const WsEvents = {
  SUBSCRIBE_CHARGER: 'subscribe:charger',
};

function getBackendUrl() {
  return getApiBaseUrl({
    envUrl: process.env.NEXT_PUBLIC_BACKEND_URL,
    origin:
      typeof window !== 'undefined'
        ? { protocol: window.location.protocol, hostname: window.location.hostname }
        : undefined,
  });
}

function getFingerprint() {
  if (typeof window === 'undefined') return 'server';
  return `${navigator.userAgent}-${window.screen.width}x${window.screen.height}`;
}

function getErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const message = (data as { message?: string | string[] }).message;
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message === 'string' && message.length > 0) return message;
  return fallback;
}

function PaymentReturnContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const refFromUrl = searchParams.get('ref') || '';
  const outcome = searchParams.get('outcome') || 'success';
  const backendUrl = getBackendUrl();

  const [message, setMessage] = useState('Confirming payment with Maya…');

  useEffect(() => {
    const accessToken = sessionStorage.getItem('guest_access_token');
    const chargerId = sessionStorage.getItem('guest_charger_id') || '';
    const ref = refFromUrl || sessionStorage.getItem('guest_payment_ref') || '';
    const checkoutId = sessionStorage.getItem('guest_checkout_id') || undefined;

    if (!ref || !accessToken) {
      setMessage('Payment session expired. Please scan the kiosk QR code again.');
      return;
    }

    if (outcome !== 'success') {
      setMessage(outcome === 'cancel' ? 'Payment was cancelled.' : 'Payment was not completed.');
      return;
    }

    let socket: Socket | null = null;
    let retryCount = 0;
    const maxRetries = 30;

    const verify = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/v1/payments/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'x-device-fingerprint': getFingerprint(),
          },
          body: JSON.stringify({
            requestReferenceNumber: ref,
            checkoutId,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(getErrorMessage(data, 'Payment verification failed.'));
        }

        if (data.status === 'PENDING') {
          retryCount += 1;
          if (retryCount >= maxRetries) {
            setMessage('Payment is taking longer than expected. Tap Back to app to retry.');
            return;
          }
          setMessage('Payment is still processing. Please wait…');
          window.setTimeout(verify, 3000);
          return;
        }

        if (data.status === 'FAILED') {
          setMessage('Payment failed or expired. Please try again from the kiosk.');
          return;
        }

        sessionStorage.removeItem('guest_payment_ref');
        sessionStorage.removeItem('guest_checkout_id');
        setMessage('Payment confirmed. Connecting to charger — please wait…');

        if (chargerId) {
          socket = io(backendUrl);
          socket.on('connect', () => {
            socket?.emit(WsEvents.SUBSCRIBE_CHARGER, { chargerId });
          });
        }

        window.setTimeout(() => router.replace('/'), 1000);
      } catch (err) {
        setMessage((err as Error).message || 'Unable to verify payment.');
      }
    };

    void verify();

    return () => {
      socket?.disconnect();
    };
  }, [backendUrl, outcome, refFromUrl, router]);

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Maya Payment</h1>
        <p style={styles.subtitle}>{message}</p>
        <button type="button" style={styles.btn} onClick={() => router.replace('/')}>
          Back to app
        </button>
      </div>
    </div>
  );
}

export default function PaymentReturnPage() {
  return (
    <Suspense fallback={<div style={styles.container}>Loading…</div>}>
      <PaymentReturnContent />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: '#000',
    color: '#fff',
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#141414',
    border: '1px solid #2a2a2a',
    borderRadius: 16,
    padding: 30,
    maxWidth: 420,
    width: '100%',
    textAlign: 'center',
  },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 12 },
  subtitle: { color: '#9ca3af', fontSize: 14, lineHeight: 1.5, marginBottom: 20 },
  btn: {
    backgroundColor: '#e2790d',
    color: '#000',
    border: 'none',
    borderRadius: 30,
    padding: '12px 24px',
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%',
  },
};

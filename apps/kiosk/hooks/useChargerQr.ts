'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { initiateQrSession } from '../lib/api-client';

export interface ChargerDefinition {
  chargerId: string;
  connectorId: number;
  chargerIp: string;
}

export interface QrSessionState {
  qrToken: string;
  qrUrl: string;
  statusMessage: string;
  error: boolean;
}

function createInitialQrSession(): QrSessionState {
  return {
    qrToken: '',
    qrUrl: '',
    statusMessage: 'Scan QR to start charging',
    error: false,
  };
}

export function useChargerQr(
  backendUrl: string,
  chargers: ChargerDefinition[],
  enabled: boolean,
  backendHealthy: boolean,
) {
  const [qrSessions, setQrSessions] = useState<Record<string, QrSessionState>>({});
  const chargersRef = useRef(chargers);
  const prevHealthy = useRef<boolean | null>(null);
  chargersRef.current = chargers;

  const fetchSession = useCallback(
    async (charger: ChargerDefinition) => {
      if (!enabled) return;

      setQrSessions((current) => ({
        ...current,
        [charger.chargerId]: {
          ...createInitialQrSession(),
          statusMessage: 'Generating one-time QR token…',
        },
      }));

      try {
        const data = await initiateQrSession(backendUrl, charger.chargerId, charger.connectorId);
        setQrSessions((current) => ({
          ...current,
          [charger.chargerId]: {
            qrToken: data.qrToken,
            qrUrl: data.qrUrl,
            statusMessage: 'Scan QR to start charging',
            error: false,
          },
        }));
      } catch (err) {
        console.error(`Failed to initiate QR for ${charger.chargerId}:`, err);
        setQrSessions((current) => ({
          ...current,
          [charger.chargerId]: {
            ...createInitialQrSession(),
            statusMessage: 'Could not generate QR. Will retry when backend recovers.',
            error: true,
          },
        }));
      }
    },
    [backendUrl, enabled],
  );

  const refreshSession = useCallback(
    (chargerId: string, delayMs = 0) => {
      const charger = chargersRef.current.find((c) => c.chargerId === chargerId);
      if (!charger) return;
      if (delayMs > 0) {
        window.setTimeout(() => void fetchSession(charger), delayMs);
      } else {
        void fetchSession(charger);
      }
    },
    [fetchSession],
  );

  useEffect(() => {
    if (!enabled || chargers.length === 0) return;
    chargers.forEach((charger) => {
      void fetchSession(charger);
    });
  }, [enabled, chargers, fetchSession]);

  useEffect(() => {
    const recovered = prevHealthy.current === false && backendHealthy === true;
    prevHealthy.current = backendHealthy;
    if (!recovered || !enabled) return;

    chargersRef.current.forEach((charger) => {
      const session = qrSessions[charger.chargerId];
      if (!session?.qrUrl || session.error) {
        void fetchSession(charger);
      }
    });
  }, [backendHealthy, enabled, fetchSession, qrSessions]);

  return { qrSessions, fetchSession, refreshSession };
}

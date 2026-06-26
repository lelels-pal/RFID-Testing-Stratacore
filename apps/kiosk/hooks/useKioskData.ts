'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  RfidCard,
  WsMeterUpdatePayload,
  ChargerConnectionInfo,
  WsRfidAuthDeniedPayload,
  OcppTraceEntry,
  WebSocketEvents,
} from '@packages/shared';
import { getChargerConfigs } from '@/lib/config';
import { apiFetch, getBackendUrl } from '@/lib/api-client';

export interface LocalSessionState {
  status: 'IDLE' | 'PREPARING' | 'CHARGING' | 'COMPLETED' | 'ERROR';
  statusMessage: string;
  telemetry: WsMeterUpdatePayload | null;
  activeRfid: string | null;
}

const CHARGERS = getChargerConfigs();

export function useKioskData(enabled: boolean) {
  const [rfidCards, setRfidCards] = useState<RfidCard[]>([]);
  const [sessions, setSessions] = useState<Record<string, LocalSessionState>>(() =>
    Object.fromEntries(
      CHARGERS.map((c) => [
        c.chargerId,
        { status: 'IDLE', statusMessage: 'Ready', telemetry: null, activeRfid: null },
      ]),
    ),
  );
  const [chargerConnections, setChargerConnections] = useState<Record<string, ChargerConnectionInfo>>({});
  const [ocppTrace, setOcppTrace] = useState<OcppTraceEntry[]>([]);
  const [rfidDeniedModal, setRfidDeniedModal] = useState<WsRfidAuthDeniedPayload | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const fetchRfids = useCallback(async () => {
    const res = await apiFetch('/api/v1/charging/rfid');
    if (res.ok) setRfidCards(await res.json());
  }, []);

  const fetchConnections = useCallback(async () => {
    const ids = CHARGERS.map((c) => c.chargerId).join(',');
    const res = await apiFetch(`/api/v1/charging/chargers?ids=${encodeURIComponent(ids)}`);
    if (res.ok) {
      const data: ChargerConnectionInfo[] = await res.json();
      setChargerConnections(Object.fromEntries(data.map((c) => [c.chargerId, c])));
    }
  }, []);

  const fetchOcppTrace = useCallback(async () => {
    const res = await apiFetch('/api/v1/charging/ocpp-trace?limit=80');
    if (res.ok) setOcppTrace(await res.json());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchRfids();
    fetchConnections();
    fetchOcppTrace();
    const a = setInterval(fetchRfids, 3000);
    const b = setInterval(fetchConnections, 5000);
    const c = setInterval(fetchOcppTrace, 4000);
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, [enabled, fetchRfids, fetchConnections, fetchOcppTrace]);

  useEffect(() => {
    if (!enabled) return;
    const socket = io(getBackendUrl());
    socketRef.current = socket;
    socket.on('connect', () => {
      CHARGERS.forEach((c) => socket.emit(WebSocketEvents.SUBSCRIBE_CHARGER, { chargerId: c.chargerId }));
    });
    const prep = (data: { chargerId: string; message?: string }) =>
      setSessions((p) => ({
        ...p,
        [data.chargerId]: { ...p[data.chargerId], status: 'PREPARING', statusMessage: data.message || 'Preparing' },
      }));
    const start = (data: { chargerId: string; message?: string }) =>
      setSessions((p) => ({
        ...p,
        [data.chargerId]: { ...p[data.chargerId], status: 'CHARGING', statusMessage: data.message || 'Charging' },
      }));
    const done = (data: { chargerId: string; message?: string }) =>
      setSessions((p) => ({
        ...p,
        [data.chargerId]: {
          status: 'COMPLETED',
          statusMessage: data.message || 'Completed',
          telemetry: null,
          activeRfid: null,
        },
      }));
    const err = (data: { chargerId: string; message?: string }) =>
      setSessions((p) => ({
        ...p,
        [data.chargerId]: {
          ...p[data.chargerId],
          status: 'ERROR',
          statusMessage: data.message || 'Error',
          activeRfid: null,
        },
      }));
    const meter = (data: WsMeterUpdatePayload) =>
      setSessions((p) => ({
        ...p,
        [data.chargerId]: {
          ...p[data.chargerId],
          status: 'CHARGING',
          telemetry: data,
        },
      }));
    socket.on(WebSocketEvents.CHARGER_PREPARING, prep);
    socket.on(WebSocketEvents.CHARGER_STARTING, start);
    socket.on(WebSocketEvents.SESSION_COMPLETED, done);
    socket.on(WebSocketEvents.SESSION_ERROR, err);
    socket.on(WebSocketEvents.METER_UPDATE, meter);
    socket.on(WebSocketEvents.RFID_AUTH_DENIED, (payload: WsRfidAuthDeniedPayload) => {
      setRfidDeniedModal(payload);
    });
    return () => {
      socket.disconnect();
    };
  }, [enabled]);

  const startRfid = async (chargerId: string, connectorId: number, rfidCardId: string) => {
    const res = await apiFetch('/api/v1/charging/rfid/start', {
      method: 'POST',
      body: JSON.stringify({ chargerId, connectorId, rfidCardId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Start failed');
    }
    setSessions((p) => ({
      ...p,
      [chargerId]: { ...p[chargerId], activeRfid: rfidCardId, status: 'PREPARING', statusMessage: 'Starting...' },
    }));
    return res.json();
  };

  const stopCharger = async (chargerId: string) => {
    const res = await apiFetch('/api/v1/charging/kiosk/stop', {
      method: 'POST',
      body: JSON.stringify({ chargerId }),
    });
    if (!res.ok) throw new Error('Stop failed');
    return res.json();
  };

  return {
    chargers: CHARGERS,
    rfidCards,
    sessions,
    chargerConnections,
    ocppTrace,
    rfidDeniedModal,
    setRfidDeniedModal,
    fetchRfids,
    startRfid,
    stopCharger,
  };
}

import { EnergyRequest } from '@packages/shared';

const ADMIN_TOKEN_KEY = 'kiosk_admin_token';

let adminToken: string | null = null;

export function setAdminToken(token: string | null): void {
  adminToken = token;
  if (typeof window === 'undefined') return;
  if (token) {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  }
}

export function loadPersistedAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  adminToken = token;
  return token;
}

export function getAdminToken(): string | null {
  return adminToken;
}

function adminHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(extra as Record<string, string>),
  };
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  return headers;
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { message?: string | string[] };
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join(', ') : data.message;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return data;
}

export async function adminLogin(
  backendUrl: string,
  username: string,
  password: string,
): Promise<{ accessToken: string }> {
  const res = await fetch(`${backendUrl}/api/v1/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await parseJson<{ accessToken: string }>(res);
  setAdminToken(data.accessToken);
  return data;
}

export async function fetchSiteConfig(backendUrl: string) {
  const res = await fetch(`${backendUrl}/api/v1/charging/site-config`);
  return parseJson<{
    stationName: string;
    stationLocation: string;
    chargers: Array<{ chargerId: string; connectorId: number; chargerIp: string }>;
  }>(res);
}

export async function initiateQrSession(
  backendUrl: string,
  chargerId: string,
  connectorId: number,
) {
  const res = await fetch(`${backendUrl}/api/v1/session/initiate`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ chargerId, connectorId }),
  });
  return parseJson<{ qrToken: string; qrUrl: string; expiresAt: string }>(res);
}

export async function fetchRfids(backendUrl: string) {
  const res = await fetch(`${backendUrl}/api/v1/charging/rfid`, { headers: adminHeaders() });
  return parseJson<unknown[]>(res);
}

export async function fetchChargerConnections(backendUrl: string, chargerIds: string[]) {
  const ids = chargerIds.join(',');
  const res = await fetch(
    `${backendUrl}/api/v1/charging/chargers?ids=${encodeURIComponent(ids)}`,
    { headers: adminHeaders() },
  );
  return parseJson<unknown[]>(res);
}

export async function fetchOcppTrace(backendUrl: string, rfidOnly: boolean) {
  const query = rfidOnly ? 'limit=100&rfidOnly=true' : 'limit=100';
  const res = await fetch(`${backendUrl}/api/v1/charging/ocpp-trace?${query}`, {
    headers: adminHeaders(),
  });
  return parseJson<unknown[]>(res);
}

export async function startRfidSession(
  backendUrl: string,
  body: { chargerId: string; connectorId: number; rfidCardId: string },
) {
  const res = await fetch(`${backendUrl}/api/v1/charging/rfid/start`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function kioskStopCharger(backendUrl: string, chargerId: string) {
  const res = await fetch(`${backendUrl}/api/v1/charging/kiosk/stop`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ chargerId }),
  });
  return parseJson(res);
}

export async function fetchEnergyRequests(backendUrl: string): Promise<EnergyRequest[]> {
  const res = await fetch(`${backendUrl}/api/v1/admin/energy-requests`, { headers: adminHeaders() });
  return parseJson<EnergyRequest[]>(res);
}

export async function reviewEnergyRequest(
  backendUrl: string,
  id: string,
  action: 'approve' | 'decline',
  adminNote?: string,
) {
  const res = await fetch(`${backendUrl}/api/v1/admin/energy-requests/${id}/${action}`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ adminNote }),
  });
  return parseJson<EnergyRequest>(res);
}

export async function registerRfid(
  backendUrl: string,
  body: { rfidCardId: string; cardholderName: string; monthlyKwhLimit: number; pin?: string },
) {
  const res = await fetch(`${backendUrl}/api/v1/charging/rfid`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function updateRfid(backendUrl: string, cardId: string, body: Record<string, unknown>) {
  const res = await fetch(`${backendUrl}/api/v1/charging/rfid/${cardId}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function deleteRfid(backendUrl: string, cardId: string) {
  const res = await fetch(`${backendUrl}/api/v1/charging/rfid/${cardId}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
  return parseJson(res);
}

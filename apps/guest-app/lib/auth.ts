import { EnergyRequest, OperatorLoginResponse, OperatorProfile } from '@packages/shared';
import { getApiBase } from './api-base';

const TOKEN_KEY = 'operator_token';
const USER_KEY = 'operator_user';

export type { OperatorProfile as AuthUser };

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): OperatorProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAuth(data: OperatorLoginResponse) {
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}

export function setUser(user: OperatorProfile) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const err = await res.json();
    if (typeof err.message === 'string') return err.message;
    if (typeof err.detail === 'string') return err.detail;
  } catch {
    // ignore
  }
  return res.statusText || fallback;
}

export async function login(identifier: string, pin: string): Promise<OperatorLoginResponse> {
  const res = await fetch(`${getApiBase()}/api/v1/auth/operator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, pin }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Login failed'));
  }
  const data: OperatorLoginResponse = await res.json();
  setAuth(data);
  return data;
}

export async function fetchProfile(): Promise<OperatorProfile> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${getApiBase()}/api/v1/operator/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to load profile');
  const profile = await res.json();
  setUser(profile);
  return profile;
}

export async function requestExtraKwh(kwhAmount: number): Promise<{
  success: boolean;
  message: string;
  kwh_requested: number;
  request_id: string;
  status: string;
}> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${getApiBase()}/api/v1/operator/energy-requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ kwhAmount }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to submit request'));
  }
  const req: EnergyRequest = await res.json();
  return {
    success: true,
    message: 'Request submitted.',
    kwh_requested: req.kwhAmount,
    request_id: req.id,
    status: req.status,
  };
}

export type UiEnergyRequest = {
  id: string;
  kwh_amount: number;
  status: string;
  admin_note?: string | null;
  created_at?: string | null;
  reviewed_at?: string | null;
};

function mapEnergyRequest(req: EnergyRequest): UiEnergyRequest {
  return {
    id: req.id,
    kwh_amount: req.kwhAmount,
    status: req.status,
    admin_note: req.adminNote,
    created_at: req.createdAt,
    reviewed_at: req.reviewedAt,
  };
}

export async function fetchMyEnergyRequests(): Promise<{ requests: UiEnergyRequest[] }> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${getApiBase()}/api/v1/operator/energy-requests`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch requests');
  const data: EnergyRequest[] = await res.json();
  return { requests: data.map(mapEnergyRequest) };
}

export async function fetchSessions(_limit = 20, _offset = 0): Promise<{ sessions: never[] }> {
  return { sessions: [] };
}

import { OperatorLoginResponse, OperatorProfile } from '@packages/shared';
import { getApiBase } from './api-base';

const TOKEN_KEY = 'operator_token';
const USER_KEY = 'operator_user';

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

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function login(identifier: string, pin: string): Promise<OperatorLoginResponse> {
  const res = await fetch(`${getApiBase()}/api/v1/auth/operator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Login failed');
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
  localStorage.setItem(USER_KEY, JSON.stringify(profile));
  return profile;
}

export async function requestExtraKwh(kwhAmount: number) {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/v1/operator/energy-requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ kwhAmount }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Request failed');
  }
  return res.json();
}

export async function fetchMyEnergyRequests() {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/v1/operator/energy-requests`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return res.json();
}

export async function fetchMySessions(days = 30) {
  const token = getToken();
  const res = await fetch(`${getApiBase()}/api/v1/charging/operator/sessions?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return res.json();
}

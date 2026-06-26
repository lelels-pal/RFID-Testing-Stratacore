import { getApiBaseUrl } from '@packages/shared';

export function getBackendUrl(): string {
  return getApiBaseUrl({
    envUrl: process.env.NEXT_PUBLIC_BACKEND_URL,
    origin:
      typeof window !== 'undefined'
        ? { protocol: window.location.protocol, hostname: window.location.hostname }
        : undefined,
  });
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('admin_token') : null;
  const headers = new Headers(init.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${getBackendUrl()}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
}

export interface ChargerDefinition {
  chargerId: string;
  connectorId: number;
  chargerIp: string;
}

const DEFAULT_CHARGERS: ChargerDefinition[] = [
  { chargerId: 'DELTA123', connectorId: 1, chargerIp: '192.168.137.51' },
];

export function getChargerConfigs(): ChargerDefinition[] {
  const raw = process.env.NEXT_PUBLIC_CHARGERS;
  if (!raw) return DEFAULT_CHARGERS;

  try {
    const parsed = JSON.parse(raw) as ChargerDefinition[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {
    console.warn('[Kiosk] Invalid NEXT_PUBLIC_CHARGERS JSON; using defaults.');
  }

  return DEFAULT_CHARGERS;
}

export const STATION_NAME = process.env.NEXT_PUBLIC_STATION_NAME || 'Charging Station';
export const STATION_LOCATION = process.env.NEXT_PUBLIC_STATION_LOCATION || '';

export function validateKioskLogin(username: string, password: string): boolean {
  const expectedUser = process.env.NEXT_PUBLIC_KIOSK_USERNAME;
  const expectedPass = process.env.NEXT_PUBLIC_KIOSK_PASSWORD;

  if (!expectedUser || !expectedPass) {
    console.error('[Kiosk] NEXT_PUBLIC_KIOSK_USERNAME and NEXT_PUBLIC_KIOSK_PASSWORD must be set.');
    return false;
  }

  return username.trim() === expectedUser && password === expectedPass;
}

export function isKioskAuthConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_KIOSK_USERNAME && process.env.NEXT_PUBLIC_KIOSK_PASSWORD);
}

export const KIOSK_AUTH_STORAGE_KEY = 'kiosk_admin_authenticated';

export function persistKioskLogin(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(KIOSK_AUTH_STORAGE_KEY, 'true');
  }
}

export function clearKioskLogin(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(KIOSK_AUTH_STORAGE_KEY);
  }
}

export function isKioskLoginPersisted(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(KIOSK_AUTH_STORAGE_KEY) === 'true';
}

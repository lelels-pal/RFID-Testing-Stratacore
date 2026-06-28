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

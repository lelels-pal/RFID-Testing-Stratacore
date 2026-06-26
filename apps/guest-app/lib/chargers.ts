export interface ChargerDefinition {
  chargerId: string;
  connectorId: number;
  chargerIp?: string;
}

const DEFAULT: ChargerDefinition[] = [{ chargerId: 'DELTA123', connectorId: 1 }];

export function getChargerConfigs(): ChargerDefinition[] {
  const raw = process.env.NEXT_PUBLIC_CHARGERS;
  if (!raw) return DEFAULT;
  try {
    const parsed = JSON.parse(raw) as ChargerDefinition[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

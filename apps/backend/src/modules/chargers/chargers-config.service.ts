import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface ChargerConfigEntry {
  chargerId: string;
  connectorId: number;
  chargerIp: string;
}

export interface SiteConfig {
  stationName: string;
  stationLocation: string;
  chargers: ChargerConfigEntry[];
}

@Injectable()
export class ChargersConfigService implements OnModuleInit {
  private readonly logger = new Logger(ChargersConfigService.name);
  private chargers: ChargerConfigEntry[] = [];

  onModuleInit(): void {
    this.chargers = this.loadChargers();
    this.logger.log(`Loaded ${this.chargers.length} charger(s) from configuration.`);
  }

  getSiteConfig(): SiteConfig {
    return {
      stationName: process.env.STATION_NAME || 'Charging Station',
      stationLocation: process.env.STATION_LOCATION || '',
      chargers: this.chargers,
    };
  }

  getAllowedChargerIds(): string[] {
    return this.chargers.map((c) => c.chargerId);
  }

  isAllowedChargerId(chargerId: string): boolean {
    if (this.chargers.length === 0) return true;
    return this.chargers.some((c) => c.chargerId === chargerId);
  }

  private loadChargers(): ChargerConfigEntry[] {
    const raw = process.env.CHARGERS_JSON?.trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw) as ChargerConfigEntry[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (c) => c.chargerId && typeof c.connectorId === 'number' && c.chargerIp,
      );
    } catch (err) {
      this.logger.error(`Invalid CHARGERS_JSON: ${(err as Error).message}`);
      return [];
    }
  }
}

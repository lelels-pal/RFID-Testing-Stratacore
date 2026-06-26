import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings } from '@packages/shared';
import { config, setOperatorBaseBalance } from '../../config/app.config';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly filePath = path.join(process.cwd(), 'settings.json');

  constructor(private readonly prisma: PrismaService) {}

  get(): AppSettings {
    return {
      defaultMonthlyKwhLimit: config.operatorBaseBalance,
      costPerKwh: config.pricePerKwh,
    };
  }

  update(partial: Partial<AppSettings>): AppSettings {
    if (partial.defaultMonthlyKwhLimit !== undefined) {
      setOperatorBaseBalance(partial.defaultMonthlyKwhLimit);
    }
    if (partial.costPerKwh !== undefined) {
      config.pricePerKwh = partial.costPerKwh;
      process.env.PRICE_PER_KWH = String(partial.costPerKwh);
    }
    if (!this.prisma.isReady()) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.get(), null, 2), 'utf-8');
      } catch (err) {
        this.logger.warn('Could not persist settings.json', err);
      }
    }
    return this.get();
  }

  loadFromFileIfNeeded() {
    if (this.prisma.isReady()) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<AppSettings>;
        if (parsed.defaultMonthlyKwhLimit) setOperatorBaseBalance(parsed.defaultMonthlyKwhLimit);
        if (parsed.costPerKwh) config.pricePerKwh = parsed.costPerKwh;
      }
    } catch {
      /* ignore */
    }
  }
}

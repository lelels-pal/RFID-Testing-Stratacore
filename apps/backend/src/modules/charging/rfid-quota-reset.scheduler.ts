import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RfidService } from './rfid.service';

@Injectable()
export class RfidQuotaResetScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RfidQuotaResetScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private lastRunKey = '';

  constructor(private readonly rfidService: RfidService) {}

  onModuleInit() {
    const intervalMs = Number(process.env.RFID_RESET_CHECK_INTERVAL_MS) || 60_000;
    this.timer = setInterval(() => this.checkMonthlyReset(), intervalMs);
    this.checkMonthlyReset();
    this.logger.log(`RFID monthly reset scheduler started (interval=${intervalMs}ms).`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private checkMonthlyReset() {
    const tz = process.env.TZ || 'Asia/Manila';
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = parts.find((p) => p.type === 'year')?.value ?? '';
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    const runKey = `${year}-${month}`;

    if (day !== '01') return;
    if (this.lastRunKey === runKey) return;

    const resetCount = this.rfidService.resetAllMonthlyQuotas();
    this.lastRunKey = runKey;
    if (resetCount > 0) {
      this.logger.log(`Monthly quota reset on ${year}-${month}-01 (${tz}): ${resetCount} card(s).`);
    }
  }
}

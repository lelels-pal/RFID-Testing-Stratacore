import { Injectable, Logger } from '@nestjs/common';

export interface ChargeStartTimeoutContext {
  chargerId: string;
  connectorId: number;
}

/**
 * Per-charger "no vehicle" watchdog.
 * Fires when RemoteStart is accepted but charging never begins within the timeout.
 * Ported from EV3 charging session patterns and already used in ChargingService.
 */
@Injectable()
export class ChargeStartWatchdogService {
  private readonly logger = new Logger(ChargeStartWatchdogService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timeoutMs = Number(process.env.CHARGE_START_TIMEOUT_MS) || 60_000;

  /** Charger IDs with an armed timer (for status API). */
  getArmedChargerIds(): string[] {
    return Array.from(this.timers.keys());
  }

  getTimeoutSeconds(): number {
    return Math.round(this.timeoutMs / 1000);
  }

  arm(context: ChargeStartTimeoutContext, onTimeout: () => void): void {
    this.clear(context.chargerId);

    const timer = setTimeout(() => {
      this.timers.delete(context.chargerId);
      this.logger.warn(
        `No charging transaction started for ${context.chargerId} within ${this.getTimeoutSeconds()}s. Timing out the session.`,
      );
      onTimeout();
    }, this.timeoutMs);

    this.timers.set(context.chargerId, timer);
  }

  clear(chargerId: string): void {
    const timer = this.timers.get(chargerId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(chargerId);
    }
  }

  clearAll(): void {
    for (const chargerId of this.timers.keys()) {
      this.clear(chargerId);
    }
  }
}

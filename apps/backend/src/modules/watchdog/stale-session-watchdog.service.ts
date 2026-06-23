import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SteveOcppAdapter } from '@packages/ocpp-adapter';
import { WatchdogEventLogService } from './watchdog-event-log.service';

export interface TrackedSession {
  chargerId: string;
  connectorId: number;
  startedAt: string;
}

export interface StaleSessionRecoveryHandler {
  recoverStaleSession(chargerId: string, connectorId: number): Promise<void>;
  getActiveSessions(): TrackedSession[];
}

/**
 * Recovers orphaned charging sessions when a charger disconnects without StopTransaction.
 * Ported from EV3 stale_session_monitor.py.
 */
@Injectable()
export class StaleSessionWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleSessionWatchdogService.name);
  private interval?: NodeJS.Timeout;
  private active = false;
  private recoveryHandler?: StaleSessionRecoveryHandler;

  private readonly thresholdMinutes =
    Number(process.env.STALE_SESSION_THRESHOLD_MINUTES) || 10;
  private readonly checkIntervalSeconds =
    Number(process.env.STALE_SESSION_CHECK_INTERVAL_SECONDS) || 60;
  private readonly maxRecoveryPerCycle =
    Number(process.env.STALE_SESSION_MAX_RECOVERY_PER_CYCLE) || 10;
  private readonly autostart = process.env.STALE_SESSION_AUTOSTART !== '0';

  constructor(
    private readonly eventLog: WatchdogEventLogService,
  ) {}

  onModuleInit(): void {
    if (this.autostart) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  registerRecoveryHandler(handler: StaleSessionRecoveryHandler): void {
    this.recoveryHandler = handler;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.logger.log(
      `[STALE-MONITOR] Started (threshold=${this.thresholdMinutes}m, interval=${this.checkIntervalSeconds}s)`,
    );
    this.eventLog.add('watchdog', 'stale_session_monitor', 'Stale session monitor started');

    // Initial delay so other services can finish booting (matches EV3).
    setTimeout(() => {
      void this.runCycle();
      this.interval = setInterval(() => void this.runCycle(), this.checkIntervalSeconds * 1000);
    }, 30_000);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.eventLog.add('watchdog', 'stale_session_monitor', 'Stale session monitor stopped');
  }

  isActive(): boolean {
    return this.active;
  }

  getConfig() {
    return {
      active: this.active,
      thresholdMinutes: this.thresholdMinutes,
      checkIntervalSeconds: this.checkIntervalSeconds,
    };
  }

  async runCycle(): Promise<{ staleFound: number; recovered: number }> {
    if (!this.recoveryHandler) {
      return { staleFound: 0, recovered: 0 };
    }

    const adapter = this.getAdapter();
    if (!adapter) {
      return { staleFound: 0, recovered: 0 };
    }

    const thresholdMs = this.thresholdMinutes * 60 * 1000;
    const now = Date.now();
    const sessions = this.recoveryHandler.getActiveSessions();
    let staleFound = 0;
    let recovered = 0;

    for (const session of sessions.slice(0, this.maxRecoveryPerCycle)) {
      const info = adapter.getChargerConnectionInfo(session.chargerId);
      if (info.connected) continue;

      const lastSeenMs = info.lastSeenAt ? Date.parse(info.lastSeenAt) : Date.parse(session.startedAt);
      if (Number.isNaN(lastSeenMs) || now - lastSeenMs < thresholdMs) continue;

      staleFound += 1;
      this.logger.warn(
        `[STALE-MONITOR] Recovering orphaned session for ${session.chargerId} (last seen ${info.lastSeenAt ?? 'unknown'})`,
      );

      try {
        await this.recoveryHandler.recoverStaleSession(session.chargerId, session.connectorId);
        recovered += 1;
        this.eventLog.add(
          'stale_session',
          session.chargerId,
          `Recovered stale session after ${this.thresholdMinutes} minutes without heartbeat`,
        );
      } catch (err) {
        this.eventLog.add(
          'watchdog_error',
          session.chargerId,
          `Failed to recover stale session: ${(err as Error).message}`,
        );
      }
    }

    return { staleFound, recovered };
  }

  private getAdapter(): SteveOcppAdapter | null {
    // Injected lazily via ChargingService registration; no direct DI to avoid circular deps.
    return (this as unknown as { _adapter?: SteveOcppAdapter })._adapter ?? null;
  }

  setOcppAdapter(adapter: SteveOcppAdapter): void {
    (this as unknown as { _adapter?: SteveOcppAdapter })._adapter = adapter;
  }
}

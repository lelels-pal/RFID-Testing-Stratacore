import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WatchdogEventLogService } from './watchdog-event-log.service';

export interface HealthSnapshot {
  timestamp: string;
  processHealth: number;
  memoryHealth: number;
  overallHealth: number;
}

/**
 * Lightweight health monitor inspired by EV3 AutonomousHealthMonitor.
 * Tracks process memory and event-loop responsiveness without external deps.
 */
@Injectable()
export class HealthMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthMonitorService.name);
  private interval?: NodeJS.Timeout;
  private active = false;
  private history: HealthSnapshot[] = [];
  private lastSnapshot?: HealthSnapshot;

  private readonly threshold = Number(process.env.HEALTH_MONITOR_THRESHOLD) || 80;
  private readonly intervalSeconds = Number(process.env.HEALTH_MONITOR_INTERVAL_SECONDS) || 30;
  private readonly autostart = process.env.HEALTH_MONITOR_AUTOSTART !== '0';

  constructor(private readonly eventLog: WatchdogEventLogService) {}

  onModuleInit(): void {
    if (this.autostart) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.logger.log('[HEALTH-MONITOR] Started');
    void this.takeSnapshot();
    this.interval = setInterval(() => void this.takeSnapshot(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  getLastSnapshot(): HealthSnapshot | undefined {
    return this.lastSnapshot;
  }

  getHistory(limit = 20): HealthSnapshot[] {
    return this.history.slice(-limit);
  }

  private async takeSnapshot(): Promise<void> {
    const mem = process.memoryUsage();
    const heapUsedMb = mem.heapUsed / (1024 * 1024);
    const heapTotalMb = Math.max(mem.heapTotal, 1) / (1024 * 1024);
    const memoryRatio = heapUsedMb / heapTotalMb;
    const memoryHealth = Math.max(0, Math.min(100, 100 - memoryRatio * 100));

    const lagMs = await this.measureEventLoopLag();
    const processHealth = Math.max(0, Math.min(100, 100 - Math.min(lagMs, 1000) / 10));
    const overallHealth = (memoryHealth + processHealth) / 2;

    const snapshot: HealthSnapshot = {
      timestamp: new Date().toISOString(),
      processHealth,
      memoryHealth,
      overallHealth,
    };

    this.lastSnapshot = snapshot;
    this.history.push(snapshot);
    if (this.history.length > 100) {
      this.history.shift();
    }

    if (overallHealth < this.threshold) {
      this.eventLog.add(
        'health_degraded',
        'health_monitor',
        `Overall health ${overallHealth.toFixed(1)} below threshold ${this.threshold}`,
      );
    }
  }

  private measureEventLoopLag(): Promise<number> {
    const start = process.hrtime.bigint();
    return new Promise((resolve) => {
      setImmediate(() => {
        const end = process.hrtime.bigint();
        resolve(Number(end - start) / 1_000_000);
      });
    });
  }
}

import { Injectable } from '@nestjs/common';
import { ChargeStartWatchdogService } from './charge-start-watchdog.service';
import { HealthMonitorService } from './health-monitor.service';
import { ServiceWatchdogService } from './service-watchdog.service';
import { StaleSessionWatchdogService } from './stale-session-watchdog.service';
import { WatchdogEventLogService } from './watchdog-event-log.service';
import { WatchdogStatusResponse } from './watchdog.types';

@Injectable()
export class WatchdogService {
  constructor(
    private readonly serviceWatchdog: ServiceWatchdogService,
    private readonly staleSessionWatchdog: StaleSessionWatchdogService,
    private readonly chargeStartWatchdog: ChargeStartWatchdogService,
    private readonly healthMonitor: HealthMonitorService,
    private readonly eventLog: WatchdogEventLogService,
  ) {}

  async getStatus(): Promise<WatchdogStatusResponse> {
    const services = await this.serviceWatchdog.checkAllServices();
    const lastHealth = this.healthMonitor.getLastSnapshot()?.overallHealth;

    return {
      active: this.serviceWatchdog.isActive(),
      config: this.serviceWatchdog.getConfig(),
      services,
      chargeStartWatchdogs: this.chargeStartWatchdog.getArmedChargerIds(),
      staleSessionMonitor: this.staleSessionWatchdog.getConfig(),
      healthMonitor: {
        active: this.healthMonitor.isActive(),
        lastOverallHealth: lastHealth,
      },
      restartCounts: this.serviceWatchdog.getRestartCounts(),
      recentEvents: this.eventLog.list(50),
    };
  }

  startServiceWatchdog() {
    return this.serviceWatchdog.start();
  }

  stopServiceWatchdog() {
    return this.serviceWatchdog.stop();
  }

  startStaleSessionMonitor() {
    this.staleSessionWatchdog.start();
    return { success: true, message: 'Stale session monitor started' };
  }

  stopStaleSessionMonitor() {
    this.staleSessionWatchdog.stop();
    return { success: true, message: 'Stale session monitor stopped' };
  }

  startHealthMonitor() {
    this.healthMonitor.start();
    return { success: true, message: 'Health monitor started' };
  }

  stopHealthMonitor() {
    this.healthMonitor.stop();
    return { success: true, message: 'Health monitor stopped' };
  }

  updateServiceWatchdogConfig(partial: {
    checkIntervalSeconds?: number;
    restartCooldownSeconds?: number;
    maxRestartsPerHour?: number;
  }) {
    this.serviceWatchdog.updateConfig(partial);
    return { success: true, config: this.serviceWatchdog.getConfig() };
  }

  getEvents(limit = 50) {
    return { events: this.eventLog.list(limit) };
  }

  async runStaleSessionCheck() {
    return this.staleSessionWatchdog.runCycle();
  }
}

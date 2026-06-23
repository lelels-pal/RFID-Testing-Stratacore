import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as net from 'net';
import { ServiceHealthCheck } from './watchdog.types';
import { WatchdogEventLogService } from './watchdog-event-log.service';

interface MonitoredService {
  id: string;
  displayName: string;
  type: 'http' | 'tcp';
  url?: string;
  host?: string;
  port?: number;
  autoRestart: boolean;
}

/**
 * In-process service health watchdog (StrataSecure-style).
 * Polls configured endpoints and optionally runs restart commands.
 */
@Injectable()
export class ServiceWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceWatchdogService.name);
  private loop?: NodeJS.Timeout;
  private active = false;

  private readonly restartCounts: Record<string, number> = {};
  private readonly restartHistory: Record<string, number[]> = {};
  private readonly lastRestartAt: Record<string, number> = {};

  private readonly config = {
    checkIntervalSeconds: Number(process.env.WATCHDOG_CHECK_INTERVAL_SECONDS) || 30,
    restartCooldownSeconds: Number(process.env.WATCHDOG_RESTART_COOLDOWN_SECONDS) || 60,
    maxRestartsPerHour: Number(process.env.WATCHDOG_MAX_RESTARTS_PER_HOUR) || 5,
  };

  private readonly autostart = process.env.WATCHDOG_AUTOSTART === '1';

  constructor(private readonly eventLog: WatchdogEventLogService) {}

  onModuleInit(): void {
    if (this.autostart) {
      void this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  isActive(): boolean {
    return this.active;
  }

  getConfig() {
    return { ...this.config, enabled: this.active };
  }

  getRestartCounts(): Record<string, number> {
    return { ...this.restartCounts };
  }

  async start(): Promise<{ success: boolean; message?: string; error?: string }> {
    if (this.active) {
      return { success: false, error: 'Watchdog already running' };
    }
    this.active = true;
    this.logger.log('[WATCHDOG] Service watchdog started');
    this.eventLog.add('watchdog', 'service_watchdog', 'Service watchdog started');
    await this.runCycle();
    this.loop = setInterval(() => void this.runCycle(), this.config.checkIntervalSeconds * 1000);
    return { success: true, message: 'Watchdog started' };
  }

  stop(): { success: boolean; message?: string; error?: string } {
    if (!this.active) {
      return { success: false, error: 'Watchdog not running' };
    }
    this.active = false;
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = undefined;
    }
    this.logger.log('[WATCHDOG] Service watchdog stopped');
    this.eventLog.add('watchdog', 'service_watchdog', 'Service watchdog stopped');
    return { success: true, message: 'Watchdog stopped' };
  }

  updateConfig(partial: Partial<typeof this.config>): void {
    if (partial.checkIntervalSeconds != null) {
      this.config.checkIntervalSeconds = Math.max(10, partial.checkIntervalSeconds);
    }
    if (partial.restartCooldownSeconds != null) {
      this.config.restartCooldownSeconds = Math.max(10, partial.restartCooldownSeconds);
    }
    if (partial.maxRestartsPerHour != null) {
      this.config.maxRestartsPerHour = Math.max(1, partial.maxRestartsPerHour);
    }
  }

  getMonitoredServices(): MonitoredService[] {
    const apiPort = Number(process.env.PORT) || 4001;
    const ocppPort = Number(process.env.OCPP_WS_PORT) || 9000;

    return [
      {
        id: 'backend_api',
        displayName: 'Backend API',
        type: 'http',
        url: `http://127.0.0.1:${apiPort}/api/health`,
        autoRestart: false,
      },
      {
        id: 'ocpp_server',
        displayName: 'OCPP WebSocket Server',
        type: 'tcp',
        host: '127.0.0.1',
        port: ocppPort,
        autoRestart: false,
      },
    ];
  }

  async checkAllServices(): Promise<ServiceHealthCheck[]> {
    const checks = await Promise.all(
      this.getMonitoredServices().map(async (service) => this.checkService(service)),
    );
    return checks;
  }

  private async runCycle(): Promise<void> {
    try {
      const statuses = await this.checkAllServices();
      for (const status of statuses) {
        if (status.status === 'down') {
          const service = this.getMonitoredServices().find((s) => s.id === status.id);
          if (service?.autoRestart) {
            await this.tryAutoRestart(service.id, status.detail ?? 'Service down');
          }
        }
      }
    } catch (err) {
      this.logger.error(`Watchdog cycle error: ${(err as Error).message}`);
      this.eventLog.add('watchdog_error', 'service_watchdog', (err as Error).message);
    }
  }

  private async checkService(service: MonitoredService): Promise<ServiceHealthCheck> {
    const lastCheck = new Date().toISOString();
    try {
      if (service.type === 'http' && service.url) {
        const response = await fetch(service.url, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          return { id: service.id, displayName: service.displayName, status: 'healthy', lastCheck };
        }
        return {
          id: service.id,
          displayName: service.displayName,
          status: 'degraded',
          detail: `HTTP ${response.status}`,
          lastCheck,
        };
      }

      if (service.type === 'tcp' && service.host && service.port) {
        const open = await this.checkTcp(service.host, service.port);
        return {
          id: service.id,
          displayName: service.displayName,
          status: open ? 'healthy' : 'down',
          detail: open ? 'TCP socket open' : 'TCP connection refused',
          lastCheck,
        };
      }

      return {
        id: service.id,
        displayName: service.displayName,
        status: 'unknown',
        detail: 'Unsupported check type',
        lastCheck,
      };
    } catch (err) {
      return {
        id: service.id,
        displayName: service.displayName,
        status: 'down',
        detail: (err as Error).message,
        lastCheck,
      };
    }
  }

  private checkTcp(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 3000 });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private canAutoRestart(serviceId: string): boolean {
    const now = Date.now();
    const last = this.lastRestartAt[serviceId];
    if (last && now - last < this.config.restartCooldownSeconds * 1000) {
      return false;
    }

    const hourAgo = now - 60 * 60 * 1000;
    const recent = (this.restartHistory[serviceId] ?? []).filter((t) => t > hourAgo);
    return recent.length < this.config.maxRestartsPerHour;
  }

  private recordRestart(serviceId: string): void {
    const now = Date.now();
    this.lastRestartAt[serviceId] = now;
    this.restartCounts[serviceId] = (this.restartCounts[serviceId] ?? 0) + 1;
    this.restartHistory[serviceId] = [...(this.restartHistory[serviceId] ?? []), now].filter(
      (t) => t > now - 60 * 60 * 1000,
    );
  }

  private async tryAutoRestart(serviceId: string, reason: string): Promise<void> {
    if (!this.canAutoRestart(serviceId)) return;

    const command = process.env[`WATCHDOG_RESTART_COMMAND_${serviceId.toUpperCase()}`]
      ?? process.env.WATCHDOG_RESTART_COMMAND;

    if (!command) {
      this.logger.debug(`No restart command configured for ${serviceId}`);
      return;
    }

    this.logger.warn(`[AUTO-RESTART] ${serviceId}: ${reason}`);
    this.eventLog.add('auto_restart', serviceId, reason);

    try {
      const { exec } = await import('child_process');
      await new Promise<void>((resolve, reject) => {
        exec(command, (error) => (error ? reject(error) : resolve()));
      });
      this.recordRestart(serviceId);
      this.eventLog.add('restart_success', serviceId, 'Auto-restart command completed');
    } catch (err) {
      this.eventLog.add('restart_failed', serviceId, (err as Error).message);
    }
  }
}

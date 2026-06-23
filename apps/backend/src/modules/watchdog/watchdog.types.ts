export type WatchdogEventType =
  | 'watchdog'
  | 'watchdog_error'
  | 'auto_restart'
  | 'restart_success'
  | 'restart_failed'
  | 'stale_session'
  | 'charge_start_timeout'
  | 'health_degraded';

export interface WatchdogEvent {
  timestamp: string;
  type: WatchdogEventType;
  source: string;
  message: string;
}

export interface WatchdogConfig {
  enabled: boolean;
  checkIntervalSeconds: number;
  restartCooldownSeconds: number;
  maxRestartsPerHour: number;
}

export interface ServiceHealthCheck {
  id: string;
  displayName: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  detail?: string;
  lastCheck: string;
}

export interface StaleSessionInfo {
  chargerId: string;
  startedAt: string;
  lastSeenAt?: string;
  connected: boolean;
}

export interface WatchdogStatusResponse {
  active: boolean;
  config: WatchdogConfig;
  services: ServiceHealthCheck[];
  chargeStartWatchdogs: string[];
  staleSessionMonitor: {
    active: boolean;
    thresholdMinutes: number;
    checkIntervalSeconds: number;
  };
  healthMonitor: {
    active: boolean;
    lastOverallHealth?: number;
  };
  restartCounts: Record<string, number>;
  recentEvents: WatchdogEvent[];
}

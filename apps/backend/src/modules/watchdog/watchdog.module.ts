import { Module } from '@nestjs/common';
import { ChargeStartWatchdogService } from './charge-start-watchdog.service';
import { HealthMonitorService } from './health-monitor.service';
import { ServiceWatchdogService } from './service-watchdog.service';
import { StaleSessionWatchdogService } from './stale-session-watchdog.service';
import { WatchdogController } from './watchdog.controller';
import { WatchdogEventLogService } from './watchdog-event-log.service';
import { WatchdogService } from './watchdog.service';

@Module({
  controllers: [WatchdogController],
  providers: [
    WatchdogEventLogService,
    ChargeStartWatchdogService,
    StaleSessionWatchdogService,
    ServiceWatchdogService,
    HealthMonitorService,
    WatchdogService,
  ],
  exports: [
    ChargeStartWatchdogService,
    StaleSessionWatchdogService,
    WatchdogEventLogService,
  ],
})
export class WatchdogModule {}

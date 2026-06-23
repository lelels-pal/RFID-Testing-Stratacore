import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { WatchdogService } from './watchdog.service';

class WatchdogConfigUpdateDto {
  checkIntervalSeconds?: number;
  restartCooldownSeconds?: number;
  maxRestartsPerHour?: number;
}

@Controller('api/watchdog')
export class WatchdogController {
  constructor(private readonly watchdogService: WatchdogService) {}

  @Get()
  getStatus() {
    return this.watchdogService.getStatus();
  }

  @Post('start')
  startServiceWatchdog() {
    return this.watchdogService.startServiceWatchdog();
  }

  @Post('stop')
  stopServiceWatchdog() {
    return this.watchdogService.stopServiceWatchdog();
  }

  @Put('config')
  updateConfig(@Body() body: WatchdogConfigUpdateDto) {
    return this.watchdogService.updateServiceWatchdogConfig(body);
  }

  @Get('events')
  getEvents(@Query('limit') limit?: string) {
    return this.watchdogService.getEvents(limit ? Number(limit) : 50);
  }

  @Post('stale-sessions/check')
  runStaleSessionCheck() {
    return this.watchdogService.runStaleSessionCheck();
  }

  @Post('stale-sessions/start')
  startStaleSessionMonitor() {
    return this.watchdogService.startStaleSessionMonitor();
  }

  @Post('stale-sessions/stop')
  stopStaleSessionMonitor() {
    return this.watchdogService.stopStaleSessionMonitor();
  }

  @Post('health/start')
  startHealthMonitor() {
    return this.watchdogService.startHealthMonitor();
  }

  @Post('health/stop')
  stopHealthMonitor() {
    return this.watchdogService.stopHealthMonitor();
  }
}

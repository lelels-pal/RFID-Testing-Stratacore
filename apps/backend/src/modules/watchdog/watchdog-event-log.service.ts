import { Injectable } from '@nestjs/common';
import { WatchdogEvent, WatchdogEventType } from './watchdog.types';

@Injectable()
export class WatchdogEventLogService {
  private readonly events: WatchdogEvent[] = [];
  private readonly maxEvents = 100;

  add(type: WatchdogEventType, source: string, message: string): WatchdogEvent {
    const event: WatchdogEvent = {
      timestamp: new Date().toISOString(),
      type,
      source,
      message,
    };
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }
    return event;
  }

  list(limit = 50): WatchdogEvent[] {
    return this.events.slice(0, limit);
  }
}

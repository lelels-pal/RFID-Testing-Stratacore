import { Injectable } from '@nestjs/common';
import { OcppTraceEntry } from '@packages/shared';

@Injectable()
export class OcppTraceService {
  private readonly entries: OcppTraceEntry[] = [];
  private readonly maxEntries = 200;

  add(entry: OcppTraceEntry): OcppTraceEntry {
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    return entry;
  }

  list(limit = 50, rfidOnly = false): OcppTraceEntry[] {
    const filtered = rfidOnly
      ? this.entries.filter((entry) => entry.isRfidRelated)
      : this.entries;
    return filtered.slice(0, limit);
  }
}

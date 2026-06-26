import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SessionLogEntry, SessionType } from '@packages/shared';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../database/prisma.service';
import { config } from '../../config/app.config';

export interface LogSessionInput {
  sessionType: SessionType;
  chargerId: string;
  connectorId: number;
  rfidCardId?: string;
  cardholderName?: string;
  energyKwh: number;
  startedAt?: string;
  stopReason?: string;
  userId?: number;
}

@Injectable()
export class SessionLogService {
  private readonly logger = new Logger(SessionLogService.name);
  private readonly filePath = path.join(process.cwd(), 'sessions-log.json');
  private entries: SessionLogEntry[] = [];

  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {
    if (!this.prisma.isReady()) {
      this.loadFile();
    }
  }

  private loadFile() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      } else {
        fs.writeFileSync(this.filePath, '[]', 'utf-8');
      }
    } catch {
      this.entries = [];
    }
  }

  private saveFile() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  async append(input: LogSessionInput): Promise<SessionLogEntry> {
    const costPerKwh = this.settings.get().costPerKwh;
    const entry: SessionLogEntry = {
      id: randomUUID(),
      sessionType: input.sessionType,
      chargerId: input.chargerId,
      connectorId: input.connectorId,
      rfidCardId: input.rfidCardId,
      cardholderName: input.cardholderName,
      energyKwh: parseFloat(input.energyKwh.toFixed(4)),
      costEstimate: parseFloat((input.energyKwh * costPerKwh).toFixed(2)),
      startedAt: input.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      stopReason: input.stopReason,
    };

    if (this.prisma.isReady()) {
      try {
        const session = await this.prisma.session.create({
          data: {
            charge_point_id: input.chargerId,
            status: 'completed',
            start_time: input.startedAt ? new Date(input.startedAt) : new Date(),
            end_time: new Date(),
            energy_kwh: input.energyKwh,
            session_type: input.sessionType,
            initiated_by_user_id: input.userId ?? null,
            transaction_id: entry.id,
          },
        });
        entry.id = String(session.id);
        if (input.userId) {
          await this.prisma.customerActivity.create({
            data: {
              user_id: input.userId,
              session_id: session.id,
              energy_kwh: input.energyKwh,
              amount: entry.costEstimate,
              payment_method: input.sessionType === 'rfid' ? 'rfid' : 'guest',
              reference: entry.id,
            },
          });
        }
      } catch (err) {
        this.logger.error('Failed to write session to MySQL', err);
      }
    } else {
      this.entries.unshift(entry);
      if (this.entries.length > 5000) this.entries = this.entries.slice(0, 5000);
      this.saveFile();
    }
    return entry;
  }

  async list(days = 30, rfidCardId?: string): Promise<SessionLogEntry[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    if (this.prisma.isReady()) {
      const sessions = await this.prisma.session.findMany({
        where: {
          end_time: { gte: new Date(cutoff) },
          ...(rfidCardId
            ? {
                initiated_by_user_id: {
                  in: (
                    await this.prisma.user.findMany({
                      where: { rfid_tag: rfidCardId },
                      select: { id: true },
                    })
                  ).map((u) => u.id),
                },
              }
            : {}),
        },
        orderBy: { end_time: 'desc' },
        take: 500,
      });
      const costPerKwh = config.pricePerKwh;
      const userIds = sessions.map((s) => s.initiated_by_user_id).filter(Boolean) as number[];
      const users = userIds.length
        ? await this.prisma.user.findMany({ where: { id: { in: userIds } } })
        : [];
      const userMap = new Map(users.map((u) => [u.id, u]));
      return sessions.map((s) => {
        const user = s.initiated_by_user_id ? userMap.get(s.initiated_by_user_id) : undefined;
        const kwh = s.energy_kwh != null ? Number(s.energy_kwh) : 0;
        return {
          id: String(s.id),
          sessionType: (s.session_type as SessionType) || 'rfid',
          chargerId: s.charge_point_id || '',
          connectorId: 1,
          rfidCardId: user?.rfid_tag || undefined,
          cardholderName: user?.full_name || undefined,
          energyKwh: kwh,
          costEstimate: parseFloat((kwh * costPerKwh).toFixed(2)),
          startedAt: s.start_time?.toISOString() || '',
          endedAt: s.end_time?.toISOString() || '',
        };
      });
    }

    return this.entries.filter((e) => {
      if (Date.parse(e.endedAt) < cutoff) return false;
      if (rfidCardId && e.rfidCardId?.toUpperCase() !== rfidCardId.toUpperCase()) return false;
      return true;
    });
  }
}

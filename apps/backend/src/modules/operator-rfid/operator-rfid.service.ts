import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { config } from '../../config/app.config';
import { findUserByRfidTag } from '../users/user.mapper';

export type AuthorizeStatus = 'Accepted' | 'Invalid' | 'Blocked';

export interface OperatorSessionContext {
  userId: number;
  rfidTag: string;
  connectorId: number;
  lastEnergyKwh: number;
  sessionId?: number;
  transactionId?: string;
}

const STAFF_ROLES = new Set(['staff', 'employee', 'operator']);

const SYSTEM_BYPASS_TAGS = new Set([
  'REMOTE', 'REMOTE_001', 'ADMIN', 'TEST', 'DEMO', 'GUEST',
]);

@Injectable()
export class OperatorRfidService {
  private readonly logger = new Logger(OperatorRfidService.name);
  private readonly activeSessions = new Map<string, OperatorSessionContext>();

  constructor(private readonly prisma: PrismaService) {}

  isSystemBypassTag(idTag: string): boolean {
    const normalized = idTag?.trim().toUpperCase() || '';
    if (!normalized) return false;
    if (SYSTEM_BYPASS_TAGS.has(normalized)) return true;
    if (normalized.startsWith('REMOTE_') || normalized.startsWith('GUEST-')) return true;
    return false;
  }

  async getUserByRfidTag(rfidTag: string): Promise<User | null> {
    if (!this.prisma.isReady()) return null;
    return findUserByRfidTag(this.prisma, rfidTag);
  }

  private async getStaffUser(idTag: string): Promise<User | null> {
    const user = await this.getUserByRfidTag(idTag);
    if (!user) return null;
    const role = (user.role || '').trim().toLowerCase();
    if (!STAFF_ROLES.has(role)) return null;
    return user;
  }

  async authorizeStaff(idTag: string): Promise<{ status: AuthorizeStatus; user: User | null }> {
    if (this.isSystemBypassTag(idTag)) {
      return { status: 'Accepted', user: null };
    }
    const user = await this.getStaffUser(idTag);
    if (!user) return { status: 'Invalid', user: null };
    if (!user.is_active) return { status: 'Blocked', user };
    const balance = user.balance != null ? Number(user.balance) : 0;
    if (balance <= config.operatorMinBalanceKwh) {
      return { status: 'Blocked', user };
    }
    return { status: 'Accepted', user };
  }

  registerSessionContext(
    chargerId: string,
    userId: number,
    rfidTag: string,
    connectorId: number,
    sessionId?: number,
    transactionId?: string,
  ): void {
    this.activeSessions.set(chargerId, {
      userId,
      rfidTag: rfidTag.trim().toUpperCase(),
      connectorId,
      lastEnergyKwh: 0,
      sessionId,
      transactionId,
    });
  }

  getSessionContext(chargerId: string): OperatorSessionContext | undefined {
    return this.activeSessions.get(chargerId);
  }

  clearSession(chargerId: string): void {
    this.activeSessions.delete(chargerId);
  }

  async applyEnergyDelta(
    chargerId: string,
    cumulativeSessionKwh: number,
  ): Promise<{ appliedDeltaKwh: number; remainingBalanceKwh: number; shouldStop: boolean }> {
    const ctx = this.activeSessions.get(chargerId);
    if (!ctx || !this.prisma.isReady()) {
      return { appliedDeltaKwh: 0, remainingBalanceKwh: 0, shouldStop: false };
    }

    const cumulative = Math.max(0, cumulativeSessionKwh);
    const delta = Math.max(0, cumulative - ctx.lastEnergyKwh);
    const user = await this.prisma.user.findUnique({ where: { id: ctx.userId } });
    if (!user) {
      this.clearSession(chargerId);
      return { appliedDeltaKwh: 0, remainingBalanceKwh: 0, shouldStop: false };
    }

    const currentBalance = user.balance != null ? Number(user.balance) : 0;
    if (delta <= 0) {
      return {
        appliedDeltaKwh: 0,
        remainingBalanceKwh: currentBalance,
        shouldStop: currentBalance <= config.operatorMinBalanceKwh,
      };
    }

    const newBalance = Math.max(0, currentBalance - delta);
    await this.prisma.user.update({
      where: { id: ctx.userId },
      data: { balance: newBalance },
    });
    ctx.lastEnergyKwh = cumulative;

    const shouldStop = newBalance <= config.operatorMinBalanceKwh;
    if (shouldStop) {
      this.logger.warn(`Operator ${ctx.userId} balance ${newBalance} kWh — auto-stop ${chargerId}`);
    }
    return { appliedDeltaKwh: delta, remainingBalanceKwh: newBalance, shouldStop };
  }

  async finalizeEnergy(chargerId: string, totalEnergyKwh: number) {
    const result = await this.applyEnergyDelta(chargerId, totalEnergyKwh);
    this.clearSession(chargerId);
    return result;
  }
}

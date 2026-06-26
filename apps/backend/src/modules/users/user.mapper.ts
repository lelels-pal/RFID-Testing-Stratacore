import { User } from '@prisma/client';
import { OperatorProfile, RfidCard } from '@packages/shared';
import { config } from '../../config/app.config';

const ADMIN_ROLES = new Set(['master', 'admin', 'owner', 'client']);
const OPERATOR_ROLES = new Set(['staff', 'employee', 'operator']);

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.has((role || '').toLowerCase());
}

export function isOperatorRole(role: string): boolean {
  return OPERATOR_ROLES.has((role || '').toLowerCase());
}

export function userBalanceKwh(user: User): number {
  return user.balance != null ? Number(user.balance) : 0;
}

export function userToRfidCard(user: User): RfidCard {
  const base = config.operatorBaseBalance;
  const remaining = userBalanceKwh(user);
  const consumed = Math.max(0, base - remaining);
  return {
    rfidCardId: user.rfid_tag?.toUpperCase() || `USER_${user.id}`,
    cardholderName: user.full_name || user.username,
    monthlyKwhLimit: base,
    currentMonthKwhConsumed: parseFloat(consumed.toFixed(4)),
    lastResetDate: user.updated_at.toISOString(),
    isActive: user.is_active,
    username: user.username,
    role: 'operator',
  };
}

export function userToOperatorProfile(user: User): OperatorProfile {
  const base = config.operatorBaseBalance;
  const balance = userBalanceKwh(user);
  return {
    rfid_tag: user.rfid_tag || '',
    cardholderName: user.full_name || user.username,
    username: user.username,
    role: 'operator',
    balance: parseFloat(balance.toFixed(4)),
    base_balance_kwh: base,
    currentMonthKwhConsumed: parseFloat(Math.max(0, base - balance).toFixed(4)),
    isActive: user.is_active,
  };
}

export async function findUserByRfidTag(
  prisma: { user: { findMany: (args: object) => Promise<User[]> } },
  rfidTag: string,
): Promise<User | null> {
  const normalized = rfidTag.trim().toUpperCase();
  if (!normalized) return null;
  const users = await prisma.user.findMany({ where: { rfid_tag: { not: null } } });
  return users.find((u) => u.rfid_tag?.toUpperCase() === normalized) ?? null;
}

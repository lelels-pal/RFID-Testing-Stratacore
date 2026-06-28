import { RfidCard } from '@packages/shared';

export function getRfidStopBufferKwh(): number {
  const raw = Number(process.env.RFID_STOP_BUFFER_KWH);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

export function getRfidRemainingKwh(card: Pick<RfidCard, 'monthlyKwhLimit' | 'currentMonthKwhConsumed'>): number {
  return Math.max(0, card.monthlyKwhLimit - card.currentMonthKwhConsumed);
}

export function isRfidQuotaBlocked(
  card: Pick<RfidCard, 'monthlyKwhLimit' | 'currentMonthKwhConsumed'>,
  bufferKwh = getRfidStopBufferKwh(),
): boolean {
  return getRfidRemainingKwh(card) <= bufferKwh;
}

export function rfidQuotaBlockedMessage(
  card: Pick<RfidCard, 'monthlyKwhLimit' | 'currentMonthKwhConsumed'>,
  bufferKwh = getRfidStopBufferKwh(),
): string {
  const remaining = getRfidRemainingKwh(card);
  return `Monthly allocation nearly exhausted (${remaining.toFixed(2)} kWh remaining, ${bufferKwh} kWh buffer). Request more kWh in the customer app.`;
}

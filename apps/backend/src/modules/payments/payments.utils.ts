import { MayaPaymentRecord } from './maya-payment.service';

export function resolveMayaPaymentStatus(record: MayaPaymentRecord): string {
  return record.status || record.paymentStatus || '';
}

export function isMayaPaymentSuccessful(record: MayaPaymentRecord): boolean {
  const status = resolveMayaPaymentStatus(record);
  if (status === 'PAYMENT_SUCCESS' || status === 'CAPTURED') return true;
  return record.isPaid === true;
}

export function parseMayaPaymentAmount(
  record: MayaPaymentRecord,
): { value: number; currency: string } | null {
  const nested = record.totalAmount || (typeof record.amount === 'object' ? record.amount : null);
  if (nested?.value != null && nested.currency) {
    const value = Number(nested.value);
    if (!Number.isNaN(value)) {
      return { value, currency: nested.currency.toUpperCase() };
    }
  }

  if (record.amount != null && record.currency) {
    const value = Number(record.amount);
    if (!Number.isNaN(value)) {
      return { value, currency: record.currency.toUpperCase() };
    }
  }

  return null;
}

export function amountsMatch(expected: number, actual: number, tolerance = 0.01): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

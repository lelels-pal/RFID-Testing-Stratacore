import { OperatorProfile } from '@packages/shared';
import { getUser } from './auth';

export interface RfidProfile {
  rfid_tag: string;
  name: string;
  username?: string;
}

const STORAGE_KEY = 'operator_rfid_profile';

export function formatRfidTag(tag: string): string {
  return tag.trim().toUpperCase();
}

export function getRfidProfile(): RfidProfile | null {
  const user = getUser();
  if (user?.rfid_tag) {
    return {
      rfid_tag: formatRfidTag(user.rfid_tag),
      name: user.cardholderName,
      username: user.username,
    };
  }

  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RfidProfile) : null;
  } catch {
    return null;
  }
}

export function syncRfidProfileFromUser(user: OperatorProfile): void {
  if (!user.rfid_tag) return;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      rfid_tag: formatRfidTag(user.rfid_tag),
      name: user.cardholderName,
      username: user.username,
    }),
  );
}

export function clearRfidProfile(): void {
  localStorage.removeItem(STORAGE_KEY);
}

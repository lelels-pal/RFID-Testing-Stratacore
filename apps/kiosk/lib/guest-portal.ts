import { getGuestAppBaseUrl } from '@packages/shared';

export function getGuestPortalLoginUrl(): string {
  const base = getGuestAppBaseUrl({
    envUrl: process.env.NEXT_PUBLIC_GUEST_PORTAL_URL,
    origin:
      typeof window !== 'undefined'
        ? { protocol: window.location.protocol, hostname: window.location.hostname }
        : undefined,
  });
  return `${base}/auth/login`;
}

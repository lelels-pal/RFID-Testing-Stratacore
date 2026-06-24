export const STRATACORE_DOMAIN = 'stratacore.tech';

export interface UrlOrigin {
  protocol: string;
  hostname: string;
}

function isStratacoreHost(hostname: string): boolean {
  return hostname === STRATACORE_DOMAIN || hostname.endsWith(`.${STRATACORE_DOMAIN}`);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** Public API base URL (NestJS + Socket.IO). */
export function getApiBaseUrl(options?: {
  envUrl?: string;
  origin?: UrlOrigin;
}): string {
  const envUrl = options?.envUrl?.trim();
  if (envUrl) return stripTrailingSlash(envUrl);

  const origin = options?.origin;
  if (origin) {
    const { protocol, hostname } = origin;
    if (isStratacoreHost(hostname)) {
      return `${protocol}//api.${STRATACORE_DOMAIN}`;
    }
    return `${protocol}//${hostname}:4001`;
  }

  return 'http://localhost:4001';
}

/** Guest mobile web app base URL (QR claim links). */
export function getGuestAppBaseUrl(options?: {
  envUrl?: string;
  origin?: UrlOrigin;
}): string {
  const envUrl = options?.envUrl?.trim();
  if (envUrl) return stripTrailingSlash(envUrl);

  const origin = options?.origin;
  if (origin) {
    const { protocol, hostname } = origin;
    if (isStratacoreHost(hostname)) {
      return `${protocol}//guest.${STRATACORE_DOMAIN}`;
    }
    return `${protocol}//${hostname}:3002`;
  }

  return 'http://localhost:3002';
}

export function buildGuestClaimUrl(
  rawToken: string,
  options?: {
    guestAppUrl?: string;
    origin?: UrlOrigin;
  }
): string {
  const base = getGuestAppBaseUrl({
    envUrl: options?.guestAppUrl,
    origin: options?.origin,
  });
  return `${base}/claim?token=${rawToken}`;
}

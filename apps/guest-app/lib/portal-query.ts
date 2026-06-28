export function buildPortalQuery(params: {
  mac?: string;
  ip?: string;
  stationId?: number | string;
}): string {
  const qs = new URLSearchParams();
  if (params.mac) qs.set('mac', params.mac);
  if (params.ip) qs.set('ip', params.ip);
  if (params.stationId) qs.set('station_id', String(params.stationId));
  const query = qs.toString();
  return query ? `?${query}` : '';
}

type SearchParamsLike = Pick<URLSearchParams, 'get'>;

export function buildPortalReturnUrl(searchParams: SearchParamsLike): string {
  const mac = searchParams.get('mac') || searchParams.get('id') || '';
  const ip = searchParams.get('ip') || '';
  const stationId = searchParams.get('station_id') || searchParams.get('nasid') || '1';
  return `/portal${buildPortalQuery({ mac, ip, stationId })}`;
}

export function buildLoginUrl(searchParams: SearchParamsLike): string {
  const mac = searchParams.get('mac') || searchParams.get('id') || '';
  const ip = searchParams.get('ip') || '';
  const stationId = searchParams.get('station_id') || searchParams.get('nasid') || '1';
  return `/auth/login${buildPortalQuery({ mac, ip, stationId })}`;
}

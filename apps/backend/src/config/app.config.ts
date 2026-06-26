import 'dotenv/config';

/** Build DATABASE_URL from EdgeTechEV-style DB_* vars when not set explicitly. */
export function buildDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL?.trim()) {
    return process.env.DATABASE_URL.trim();
  }
  const host = process.env.DB_HOST?.trim();
  if (!host) return undefined;
  const port = process.env.DB_PORT || '3306';
  const user = encodeURIComponent(process.env.DB_USER || 'root');
  const pass = encodeURIComponent(process.env.DB_PASSWORD || '');
  const name = process.env.DB_NAME || 'ev_charger_backend';
  return `mysql://${user}:${pass}@${host}:${port}/${name}`;
}

export function isMysqlEnabled(): boolean {
  if (process.env.USE_SQLITE === 'true') return false;
  const dbType = (process.env.DB_TYPE || 'mysql').toLowerCase();
  if (dbType !== 'mysql') return false;
  return Boolean(buildDatabaseUrl());
}

// Ensure Prisma sees DATABASE_URL at runtime
const builtUrl = buildDatabaseUrl();
if (builtUrl && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = builtUrl;
}

const DEFAULT_DEV_CORS = [
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'https://admin.stratacore.tech',
  'https://guest.stratacore.tech',
];

function resolveCorsOrigins(): string[] | boolean {
  const fromEnv =
    process.env.CORS_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];
  if (fromEnv.length) return fromEnv;
  return DEFAULT_DEV_CORS;
}

export const config = {
  port: Number(process.env.PORT || process.env.BACKEND_PORT) || 4001,
  ocppWsPort: Number(process.env.OCPP_WS_PORT || process.env.OCPP_PORT) || 9000,
  ocppWsPath: process.env.OCPP_WS_PATH || '/ocpp',
  ocppHost: process.env.OCPP_HOST || '0.0.0.0',
  pricePerKwh: Number(process.env.PRICE_PER_KWH) || 15,
  jwtSecret:
    process.env.JWT_SECRET_KEY ||
    process.env.JWT_SECRET ||
    'dev-secret-change-in-production-min-32-chars',
  jwtExpireMinutes: Number(process.env.JWT_ACCESS_TOKEN_EXPIRE_MINUTES) || 720,
  operatorBaseBalance: Number(process.env.OPERATOR_BASE_BALANCE) || 200,
  operatorMinBalanceKwh: Number(process.env.OPERATOR_MIN_BALANCE_KWH) || 5,
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || process.env.ADMIN_DEFAULT_PASSWORD || 'master123',
  corsOrigins: resolveCorsOrigins(),
  mysqlEnabled: isMysqlEnabled(),
};

export function setOperatorBaseBalance(kwh: number): number {
  if (kwh <= 0 || kwh > 10000) {
    throw new Error('Base balance must be between 0 and 10000 kWh');
  }
  process.env.OPERATOR_BASE_BALANCE = String(kwh);
  config.operatorBaseBalance = kwh;
  return kwh;
}

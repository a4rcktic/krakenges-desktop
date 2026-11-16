import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requiredInProduction(key: string, fallback: string): string {
  const value = process.env[key];
  if (value) return value;
  if (isProduction) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction,
  port: envInt('PORT', 4000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: requiredInProduction(
    'DATABASE_URL',
    'postgres://krakenges_app:dev@127.0.0.1:5432/krakenges',
  ),
  dbPoolMax: envInt('DB_POOL_MAX', 20),
  jwtSecret: requiredInProduction('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  sessionsPageSize: envInt('SESSIONS_PAGE_SIZE', 20),
  licenseKeysDir:
    process.env.KRAKENGES_LICENSE_KEYS_DIR ||
    process.env.MASKOS_LICENSE_KEYS_DIR ||
    './.keys',
  logLevel: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
};

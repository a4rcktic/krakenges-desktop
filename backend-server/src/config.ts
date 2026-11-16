import dotenv from 'dotenv';
dotenv.config();

function envString(key: string, fallback?: string): string {
  const value = process.env[key];
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: envInt('PORT', 4000),
  mongodbUri: envString('MONGODB_URI'),
  jwtSecret: envString('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  sessionsPageSize: envInt('SESSIONS_PAGE_SIZE', 20),
  licenseKeysDir: process.env.KRAKENGES_LICENSE_KEYS_DIR ?? './.keys',
};

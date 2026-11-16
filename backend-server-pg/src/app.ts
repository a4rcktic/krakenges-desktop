import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { sql } from 'drizzle-orm';
import { config } from './config';
import { logger } from './logger';
import type { Database } from './db/client';
import profilesRouter from './routes/profiles';
import fingerprintRouter from './routes/fingerprint';
import usersRouter from './routes/users';
import authRouter from './routes/auth';
import keysRouter from './routes/keys';
import dashboardRouter from './routes/dashboard';
import activityRouter from './routes/activity';
import apikeysRouter from './routes/apikeys';
import membershipRouter from './routes/membership';
import contentRouter from './routes/content';
import sessionsRouter from './routes/sessions';
import updatesRouter from './routes/updates';
import { errorHandler } from './errors';
import { sanitizeInput } from './middleware/sanitize';
import { asyncHandler } from './utils/asyncHandler';
import { PUBLIC_BASE_URL } from './config/publicUrls';

export interface AppDependencies {
  db: Database;
}

export function createApp({ db }: AppDependencies) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.db = db;

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  let publicOrigin: string | null = null;
  try {
    publicOrigin = new URL(PUBLIC_BASE_URL).origin;
  } catch {
    // PUBLIC_BASE_URL puede ser un placeholder en desarrollo.
  }

  const allowedOrigins = [
    ...(publicOrigin ? [publicOrigin] : []),
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    ...(config.corsOrigin && config.corsOrigin !== '*'
      ? config.corsOrigin.split(',').map((s) => s.trim().replace(/\/$/, ''))
      : []),
  ];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('file://')) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    }),
  );

  // Los estados de navegador pueden ocupar varios MB entre cookies y
  // localStorage. El límite antiguo de 5 MB no cubría ambos campos.
  app.use(express.json({ limit: '15mb' }));
  app.use(sanitizeInput);
  app.use(cookieParser());

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          // No registrar la query: puede contener claves de licencia,
          // tokens de recuperación o correos electrónicos.
          url: req.path,
          status: res.statusCode,
          ms: Date.now() - startedAt,
          ip: req.ip,
        },
        'request',
      );
    });
    next();
  });

  const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', apiRateLimiter);

  const healthHandler = asyncHandler(async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({
        status: 'error',
        database: 'unavailable',
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  app.get('/', (_req, res) => {
    res.json({ message: 'Gestor web backend activo' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/profiles', profilesRouter);
  app.use('/api/fingerprint', fingerprintRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/activity', activityRouter);
  app.use('/api/apikeys', apikeysRouter);
  app.use('/api/membership', membershipRouter);
  app.use('/api/content', contentRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/updates', updatesRouter);

  app.use(errorHandler);

  return app;
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { logger, setupLogRotation } from './logger';
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
import { connectDatabase } from './db';
import { errorHandler } from './errorMiddleware';
import { sanitizeInput } from './sanitizeMiddleware';
import { PUBLIC_BASE_URL } from './config/publicUrls';

dotenv.config();

setupLogRotation();

const app = express();

// Express anuncia su versión en cada respuesta; no aporta nada y facilita el
// escaneo automático.
app.disable('x-powered-by');

// Cabeceras de seguridad HTTP. Estaban importadas pero NUNCA aplicadas: el
// servicio se servía sin HSTS, sin CSP y sin X-Frame-Options.
app.use(
  helmet({
    // La API sirve JSON y, en desarrollo, el bundle de Vite en otro origen.
    contentSecurityPolicy: false,
    // Necesario para que el cliente Tauri/Electron (origen file://) pueda
    // leer la respuesta con credenciales.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.set('trust proxy', 1);
const allowedOrigins = [
  // La web pública (PUBLIC_BASE_URL o, si falta, la de brand.config.json).
  new URL(PUBLIC_BASE_URL).origin,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  ...(config.corsOrigin && config.corsOrigin !== '*'
    ? config.corsOrigin.split(',').map((s) => s.trim().replace(/\/$/, ''))
    : []),
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('file://')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(sanitizeInput);
app.use(cookieParser());

app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url, ip: req.ip }, 'request');
  next();
});

const apiRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiRateLimiter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({ message: 'Kraken Ges backend activo' });
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

const HOST = process.env.HOST ?? '127.0.0.1';
const server = app.listen(config.port, HOST, () => {
  logger.info({ port: config.port }, 'Backend iniciado');
});

const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, 'Recibida señal de apagado');
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('Servidor cerrado correctamente');
  } catch (err) {
    logger.error({ err }, 'Error durante el apagado');
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception');
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection');
});

connectDatabase().then(() => {
  logger.info('Base de datos conectada');
}).catch((err) => {
  logger.error({ err }, 'No se pudo conectar a la base de datos');
  process.exit(1);
});

import type { Request } from 'express';
import type { Database } from './client';

/** La instancia de base de datos vive en `app.locals.db` (inyectada por createApp). */
export function dbOf(req: Request): Database {
  return req.app.locals.db as Database;
}

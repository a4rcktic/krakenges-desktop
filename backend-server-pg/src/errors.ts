import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { logger } from './logger';

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export const errorHandler: ErrorRequestHandler = (
  err: Error & { statusCode?: number; code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  let statusCode = err.statusCode ?? 500;
  let message = err.message || 'Error interno del servidor';

  // Violación de unicidad de PostgreSQL. No se expone el detalle de la
  // restricción porque puede revelar nombres de columnas o valores.
  if (err.code === '23505') {
    statusCode = 409;
    message = 'El recurso ya existe.';
  }

  if (statusCode >= 500) {
    logger.error({ statusCode, message, stack: err.stack }, 'request failed');
  }

  if (statusCode === 500 && process.env.NODE_ENV === 'production') {
    message = 'Error interno del servidor';
  }

  res.status(statusCode).json({
    error: message,
    code: statusCode,
    timestamp: new Date().toISOString(),
  });
};

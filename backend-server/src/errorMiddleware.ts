import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'error' });

export interface CustomError extends Error {
  statusCode?: number;
}

export const errorHandler = (
  err: CustomError,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Error interno del servidor'
    : err.message || 'Error interno del servidor';

  logger.error({ statusCode, message, stack: err.stack });

  res.status(statusCode).json({
    error: message,
    code: statusCode,
    timestamp: new Date().toISOString(),
  });
};

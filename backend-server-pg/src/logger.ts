import pino from 'pino';
import { config } from './config';

/**
 * Logs a stdout. En producción systemd/journald se encarga de la rotación;
 * escribir ficheros desde el proceso obliga a gestionar permisos, tamaño y
 * limpieza, y el servicio ya corre con ProtectSystem=strict.
 */
export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }),
});

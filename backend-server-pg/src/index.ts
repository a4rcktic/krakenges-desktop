import { sql } from 'drizzle-orm';
import { config } from './config';
import { BRAND_NAME } from './config/brand';
import { logger } from './logger';
import { createPostgresDatabase } from './db/client';
import { createApp } from './app';

async function main() {
  const handle = createPostgresDatabase(config.databaseUrl);

  // Falla al arrancar si la base de datos no responde. Es preferible un
  // servicio que no levanta a uno que acepta peticiones y devuelve 500.
  await handle.db.execute(sql`select 1`);
  logger.info('Base de datos conectada');

  const app = createApp({ db: handle.db });
  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, `${BRAND_NAME} backend iniciado`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Recibida señal de apagado');

    const forceExit = setTimeout(() => {
      logger.error('Apagado forzado tras 15s');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await handle.close();
      logger.info('Servidor y base de datos cerrados correctamente');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error durante el apagado');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught Exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled Rejection');
  });
}

main().catch((err) => {
  logger.error({ err }, 'No se pudo iniciar el backend');
  process.exit(1);
});

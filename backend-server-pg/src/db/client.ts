import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { config } from '../config';

/**
 * Tipo canónico de la base de datos. En producción se usa node-postgres.
 * En tests se usa PGlite (PostgreSQL compilado a WASM), que expone la misma
 * API de Drizzle; el cast es solo de tipos, no de comportamiento.
 */
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createPostgresDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: false,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
}

/** Base de datos en memoria para tests. No usar en producción. */
export async function createPgliteDatabase(migrationSql?: string): Promise<DatabaseHandle> {
  // Import dinámico: PGlite es una devDependency y no debe cargarse en
  // producción (donde se instala con --omit=dev).
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');

  const client = new PGlite();
  await client.waitReady;
  if (migrationSql) await client.exec(migrationSql);
  const db = drizzlePglite(client, { schema }) as unknown as Database;

  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}

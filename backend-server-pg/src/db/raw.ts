import type { SQL } from 'drizzle-orm';
import type { Database } from './client';

/**
 * Ejecuta SQL crudo y devuelve las filas. node-postgres y PGlite devuelven
 * formas ligeramente distintas; ambos exponen `.rows`.
 */
export async function rawRows<T = Record<string, unknown>>(
  db: Database,
  query: SQL,
): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
  if (Array.isArray(result)) return result;
  return result.rows ?? [];
}

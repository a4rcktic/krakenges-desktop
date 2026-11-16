/**
 * Elimina claves opcionales cuyo valor es null/undefined.
 *
 * Mongo/Mongoose omitía del JSON los campos opcionales no definidos. Al pasar
 * a PostgreSQL esos campos existen como NULL, así que los serializadores los
 * quitan para conservar el contrato exacto que ya consume el cliente.
 */
export function omitNullish<T extends object>(value: T, keys: readonly string[]): T {
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] === null || record[key] === undefined) {
      delete record[key];
    }
  }
  return value;
}

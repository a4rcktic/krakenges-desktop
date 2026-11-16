/**
 * Acceso a la base de datos de los tests.
 *
 * ESTE FICHERO NO LEVANTA MONGODB
 *
 * En CI, Mongo lo aporta el servicio nativo `mongodb:` del workflow, y su URI
 * llega por MONGO_TEST_URI. En local no hay Mongo y los tests que lo necesitan
 * se omiten. Aqui solo se conecta a la URI si existe.
 *
 * El reparto es a proposito. Levantar Mongo por fichero era lo que hacia que:
 *
 *   - se descargase el binario (~100 MB) una vez por cada fichero de test, y
 *   - en maquinas sin AVX ni libcrypto se colgara. Por eso
 *     e2e.license-flow.test.ts estaba excluido del CI, con 12 minutos de
 *     trabajo sin avanzar.
 *
 * QUE QUEDA DE LOS TESTS QUE DABAN VERDE FALSO
 *
 * models.test.ts usaba "if (skipIfNoDb()) return": si no habia base de datos,
 * salia del bloque antes de declarar los tests, y Jest contaba eso como
 * APROBADO. Cinco tests sin ejecutar reportados como correctos.
 *
 * Ahora los tests se declaran siempre. La disponibilidad se lee de
 * MONGO_TEST_AVAILABLE, que fija el workflow antes de que se cargue este
 * fichero, asi que se puede usar it.skip de verdad y que el informe muestre
 * OMITIDOS. Un omitido se ve; un aprobado sin ejecutar, no.
 */

import mongoose from 'mongoose';

/**
 * Si esta suite puede tocar la base de datos. Se decide al DECLARAR los tests,
 * no al ejecutarlos, asi que se puede usar describe.skip / it.skip.
 */
export function hayBaseDeDatos(): boolean {
  return process.env.MONGO_TEST_AVAILABLE === '1' && Boolean(process.env.MONGO_TEST_URI);
}

/** Conecta mongoose a la base de la suite. */
export async function connectTestDb(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) throw new Error('MONGO_TEST_URI vacia: no hay MongoDB configurado para los tests');
  await mongoose.connect(uri);
}

/** Vacia las colecciones entre tests, sin soltar la conexion. */
export async function cleanTestDb(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const cols = mongoose.connection.collections;
  for (const key of Object.keys(cols)) {
    await cols[key].deleteMany({});
  }
}

/** Cierra la conexion de mongoose. El servidor lo apaga globalSetup. */
export async function disconnectTestDb(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  await mongoose.connection.close();
}

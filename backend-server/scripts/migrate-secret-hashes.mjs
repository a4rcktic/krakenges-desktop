#!/usr/bin/env node
/**
 * Migración idempotente de API keys y refresh tokens a SHA-256.
 *
 * El backend migra en el primer uso, así que una fila antigua puede quedarse en
 * claro durante meses si nadie la usa. Este script recorre las dos colecciones
 * y deja todos los valores con el formato `sha256:<hash>`.
 *
 * Uso:
 *   MONGODB_URI=... node scripts/migrate-secret-hashes.mjs --dry-run
 *   MONGODB_URI=... node scripts/migrate-secret-hashes.mjs
 *
 * No imprime claves ni tokens. Ejecutar con una copia de seguridad reciente.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const dryRun = process.argv.includes('--dry-run');
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error('Falta MONGODB_URI.');
  process.exit(1);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function migrate(collectionName, valueField, hashField) {
  const collection = mongoose.connection.collection(collectionName);
  let scanned = 0;
  let migrated = 0;
  let alreadyHashed = 0;
  let repairedHashField = 0;

  const cursor = collection.find({ [valueField]: { $type: 'string' } });

  for await (const doc of cursor) {
    scanned += 1;
    const value = doc[valueField];
    if (!value) continue;

    if (value.startsWith('sha256:')) {
      alreadyHashed += 1;
      const digest = value.slice('sha256:'.length);
      if (!doc[hashField]) {
        repairedHashField += 1;
        if (!dryRun) {
          await collection.updateOne({ _id: doc._id }, { $set: { [hashField]: digest } });
        }
      }
      continue;
    }

    const digest = sha256(value);
    migrated += 1;
    if (!dryRun) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { [valueField]: `sha256:${digest}`, [hashField]: digest } },
      );
    }
  }

  console.log(
    `${collectionName}: ${scanned} leídas, ${migrated} migradas, ` +
      `${alreadyHashed} ya hasheadas, ${repairedHashField} con hash reparado` +
      (dryRun ? ' (dry-run, sin escribir)' : ''),
  );
}

try {
  await mongoose.connect(uri);
  await migrate('apikeys', 'key', 'keyHash');
  await migrate('refreshtokens', 'token', 'tokenHash');
  console.log('Migración completada. Reinicia el backend si estaba en marcha.');
} catch (error) {
  console.error('Migración fallida:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => undefined);
}

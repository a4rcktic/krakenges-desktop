import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../src/config';
import { createPostgresDatabase, type Database } from '../src/db/client';
import {
  activityLogs,
  apiKeys,
  browserStates,
  licenseKeys,
  profiles,
  refreshTokens,
  sessions,
  users,
} from '../src/db/schema';
import { normalizePlan } from '../src/config/plans';
import {
  hashApiKey,
  hashRefreshToken,
  storedApiKeyValue,
  storedRefreshTokenValue,
} from '../src/services/tokenHash';

/**
 * Importa una exportación JSON de MongoDB a PostgreSQL.
 *
 * No se conecta a Mongo: lee ficheros producidos por `mongoexport --jsonArray`
 * (o JSON Lines). Esto evita meter el driver de Mongo en el backend nuevo y
 * permite revisar/editar el volcado antes de importarlo.
 *
 * Uso:
 *   mongoexport --db strength --collection users --jsonArray --out ./mongo-export/users.json
 *   ... (una por colección)
 *   npm run migrate:mongo -- --dir ./mongo-export
 *
 * Los IDs se conservan tal cual (ObjectId de 24 hex como TEXT). Por eso los
 * tickets de licencia, las huellas y los estados de navegador siguen siendo
 * válidos después de la migración.
 */

type Json = any;

export interface MongoExportData {
  users: Json[];
  licenseKeys: Json[];
  profiles: Json[];
  browserStates: Json[];
  sessions: Json[];
  refreshTokens: Json[];
  apiKeys: Json[];
  activityLogs: Json[];
}

export interface ImportReport {
  read: Record<string, number>;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
}

const COLLECTIONS = {
  users: 'users',
  licenseKeys: 'licensekeys',
  profiles: 'profiles',
  browserStates: 'browserstates',
  sessions: 'sessions',
  refreshTokens: 'refreshtokens',
  apiKeys: 'apikeys',
  activityLogs: 'activitylogs',
} as const;

function readJsonFile(dir: string, name: string): Json[] {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${file} no contiene un array JSON`);
    return parsed;
  }

  // JSON Lines (mongoexport sin --jsonArray).
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err: any) {
        throw new Error(`${file}: línea ${index + 1} no es JSON válido: ${err?.message}`);
      }
    });
}

export function loadMongoExport(dir: string): MongoExportData {
  return {
    users: readJsonFile(dir, COLLECTIONS.users),
    licenseKeys: readJsonFile(dir, COLLECTIONS.licenseKeys),
    profiles: readJsonFile(dir, COLLECTIONS.profiles),
    browserStates: readJsonFile(dir, COLLECTIONS.browserStates),
    sessions: readJsonFile(dir, COLLECTIONS.sessions),
    refreshTokens: readJsonFile(dir, COLLECTIONS.refreshTokens),
    apiKeys: readJsonFile(dir, COLLECTIONS.apiKeys),
    activityLogs: readJsonFile(dir, COLLECTIONS.activityLogs),
  };
}

function toId(value: Json): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.$oid) return String(value.$oid);
  if (typeof value === 'object' && value.$numberLong) return String(value.$numberLong);
  return String(value);
}

function toDate(value: Json): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object') {
    if (value.$date !== undefined) return toDate(value.$date);
    if (value.$numberLong !== undefined) return toDate(Number(value.$numberLong));
  }
  return null;
}

function toNumber(value: Json, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === 'object') {
    if (value.$numberInt !== undefined) return toNumber(Number(value.$numberInt), fallback);
    if (value.$numberDouble !== undefined) return toNumber(Number(value.$numberDouble), fallback);
    if (value.$numberLong !== undefined) return toNumber(Number(value.$numberLong), fallback);
  }
  return fallback;
}

function toText(value: Json, fallback: string | null = null): string | null {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toBool(value: Json, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeUserRole(role: Json, isAdmin: Json): 'owner' | 'admin' | 'seller' | 'user' {
  const value = toText(role, '') || '';
  if (value === 'owner' || value === 'admin' || value === 'seller' || value === 'user') {
    return value;
  }
  return toBool(isAdmin) ? 'admin' : 'user';
}

function normalizeLicenseRole(role: Json): 'user' | 'seller' | 'admin' {
  const value = toText(role, '') || '';
  if (value === 'admin' || value === 'seller' || value === 'user') return value;
  if (value === 'reseller') return 'seller';
  return 'user';
}

function normalizeStatus(value: Json): 'active' | 'redeemed' | 'revoked' | 'expired' {
  const status = toText(value, '') || '';
  if (status === 'active' || status === 'redeemed' || status === 'revoked' || status === 'expired') {
    return status;
  }
  return 'active';
}

function normalizeOs(value: Json): string | null {
  const os = toText(value, '') || '';
  return ['windows', 'macos', 'linux', 'android', 'ios'].includes(os) ? os : null;
}

function normalizeDevice(device: Json) {
  const firstSeen = toDate(device?.firstSeen) ?? new Date(0);
  const lastSeen = toDate(device?.lastSeen) ?? firstSeen;
  return {
    hwid: toText(device?.hwid, '') || '',
    platform: toText(device?.platform, 'unknown') || 'unknown',
    label: toText(device?.label, '') || '',
    firstSeen: firstSeen.toISOString(),
    lastSeen: lastSeen.toISOString(),
  };
}

function normalizeUsers(raw: Json[]): {
  rows: (typeof users.$inferInsert)[];
  ids: Set<string>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const seenUsername = new Map<string, string>();
  const seenEmail = new Map<string, string>();
  const rows: (typeof users.$inferInsert)[] = [];
  const ids = new Set<string>();

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const username = toText(doc?.username, null)?.toLowerCase() || null;
    const email = toText(doc?.email, null)?.toLowerCase() || null;

    if (username) {
      const previous = seenUsername.get(username);
      if (previous && previous !== id) {
        throw new Error(
          `Hay dos usuarios con el mismo username (case-insensitive): ${username}. Resuélvelo en Mongo antes de migrar.`,
        );
      }
      seenUsername.set(username, id);
    }
    if (email) {
      const previous = seenEmail.get(email);
      if (previous && previous !== id) {
        throw new Error(
          `Hay dos usuarios con el mismo email (case-insensitive): ${email}. Resuélvelo en Mongo antes de migrar.`,
        );
      }
      seenEmail.set(email, id);
    }

    const passwordHash = toText(doc?.passwordHash, '') || '';
    if (!passwordHash) {
      warnings.push(`Usuario ${id} sin passwordHash: se omite.`);
      continue;
    }

    const createdAt = toDate(doc?.createdAt) ?? new Date();
    rows.push({
      id,
      name: toText(doc?.name, 'Usuario') || 'Usuario',
      username,
      email,
      passwordHash,
      role: normalizeUserRole(doc?.role, doc?.isAdmin),
      isAdmin: toBool(doc?.isAdmin),
      banned: toBool(doc?.banned),
      plan: normalizePlan(toText(doc?.plan, 'ghost') || 'ghost'),
      sellerCredits: Math.max(0, Math.trunc(toNumber(doc?.sellerCredits, 0))),
      devices: Array.isArray(doc?.devices) ? doc.devices.map(normalizeDevice) : [],
      deviceHwid: toText(doc?.deviceHwid, null),
      planUpgradedAt: toDate(doc?.planUpgradedAt),
      planExpiresAt: toDate(doc?.planExpiresAt),
      isLifetime: toBool(doc?.isLifetime),
      lastLoginAt: toDate(doc?.lastLoginAt),
      twoFactorEnabled: toBool(doc?.twoFactorEnabled),
      twoFactorSecret: toText(doc?.twoFactorSecret, null),
      passwordResetToken: toText(doc?.passwordResetToken, null),
      passwordResetExpires: toDate(doc?.passwordResetExpires),
      passwordChangedAt: toDate(doc?.passwordChangedAt),
      createdAt,
      updatedAt: toDate(doc?.updatedAt) ?? createdAt,
    });
    ids.add(id);
  }

  return { rows, ids, warnings };
}

function normalizeProfiles(
  raw: Json[],
  userIds: Set<string>,
  warnings: string[],
): { rows: (typeof profiles.$inferInsert)[]; ids: Set<string> } {
  const rows: (typeof profiles.$inferInsert)[] = [];
  const ids = new Set<string>();

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const userId = toId(doc?.userId);
    if (!userId || !userIds.has(userId)) {
      warnings.push(`Perfil ${id} sin usuario válido (${userId}): se omite.`);
      continue;
    }
    const createdAt = toDate(doc?.createdAt) ?? new Date();
    rows.push({
      id,
      userId,
      name: toText(doc?.name, 'Perfil') || 'Perfil',
      proxy: toText(doc?.proxy, null),
      startUrl: toText(doc?.startUrl, null),
      tags: Array.isArray(doc?.tags)
        ? doc.tags.map((t: Json) => String(t)).filter((t: string) => t.length > 0)
        : [],
      notes: toText(doc?.notes, null),
      os: normalizeOs(doc?.os),
      createdAt,
      updatedAt: toDate(doc?.updatedAt) ?? createdAt,
    });
    ids.add(id);
  }

  return { rows, ids };
}

function normalizeLicenseKeys(
  raw: Json[],
  userIds: Set<string>,
  warnings: string[],
): (typeof licenseKeys.$inferInsert)[] {
  const rows: (typeof licenseKeys.$inferInsert)[] = [];

  for (const doc of raw) {
    const key = toText(doc?.key, '') || '';
    if (!key) {
      warnings.push(`Clave sin valor (id ${toId(doc?._id)}): se omite.`);
      continue;
    }
    const status = normalizeStatus(doc?.status);
    const createdBy = toId(doc?.createdBy);
    const redeemedBy = toId(doc?.redeemedBy);

    if (createdBy && !userIds.has(createdBy)) {
      warnings.push(`Clave ${key}: createdBy ${createdBy} no existe; se deja en null.`);
    }
    if (redeemedBy && !userIds.has(redeemedBy)) {
      warnings.push(`Clave ${key}: redeemedBy ${redeemedBy} no existe; se deja en null.`);
    }

    rows.push({
      id: toId(doc?._id) ?? crypto.randomUUID(),
      key,
      plan: normalizePlan(toText(doc?.plan, 'shadow') || 'shadow'),
      durationDays: toNumber(doc?.durationDays, 30),
      role: normalizeLicenseRole(doc?.role),
      status,
      isActive: doc?.isActive === undefined ? status === 'active' : toBool(doc?.isActive),
      createdBy: createdBy && userIds.has(createdBy) ? createdBy : null,
      redeemedBy: redeemedBy && userIds.has(redeemedBy) ? redeemedBy : null,
      redeemedAt: toDate(doc?.redeemedAt),
      tag: toText(doc?.tag, null),
      expiresAt: toDate(doc?.expiresAt),
      createdAt: toDate(doc?.createdAt) ?? new Date(),
    });
  }

  return rows;
}

function normalizeBrowserStates(
  raw: Json[],
  userIds: Set<string>,
  profileIds: Set<string>,
  warnings: string[],
): (typeof browserStates.$inferInsert)[] {
  const rows: (typeof browserStates.$inferInsert)[] = [];

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const userId = toId(doc?.userId);
    const profileId = toId(doc?.profileId);
    if (!userId || !userIds.has(userId) || !profileId || !profileIds.has(profileId)) {
      warnings.push(
        `BrowserState ${id} sin usuario/perfil válido (user=${userId}, profile=${profileId}): se omite.`,
      );
      continue;
    }
    rows.push({
      id,
      profileId,
      userId,
      cookies: toText(doc?.cookies, '[]') || '[]',
      localStorage: toText(doc?.localStorage, '{}') || '{}',
      lastUsedAt: toDate(doc?.lastUsedAt) ?? new Date(),
      createdAt: toDate(doc?.createdAt) ?? new Date(),
    });
  }

  return rows;
}

function normalizeSessions(
  raw: Json[],
  userIds: Set<string>,
  profileIds: Set<string>,
  warnings: string[],
): (typeof sessions.$inferInsert)[] {
  const rows: (typeof sessions.$inferInsert)[] = [];

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const userId = toId(doc?.userId);
    if (!userId || !userIds.has(userId)) {
      warnings.push(`Sesión ${id} sin usuario válido (${userId}): se omite.`);
      continue;
    }
    const profileId = toId(doc?.profileId);
    if (profileId && !profileIds.has(profileId)) {
      warnings.push(`Sesión ${id}: perfil ${profileId} no existe; se deja en null.`);
    }
    const createdAt = toDate(doc?.createdAt) ?? new Date();
    rows.push({
      id,
      userId,
      profileId: profileId && profileIds.has(profileId) ? profileId : null,
      status: toText(doc?.status, 'active') === 'stopped' ? 'stopped' : 'active',
      startedAt: toDate(doc?.startedAt) ?? createdAt,
      stoppedAt: toDate(doc?.stoppedAt),
      duration: doc?.duration === undefined ? null : Math.trunc(toNumber(doc?.duration, 0)),
      createdAt,
      updatedAt: toDate(doc?.updatedAt) ?? createdAt,
    });
  }

  return rows;
}

function normalizeRefreshTokens(
  raw: Json[],
  userIds: Set<string>,
  warnings: string[],
): (typeof refreshTokens.$inferInsert)[] {
  const rows: (typeof refreshTokens.$inferInsert)[] = [];

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const userId = toId(doc?.userId);
    if (!userId || !userIds.has(userId)) {
      warnings.push(`RefreshToken ${id} sin usuario válido (${userId}): se omite.`);
      continue;
    }
    const expiresAt = toDate(doc?.expiresAt);
    if (!expiresAt) {
      warnings.push(`RefreshToken ${id} sin expiresAt: se omite.`);
      continue;
    }

    const rawToken = toText(doc?.token, '') || '';
    if (!rawToken) {
      warnings.push(`RefreshToken ${id} sin token: se omite.`);
      continue;
    }

    let token: string;
    let tokenHash: string | null;
    if (rawToken.startsWith('sha256:')) {
      token = rawToken;
      tokenHash = toText(doc?.tokenHash, rawToken.slice('sha256:'.length));
    } else {
      tokenHash = hashRefreshToken(rawToken);
      token = storedRefreshTokenValue(tokenHash);
    }

    rows.push({
      id,
      userId,
      token,
      tokenHash,
      expiresAt,
      createdAt: toDate(doc?.createdAt) ?? new Date(),
    });
  }

  return rows;
}

function normalizeApiKeys(
  raw: Json[],
  userIds: Set<string>,
  warnings: string[],
): (typeof apiKeys.$inferInsert)[] {
  const rows: (typeof apiKeys.$inferInsert)[] = [];

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const userId = toId(doc?.userId);
    if (!userId || !userIds.has(userId)) {
      warnings.push(`ApiKey ${id} sin usuario válido (${userId}): se omite.`);
      continue;
    }
    const rawKey = toText(doc?.key, '') || '';
    if (!rawKey) {
      warnings.push(`ApiKey ${id} sin key: se omite.`);
      continue;
    }

    let key: string;
    let keyHash: string | null;
    if (rawKey.startsWith('sha256:')) {
      key = rawKey;
      keyHash = toText(doc?.keyHash, rawKey.slice('sha256:'.length));
    } else {
      keyHash = hashApiKey(rawKey);
      key = storedApiKeyValue(keyHash);
    }

    rows.push({
      id,
      userId,
      name: toText(doc?.name, 'API key') || 'API key',
      key,
      keyHash,
      prefix: toText(doc?.prefix, key.slice(0, 12)) || key.slice(0, 12),
      lastUsedAt: toDate(doc?.lastUsedAt),
      expiresAt: toDate(doc?.expiresAt),
      isActive: doc?.isActive === undefined ? true : toBool(doc?.isActive),
      createdAt: toDate(doc?.createdAt) ?? new Date(),
    });
  }

  return rows;
}

function normalizeActivityLogs(
  raw: Json[],
  userIds: Set<string>,
  warnings: string[],
): (typeof activityLogs.$inferInsert)[] {
  const rows: (typeof activityLogs.$inferInsert)[] = [];

  for (const doc of raw) {
    const id = toId(doc?._id) ?? crypto.randomUUID();
    const userId = toId(doc?.userId);
    if (userId && !userIds.has(userId)) {
      warnings.push(`ActivityLog ${id}: usuario ${userId} no existe; se deja en null.`);
    }
    rows.push({
      id,
      userId: userId && userIds.has(userId) ? userId : null,
      action: toText(doc?.action, 'unknown') || 'unknown',
      entity: toText(doc?.entity, 'unknown') || 'unknown',
      entityId: toText(doc?.entityId, null),
      details: doc?.details ?? null,
      ip: toText(doc?.ip, null),
      createdAt: toDate(doc?.createdAt) ?? new Date(),
    });
  }

  return rows;
}

export function buildImportRows(data: MongoExportData): {
  users: (typeof users.$inferInsert)[];
  licenseKeys: (typeof licenseKeys.$inferInsert)[];
  profiles: (typeof profiles.$inferInsert)[];
  browserStates: (typeof browserStates.$inferInsert)[];
  sessions: (typeof sessions.$inferInsert)[];
  refreshTokens: (typeof refreshTokens.$inferInsert)[];
  apiKeys: (typeof apiKeys.$inferInsert)[];
  activityLogs: (typeof activityLogs.$inferInsert)[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const normalizedUsers = normalizeUsers(data.users);
  warnings.push(...normalizedUsers.warnings);

  const normalizedProfiles = normalizeProfiles(
    data.profiles,
    normalizedUsers.ids,
    warnings,
  );

  return {
    users: normalizedUsers.rows,
    licenseKeys: normalizeLicenseKeys(data.licenseKeys, normalizedUsers.ids, warnings),
    profiles: normalizedProfiles.rows,
    browserStates: normalizeBrowserStates(
      data.browserStates,
      normalizedUsers.ids,
      normalizedProfiles.ids,
      warnings,
    ),
    sessions: normalizeSessions(
      data.sessions,
      normalizedUsers.ids,
      normalizedProfiles.ids,
      warnings,
    ),
    refreshTokens: normalizeRefreshTokens(data.refreshTokens, normalizedUsers.ids, warnings),
    apiKeys: normalizeApiKeys(data.apiKeys, normalizedUsers.ids, warnings),
    activityLogs: normalizeActivityLogs(data.activityLogs, normalizedUsers.ids, warnings),
    warnings,
  };
}

async function insertBatch(
  db: Database,
  table: any,
  rows: any[],
  label: string,
  report: ImportReport,
): Promise<void> {
  let inserted = 0;
  const chunkSize = 500;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const result = await db
      .insert(table)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: table.id });
    inserted += result.length;
  }

  report.inserted[label] = inserted;
  report.skipped[label] = rows.length - inserted;
}

export async function importMongoExport(
  db: Database,
  data: MongoExportData,
): Promise<ImportReport> {
  const rows = buildImportRows(data);
  const report: ImportReport = {
    read: {
      users: data.users.length,
      licenseKeys: data.licenseKeys.length,
      profiles: data.profiles.length,
      browserStates: data.browserStates.length,
      sessions: data.sessions.length,
      refreshTokens: data.refreshTokens.length,
      apiKeys: data.apiKeys.length,
      activityLogs: data.activityLogs.length,
    },
    inserted: {},
    skipped: {},
    warnings: rows.warnings,
  };

  // Orden de dependencias. Las claves foráneas se validan en buildImportRows.
  await insertBatch(db, users, rows.users, 'users', report);
  await insertBatch(db, licenseKeys, rows.licenseKeys, 'licenseKeys', report);
  await insertBatch(db, profiles, rows.profiles, 'profiles', report);
  await insertBatch(db, browserStates, rows.browserStates, 'browserStates', report);
  await insertBatch(db, sessions, rows.sessions, 'sessions', report);
  await insertBatch(db, refreshTokens, rows.refreshTokens, 'refreshTokens', report);
  await insertBatch(db, apiKeys, rows.apiKeys, 'apiKeys', report);
  await insertBatch(db, activityLogs, rows.activityLogs, 'activityLogs', report);

  return report;
}

function printReport(report: ImportReport): void {
  console.log('Leídos:');
  for (const [name, count] of Object.entries(report.read)) console.log(`  ${name}: ${count}`);
  console.log('Insertados:');
  for (const [name, count] of Object.entries(report.inserted)) console.log(`  ${name}: ${count}`);
  console.log('Omitidos (duplicados o inválidos):');
  for (const [name, count] of Object.entries(report.skipped)) console.log(`  ${name}: ${count}`);
  if (report.warnings.length > 0) {
    console.log(`Avisos (${report.warnings.length}):`);
    for (const warning of report.warnings.slice(0, 100)) console.log(`  - ${warning}`);
    if (report.warnings.length > 100) {
      console.log(`  ... y ${report.warnings.length - 100} más.`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--dir');
  const dir = dirIndex >= 0 ? args[dirIndex + 1] : './mongo-export';
  const dryRun = args.includes('--dry-run');

  if (!dir || !fs.existsSync(dir)) {
    console.error(`No existe el directorio de exportación: ${dir}`);
    process.exit(1);
  }

  const data = loadMongoExport(dir);
  const rows = buildImportRows(data);

  if (dryRun) {
    console.log('Modo dry-run: no se escribe en PostgreSQL.');
    printReport({
      read: {
        users: data.users.length,
        licenseKeys: data.licenseKeys.length,
        profiles: data.profiles.length,
        browserStates: data.browserStates.length,
        sessions: data.sessions.length,
        refreshTokens: data.refreshTokens.length,
        apiKeys: data.apiKeys.length,
        activityLogs: data.activityLogs.length,
      },
      inserted: {
        users: rows.users.length,
        licenseKeys: rows.licenseKeys.length,
        profiles: rows.profiles.length,
        browserStates: rows.browserStates.length,
        sessions: rows.sessions.length,
        refreshTokens: rows.refreshTokens.length,
        apiKeys: rows.apiKeys.length,
        activityLogs: rows.activityLogs.length,
      },
      skipped: {},
      warnings: rows.warnings,
    });
    return;
  }

  const handle = createPostgresDatabase(config.databaseUrl);
  try {
    const report = await importMongoExport(handle.db, data);
    printReport(report);
  } finally {
    await handle.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error importando MongoDB:', err);
    process.exit(1);
  });
}

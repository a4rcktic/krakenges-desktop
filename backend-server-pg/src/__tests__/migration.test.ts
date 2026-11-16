import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { createPgliteDatabase, type Database } from '../db/client';
import { migrationSql } from './helpers';
import { importMongoExport, loadMongoExport } from '../../scripts/import-mongo-json';
import {
  activityLogs,
  apiKeys,
  browserStates,
  licenseKeys,
  profiles,
  refreshTokens,
  sessions,
  users,
} from '../db/schema';
import { hashApiKey, hashRefreshToken } from '../services/tokenHash';

const USER_ID = '64b000000000000000000001';
const OWNER_ID = '64b000000000000000000002';
const PROFILE_ID = '64b000000000000000000010';
const SESSION_ID = '64b000000000000000000020';
const KEY_ID = '64b000000000000000000030';
const TOKEN_ID = '64b000000000000000000040';
const API_KEY_ID = '64b000000000000000000050';
const LOG_ID = '64b000000000000000000060';
const RAW_REFRESH = 'refresh-token-en-claro-123';
const RAW_API_KEY = 'gwt_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

let db: Database;
let closeDb: () => Promise<void>;
let dir: string;

beforeAll(async () => {
  const handle = await createPgliteDatabase(migrationSql());
  db = handle.db;
  closeDb = handle.close;

  dir = fs.mkdtempSync('/tmp/opencode/krakenges-migrate-');

  const write = (name: string, value: unknown) => {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2));
  };

  write('users', [
    {
      _id: { $oid: USER_ID },
      name: 'Usuario Migrado',
      username: 'migrado',
      email: 'migrado@example.com',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
      role: 'user',
      isAdmin: false,
      banned: false,
      plan: 'pro',
      sellerCredits: 0,
      devices: [
        {
          hwid: 'win-123',
          platform: 'windows',
          label: 'PC',
          firstSeen: { $date: '2025-01-02T03:04:05.000Z' },
          lastSeen: { $date: '2025-02-03T04:05:06.000Z' },
        },
      ],
      planExpiresAt: { $date: '2027-01-01T00:00:00.000Z' },
      createdAt: { $date: '2025-01-01T00:00:00.000Z' },
    },
    {
      _id: { $oid: OWNER_ID },
      name: 'Owner Migrado',
      username: 'owner_migrado',
      email: 'owner_migrado@example.com',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
      role: 'owner',
      isAdmin: true,
      plan: 'phantom',
      isLifetime: true,
      createdAt: { $date: '2024-01-01T00:00:00.000Z' },
    },
  ]);

  write('profiles', [
    {
      _id: { $oid: PROFILE_ID },
      userId: { $oid: USER_ID },
      name: 'Perfil Migrado',
      startUrl: 'https://example.com',
      tags: ['migrado', 'alpha'],
      os: 'windows',
      createdAt: { $date: '2025-03-01T00:00:00.000Z' },
      updatedAt: { $date: '2025-03-02T00:00:00.000Z' },
    },
  ]);

  write('browserstates', [
    {
      _id: { $oid: '64b000000000000000000011' },
      profileId: { $oid: PROFILE_ID },
      userId: { $oid: USER_ID },
      cookies: '[{"name":"sid","value":"abc"}]',
      localStorage: '{"theme":"dark"}',
      lastUsedAt: { $date: '2025-03-03T00:00:00.000Z' },
      createdAt: { $date: '2025-03-01T00:00:00.000Z' },
    },
  ]);

  write('sessions', [
    {
      _id: { $oid: SESSION_ID },
      userId: { $oid: USER_ID },
      profileId: { $oid: PROFILE_ID },
      status: 'stopped',
      startedAt: { $date: '2025-03-04T00:00:00.000Z' },
      stoppedAt: { $date: '2025-03-04T01:00:00.000Z' },
      duration: 60,
      createdAt: { $date: '2025-03-04T00:00:00.000Z' },
    },
  ]);

  write('licensekeys', [
    {
      _id: { $oid: KEY_ID },
      key: 'MSK-PHAN-MIGR-ADA1',
      plan: 'enterprise',
      durationDays: { $numberDouble: '0.2083' },
      role: 'user',
      status: 'redeemed',
      isActive: false,
      createdBy: { $oid: OWNER_ID },
      redeemedBy: { $oid: USER_ID },
      redeemedAt: { $date: '2025-03-05T00:00:00.000Z' },
      tag: 'migrada',
      createdAt: { $date: '2025-03-05T00:00:00.000Z' },
    },
  ]);

  write('refreshtokens', [
    {
      _id: { $oid: TOKEN_ID },
      userId: { $oid: USER_ID },
      token: RAW_REFRESH,
      expiresAt: { $date: '2030-01-01T00:00:00.000Z' },
      createdAt: { $date: '2025-03-06T00:00:00.000Z' },
    },
  ]);

  write('apikeys', [
    {
      _id: { $oid: API_KEY_ID },
      userId: { $oid: USER_ID },
      name: 'Migrada',
      key: RAW_API_KEY,
      prefix: RAW_API_KEY.slice(0, 12),
      isActive: true,
      createdAt: { $date: '2025-03-07T00:00:00.000Z' },
    },
  ]);

  write('activitylogs', [
    {
      _id: { $oid: LOG_ID },
      userId: { $oid: USER_ID },
      action: 'login',
      entity: 'user',
      entityId: USER_ID,
      details: { platform: 'windows' },
      ip: '127.0.0.1',
      createdAt: { $date: '2025-03-08T00:00:00.000Z' },
    },
  ]);
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.sequential('Migración MongoDB -> PostgreSQL', () => {
  it('importa todas las colecciones conservando IDs y relaciones', async () => {
    const data = loadMongoExport(dir);
    const report = await importMongoExport(db, data);

    expect(report.inserted).toMatchObject({
      users: 2,
      licenseKeys: 1,
      profiles: 1,
      browserStates: 1,
      sessions: 1,
      refreshTokens: 1,
      apiKeys: 1,
      activityLogs: 1,
    });

    const [user] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(user).toBeDefined();
    expect(user.plan).toBe('shadow');
    expect(user.devices[0].firstSeen).toBe('2025-01-02T03:04:05.000Z');
    expect(user.devices[0].lastSeen).toBe('2025-02-03T04:05:06.000Z');

    const [owner] = await db.select().from(users).where(eq(users.id, OWNER_ID));
    expect(owner.plan).toBe('phantom');
    expect(owner.isLifetime).toBe(true);

    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, PROFILE_ID));
    expect(profile.userId).toBe(USER_ID);
    expect(profile.os).toBe('windows');
    expect(profile.tags).toEqual(['migrado', 'alpha']);

    const [state] = await db
      .select()
      .from(browserStates)
      .where(eq(browserStates.profileId, PROFILE_ID));
    expect(state.userId).toBe(USER_ID);
    expect(state.cookies).toContain('sid');

    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION_ID));
    expect(session.profileId).toBe(PROFILE_ID);
    expect(session.duration).toBe(60);

    const [license] = await db
      .select()
      .from(licenseKeys)
      .where(eq(licenseKeys.id, KEY_ID));
    expect(license.plan).toBe('phantom');
    expect(license.durationDays).toBeCloseTo(0.2083, 4);
    expect(license.createdBy).toBe(OWNER_ID);
    expect(license.redeemedBy).toBe(USER_ID);

    const [token] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, TOKEN_ID));
    expect(token.token).toBe(`sha256:${hashRefreshToken(RAW_REFRESH)}`);
    expect(token.tokenHash).toBe(hashRefreshToken(RAW_REFRESH));

    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, API_KEY_ID));
    expect(apiKey.key).toBe(`sha256:${hashApiKey(RAW_API_KEY)}`);
    expect(apiKey.keyHash).toBe(hashApiKey(RAW_API_KEY));

    const [log] = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.id, LOG_ID));
    expect(log.userId).toBe(USER_ID);
  });

  it('es idempotente: reimportar no duplica ni falla', async () => {
    const data = loadMongoExport(dir);
    const report = await importMongoExport(db, data);
    expect(report.inserted.users).toBe(0);
    expect(report.inserted.profiles).toBe(0);
    expect(report.skipped.users).toBe(2);
  });
});

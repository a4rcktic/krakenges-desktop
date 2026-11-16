import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { createPgliteDatabase } from '../db/client';
import type { Database } from '../db/client';
import { createApp } from '../app';
import { licenseKeys, users } from '../db/schema';

export function migrationSql(): string {
  const dir = path.resolve(process.cwd(), 'drizzle');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (files.length === 0) throw new Error('No hay migraciones en drizzle/');
  // Todas las migraciones en orden. PGlite ejecuta múltiples sentencias.
  return files
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

export interface TestContext {
  app: Express;
  db: Database;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const handle = await createPgliteDatabase(migrationSql());
  return {
    app: createApp({ db: handle.db }),
    db: handle.db,
    close: handle.close,
  };
}

export async function seedOwner(db: Database, password = 'OwnerPass123!') {
  const [owner] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      name: 'Owner',
      username: 'owner',
      email: 'owner@example.com',
      passwordHash: await bcrypt.hash(password, 4),
      role: 'owner',
      isAdmin: true,
      plan: 'phantom',
      isLifetime: true,
      devices: [],
    })
    .returning();
  return { owner, password };
}

export async function seedUser(
  db: Database,
  overrides: Partial<typeof users.$inferInsert> & { password?: string } = {},
) {
  const { password = 'UserPass123!', ...rest } = overrides;
  const suffix = crypto.randomBytes(3).toString('hex');
  const [user] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      name: `User ${suffix}`,
      username: `user_${suffix}`,
      email: `user_${suffix}@example.com`,
      passwordHash: await bcrypt.hash(password, 4),
      role: 'user',
      plan: 'ghost',
      devices: [],
      ...rest,
    })
    .returning();
  return { user, password };
}

export async function seedLicenseKey(
  db: Database,
  overrides: Partial<typeof licenseKeys.$inferInsert> = {},
) {
  const [key] = await db
    .insert(licenseKeys)
    .values({
      key: `MSK-TEST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      plan: 'shadow',
      durationDays: 30,
      role: 'user',
      status: 'active',
      isActive: true,
      ...overrides,
    })
    .returning();
  return key;
}

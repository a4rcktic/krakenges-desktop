import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Esquema PostgreSQL de Kraken Ges.
 *
 * Decisiones:
 *  - IDs TEXT, no UUID. Se conservan los ObjectId de MongoDB como strings para
 *    que la migración no cambie IDs de usuarios/perfiles: los tickets de
 *    licencia, los estados de navegador y la semilla de la huella siguen siendo
 *    los mismos. Las filas nuevas reciben un UUID textual por defecto.
 *  - Enums como TEXT + CHECK en vez de tipos ENUM: añadir un valor no exige
 *    una migración destructiva y los valores legacy se normalizan en la capa
 *    de aplicación.
 *  - Los planes se guardan ya normalizados (ghost/shadow/specter/phantom).
 *  - Los tokens de refresco y las API keys se guardan hasheados. El campo
 *    `token`/`key` conserva el alias único `sha256:<hash>` por compatibilidad
 *    con la migración desde MongoDB.
 */

export interface Device {
  hwid: string;
  platform: string;
  label?: string;
  firstSeen: string;
  lastSeen: string;
}

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    name: text('name').notNull(),
    username: text('username'),
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user'),
    isAdmin: boolean('is_admin').notNull().default(false),
    banned: boolean('banned').notNull().default(false),
    plan: text('plan').notNull().default('ghost'),
    // Entitlements personalizados. NULL = usar los límites del plan base.
    // -1 significa ilimitado; 0 sigue siendo un límite válido (p. ej. API keys).
    customPlanName: text('custom_plan_name'),
    maxProfiles: integer('max_profiles'),
    maxSessions: integer('max_sessions'),
    maxApiKeys: integer('max_api_keys'),
    sellerCredits: integer('seller_credits').notNull().default(0),
    devices: jsonb('devices').$type<Device[]>().notNull().default(sql`'[]'::jsonb`),
    deviceHwid: text('device_hwid'),
    planUpgradedAt: timestamp('plan_upgraded_at', { withTimezone: true }),
    planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
    isLifetime: boolean('is_lifetime').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorSecret: text('two_factor_secret'),
    passwordResetToken: text('password_reset_token'),
    passwordResetExpires: timestamp('password_reset_expires', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_username_lower_unique')
      .on(sql`lower(${table.username})`)
      .where(sql`${table.username} is not null`),
    uniqueIndex('users_email_lower_unique')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`),
    index('users_role_idx').on(table.role),
    index('users_plan_idx').on(table.plan),
    check('users_role_check', sql`${table.role} in ('owner', 'admin', 'seller', 'user')`),
    check(
      'users_plan_check',
      sql`${table.plan} in ('ghost', 'shadow', 'specter', 'phantom')`,
    ),
    check(
      'users_custom_limits_check',
      sql`(${table.maxProfiles} is null or ${table.maxProfiles} >= -1)
          and (${table.maxSessions} is null or ${table.maxSessions} >= -1)
          and (${table.maxApiKeys} is null or ${table.maxApiKeys} >= -1)`,
    ),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    proxy: text('proxy'),
    startUrl: text('start_url'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    notes: text('notes'),
    os: text('os'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('profiles_user_created_idx').on(table.userId, table.createdAt),
    index('profiles_tags_gin_idx').using('gin', table.tags),
    check(
      'profiles_os_check',
      sql`${table.os} is null or ${table.os} in ('windows', 'macos', 'linux', 'android', 'ios')`,
    ),
  ],
);

export const licenseKeys = pgTable(
  'license_keys',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    key: text('key').notNull().unique(),
    plan: text('plan').notNull().default('shadow'),
    // Entitlements personalizados. NULL = usar los límites del plan base.
    customPlanName: text('custom_plan_name'),
    maxProfiles: integer('max_profiles'),
    maxSessions: integer('max_sessions'),
    maxApiKeys: integer('max_api_keys'),
    // double precision, no integer: hay claves de 5 horas (0.2083 días).
    durationDays: doublePrecision('duration_days').notNull().default(30),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    redeemedBy: text('redeemed_by').references(() => users.id, { onDelete: 'set null' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    tag: text('tag'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('license_keys_status_idx').on(table.status),
    index('license_keys_created_by_idx').on(table.createdBy),
    index('license_keys_redeemed_by_idx').on(table.redeemedBy),
    index('license_keys_created_at_idx').on(table.createdAt),
    check(
      'license_keys_plan_check',
      sql`${table.plan} in ('ghost', 'shadow', 'specter', 'phantom')`,
    ),
    check('license_keys_role_check', sql`${table.role} in ('user', 'seller', 'admin')`),
    check(
      'license_keys_status_check',
      sql`${table.status} in ('active', 'redeemed', 'revoked', 'expired')`,
    ),
    check(
      'license_keys_custom_limits_check',
      sql`(${table.maxProfiles} is null or ${table.maxProfiles} >= -1)
          and (${table.maxSessions} is null or ${table.maxSessions} >= -1)
          and (${table.maxApiKeys} is null or ${table.maxApiKeys} >= -1)`,
    ),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    tokenHash: text('token_hash').unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_expires_idx').on(table.expiresAt),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Se conserva la sesión si se borra el perfil: el historial no desaparece.
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    duration: integer('duration'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_status_idx').on(table.userId, table.status),
    index('sessions_profile_idx').on(table.profileId),
    index('sessions_created_at_idx').on(table.createdAt),
    check('sessions_status_check', sql`${table.status} in ('active', 'stopped')`),
  ],
);

export const browserStates = pgTable(
  'browser_states',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    profileId: text('profile_id')
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cookies: text('cookies').notNull().default('[]'),
    localStorage: text('local_storage').notNull().default('{}'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('browser_states_user_idx').on(table.userId)],
);

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    // Se conserva la auditoría aunque se borre el usuario.
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    details: jsonb('details').$type<Record<string, unknown> | null>(),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('activity_logs_user_created_idx').on(table.userId, table.createdAt),
    index('activity_logs_created_at_idx').on(table.createdAt),
    index('activity_logs_action_idx').on(table.action),
    index('activity_logs_entity_idx').on(table.entity),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    key: text('key').notNull().unique(),
    keyHash: text('key_hash').unique(),
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_keys_user_idx').on(table.userId),
    index('api_keys_active_idx').on(table.userId, table.isActive),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ProfileRow = typeof profiles.$inferSelect;
export type LicenseKeyRow = typeof licenseKeys.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type BrowserStateRow = typeof browserStates.$inferSelect;
export type ActivityLogRow = typeof activityLogs.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;

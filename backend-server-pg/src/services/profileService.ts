import { and, eq, sql } from 'drizzle-orm';
import { browserStates, profiles, users } from '../db/schema';
import type { Database } from '../db/client';
import type { ProfileRow, UserRow } from '../db/schema';
import { getEffectiveLimits, getEffectivePlanName } from '../config/plans';
import { encryptProxy, decryptProxy, isEncrypted } from './proxyCipher';
import { logActivity } from './activityLog';
import { omitNullish } from '../utils/omitNullish';

export type QuotaResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      limit?: number;
      current?: number;
    };

export type CreateResult =
  | { ok: true; profile: ProfileRow | ProfileRow[] }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      limit?: number;
      current?: number;
    };

export interface ProfileInput {
  name: string;
  startUrl?: string;
  tags?: string[];
  notes?: string;
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
}

export function isValidId(id: string): boolean {
  // Acepta UUID (filas nuevas) y ObjectId de 24 hex (datos migrados de Mongo).
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    /^[0-9a-f]{24}$/i.test(id)
  );
}

/**
 * ¿Puede `userId` crear `requesting` perfiles más según su plan?
 * La comparación es siempre `count + requesting`, tanto para uno como para
 * varios, para que no existan dos versiones de la regla.
 */
async function quotaForUser(
  db: any,
  user: UserRow,
  userId: string,
  requesting: number,
  opts: { verb?: 'create' | 'import' } = {},
): Promise<QuotaResult> {
  const limits = getEffectiveLimits(user);
  if (limits.maxProfiles === -1) return { ok: true };

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  const count = row?.count ?? 0;

  if (count + requesting > limits.maxProfiles) {
    const planName = getEffectivePlanName(user);
    let error: string;
    if (opts.verb === 'import') {
      error = `No puedes importar ${requesting} perfiles. Tienes ${count}/${limits.maxProfiles}.`;
    } else if (requesting === 1) {
      error = `Límite de perfiles alcanzado (${limits.maxProfiles}) para tu plan ${planName}. Actualiza tu plan para crear más.`;
    } else {
      error = `No puedes crear ${requesting} perfiles. Tienes ${count}/${limits.maxProfiles}. Actualiza tu plan.`;
    }

    return {
      ok: false,
      status: 403,
      error,
      code: 'PLAN_LIMIT_REACHED',
      limit: limits.maxProfiles,
      current: count,
    };
  }

  return { ok: true };
}

export async function checkProfileQuota(
  db: Database,
  userId: string,
  requesting: number,
  opts: { verb?: 'create' | 'import' } = {},
): Promise<QuotaResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, status: 404, error: 'User not found' };
  return quotaForUser(db, user, userId, requesting, opts);
}

export async function createProfile(
  db: Database,
  userId: string,
  input: ProfileInput,
  opts: { proxy?: string; ip?: string } = {},
): Promise<CreateResult> {
  const result = await db.transaction(async (tx) => {
    // Bloquea la fila del usuario para serializar comprobación de cuota e
    // inserción. Sin esto, N peticiones concurrentes pasan todas el COUNT.
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    if (!user) return { ok: false as const, status: 404, error: 'User not found' };

    const quota = await quotaForUser(tx, user, userId, 1);
    if (!quota.ok) return quota;

    const [profile] = await tx
      .insert(profiles)
      .values({
        userId,
        name: input.name.trim(),
        proxy: opts.proxy?.trim() ? encryptProxy(opts.proxy.trim()) : null,
        startUrl: input.startUrl || null,
        tags: input.tags ?? [],
        notes: input.notes || null,
        os: input.os ?? null,
      })
      .returning();

    await tx.insert(browserStates).values({
      profileId: profile.id,
      userId,
      cookies: '[]',
      localStorage: '{}',
    });

    return { ok: true as const, profile };
  });

  if (!result.ok) return result;
  await logActivity(
    db,
    userId,
    'create',
    'profile',
    result.profile.id,
    { name: result.profile.name },
    opts.ip,
  );
  return result;
}

export async function createProfilesBulk(
  db: Database,
  userId: string,
  inputs: ProfileInput[],
  opts: { ip?: string } = {},
): Promise<CreateResult> {
  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    if (!user) return { ok: false as const, status: 404, error: 'User not found' };

    const quota = await quotaForUser(tx, user, userId, inputs.length);
    if (!quota.ok) return quota;

    const rows = await tx
      .insert(profiles)
      .values(
        inputs.map((input) => ({
          userId,
          name: input.name.trim(),
          // Política del proyecto: el servidor no guarda proxies.
          proxy: null,
          startUrl: input.startUrl || null,
          tags: input.tags ?? [],
          notes: input.notes || null,
          os: input.os ?? null,
        })),
      )
      .returning();

    await tx.insert(browserStates).values(
      rows.map((profile) => ({
        profileId: profile.id,
        userId,
        cookies: '[]',
        localStorage: '{}',
      })),
    );

    return { ok: true as const, profile: rows };
  });

  if (!result.ok) return result;
  const created = result.profile as ProfileRow[];
  await logActivity(
    db,
    userId,
    'create',
    'profile',
    'bulk',
    { count: created.length, names: created.map((p) => p.name) },
    opts.ip,
  );

  return result;
}

const PROFILE_OPTIONAL_FIELDS = ['proxy', 'startUrl', 'notes', 'os'] as const;

/**
 * Serializa un perfil descifrando el proxy legacy.
 *
 * Los campos opcionales sin valor se omiten para igualar el JSON de Mongoose.
 */
export function serializeProfile(profile: ProfileRow) {
  const obj = { ...profile };
  if (isEncrypted(obj.proxy)) {
    obj.proxy = decryptProxy(obj.proxy) ?? null;
  }
  return omitNullish(obj, PROFILE_OPTIONAL_FIELDS);
}

/**
 * Perfil embebido en una sesión. El backend Mongo lo devolvía sin descifrar el
 * proxy; se conserva ese comportamiento y solo se omiten los campos vacíos.
 */
export function serializeProfileForSession(profile: ProfileRow) {
  return omitNullish({ ...profile }, PROFILE_OPTIONAL_FIELDS);
}

export async function loadOwnedProfile(
  db: Database,
  profileId: string,
  userId: string,
): Promise<
  | { ok: true; profile: ProfileRow }
  | { ok: false; status: 404 | 403; error: string }
> {
  if (!isValidId(profileId)) {
    return { ok: false, status: 404, error: 'Profile not found' };
  }

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .limit(1);

  if (!profile) return { ok: false, status: 404, error: 'Profile not found' };
  if (profile.userId !== userId) {
    return { ok: false, status: 403, error: 'Profile belongs to another user' };
  }
  return { ok: true, profile };
}

export async function cloneProfile(
  db: Database,
  source: ProfileRow,
  userId: string,
  newName: string | undefined,
  opts: { ip?: string } = {},
): Promise<CreateResult> {
  const name = newName || `${source.name} (copia)`;

  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    if (!user) return { ok: false as const, status: 404, error: 'User not found' };

    const quota = await quotaForUser(tx, user, userId, 1);
    if (!quota.ok) return quota;

    const [created] = await tx
      .insert(profiles)
      .values({
        userId,
        name,
        proxy: source.proxy
          ? isEncrypted(source.proxy)
            ? source.proxy
            : encryptProxy(source.proxy) ?? null
          : null,
        startUrl: source.startUrl,
        tags: [...(source.tags ?? [])],
        notes: source.notes,
        os: source.os,
      })
      .returning();

    const [originalState] = await tx
      .select()
      .from(browserStates)
      .where(eq(browserStates.profileId, source.id))
      .limit(1);

    await tx.insert(browserStates).values({
      profileId: created.id,
      userId,
      cookies: originalState?.cookies ?? '[]',
      localStorage: originalState?.localStorage ?? '{}',
    });

    return { ok: true as const, profile: created };
  });

  if (!result.ok) return result;
  await logActivity(
    db,
    userId,
    'clone',
    'profile',
    result.profile.id,
    { original: source.name, clone: result.profile.name },
    opts.ip,
  );

  return result;
}

export async function findOwnedProfile(db: Database, profileId: string, userId: string) {
  if (!isValidId(profileId)) return undefined;
  const [profile] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.userId, userId)))
    .limit(1);
  return profile;
}

import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { profiles, sessions, users } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import { logActivity } from '../services/activityLog';
import { asyncHandler } from '../utils/asyncHandler';
import { getEffectiveLimits, getEffectivePlanName } from '../config/plans';
import {
  isValidId,
  serializeProfileForSession,
} from '../services/profileService';
import { omitNullish } from '../utils/omitNullish';

const router = Router();

const startSessionSchema = z.object({ profileId: z.string().min(1) });

type ProfileRow = typeof profiles.$inferSelect;

/**
 * El backend Mongo devolvía dos formas distintas:
 * - GET /api/sessions: `profileId` es el perfil completo (populate).
 * - POST /start, /stop y /reactivate: `profileId` es el ObjectId como string.
 *
 * El cliente usa `profileId.proxy` y `profileId.startUrl` al reanudar una
 * sesión, así que la lista debe conservar el perfil completo. Las mutaciones
 * mantienen la forma histórica para no cambiar el contrato.
 */
function serializeSession(
  session: typeof sessions.$inferSelect,
  profile: ProfileRow | null,
  populateProfile: boolean,
) {
  return omitNullish(
    {
      id: session.id,
      userId: session.userId,
      profileId: populateProfile
        ? profile
          ? serializeProfileForSession(profile)
          : null
        : session.profileId,
      status: session.status,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      duration: session.duration,
      createdAt: session.createdAt,
    },
    ['stoppedAt', 'duration'],
  );
}

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const { status } = req.query;
    const conditions = [eq(sessions.userId, req.user!.id)];

    if (status && typeof status === 'string' && ['active', 'stopped'].includes(status)) {
      conditions.push(eq(sessions.status, status));
    }

    const rows = await db
      .select({
        session: sessions,
        profile: profiles,
      })
      .from(sessions)
      .leftJoin(profiles, eq(sessions.profileId, profiles.id))
      .where(and(...conditions))
      .orderBy(desc(sessions.createdAt))
      .limit(100);

    res.json(rows.map((row) => serializeSession(row.session, row.profile ?? null, true)));
  }),
);

const startHandler = asyncHandler(async (req, res) => {
  const parsed = startSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  if (!isValidId(parsed.data.profileId)) {
    return res.status(400).json({ error: 'profileId inválido' });
  }

  const db = dbOf(req);
  const result = await db.transaction(async (tx) => {
    // Serializa la comprobación de sesiones activas con la inserción. El
    // bloqueo de la fila del usuario es portable (PostgreSQL y PGlite).
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1)
      .for('update');
    if (!user) return { ok: false as const, status: 404, error: 'User not found' };

    const limits = getEffectiveLimits(user);
    if (limits.maxSessions !== -1) {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.userId, req.user!.id), eq(sessions.status, 'active')));
      const activeCount = row?.count ?? 0;

      if (activeCount >= limits.maxSessions) {
        return {
          ok: false as const,
          status: 403,
          error: `Límite de sesiones activas alcanzado (${limits.maxSessions}) para tu plan ${getEffectivePlanName(user)}.`,
          code: 'PLAN_LIMIT_REACHED',
          limit: limits.maxSessions,
          current: activeCount,
        };
      }
    }

    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.id, parsed.data.profileId))
      .limit(1);
    if (!profile) return { ok: false as const, status: 404, error: 'Profile not found' };
    if (profile.userId !== req.user!.id) {
      return {
        ok: false as const,
        status: 403,
        error: 'Profile belongs to another user',
      };
    }

    const [session] = await tx
      .insert(sessions)
      .values({
        userId: req.user!.id,
        profileId: profile.id,
        status: 'active',
        startedAt: new Date(),
      })
      .returning();

    return { ok: true as const, session, profile };
  });

  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      ...(result.code ? { code: result.code } : {}),
      ...(result.limit !== undefined ? { limit: result.limit } : {}),
      ...(result.current !== undefined ? { current: result.current } : {}),
    });
  }

  await logActivity(
    db,
    req.user!.id,
    'start',
    'session',
    result.session.id,
    { profileName: result.profile.name },
    req.ip,
  );

  res.status(201).json(serializeSession(result.session, null, false));
});

router.post('/start', authenticate, startHandler);
router.post('/', authenticate, startHandler);

router.post(
  '/:id/stop',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const db = dbOf(req);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, req.params.id))
      .limit(1);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Session belongs to another user' });
    }
    if (session.status === 'stopped') {
      return res.status(400).json({ error: 'Session already stopped' });
    }

    const now = new Date();
    const duration = Math.round((now.getTime() - session.startedAt.getTime()) / 60000);

    const [updated] = await db
      .update(sessions)
      .set({ status: 'stopped', stoppedAt: now, duration, updatedAt: now })
      .where(eq(sessions.id, session.id))
      .returning();

    await logActivity(
      db,
      req.user!.id,
      'stop',
      'session',
      session.id,
      { duration },
      req.ip,
    );

    res.json(serializeSession(updated, null, false));
  }),
);

router.post(
  '/:id/reactivate',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const db = dbOf(req);
    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, req.user!.id))
        .limit(1)
        .for('update');
      if (!user) return { ok: false as const, status: 404, error: 'User not found' };

      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, req.params.id))
        .limit(1)
        .for('update');

      if (!session) return { ok: false as const, status: 404, error: 'Session not found' };
      if (session.userId !== req.user!.id) {
        return {
          ok: false as const,
          status: 403,
          error: 'Session belongs to another user',
        };
      }

      // Reactivar una sesión parada la vuelve a contar como activa. Sin esta
      // comprobación se podía superar maxSessions parando y reactivando.
      if (session.status !== 'active') {
        const limits = getEffectiveLimits(user);
        if (limits.maxSessions !== -1) {
          const [row] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(sessions)
            .where(and(eq(sessions.userId, req.user!.id), eq(sessions.status, 'active')));
          const activeCount = row?.count ?? 0;
          if (activeCount >= limits.maxSessions) {
            return {
              ok: false as const,
              status: 403,
              error: `Límite de sesiones activas alcanzado (${limits.maxSessions}) para tu plan ${getEffectivePlanName(user)}.`,
              code: 'PLAN_LIMIT_REACHED',
              limit: limits.maxSessions,
              current: activeCount,
            };
          }
        }
      }

      const [updated] = await tx
        .update(sessions)
        .set({
          status: 'active',
          startedAt: new Date(),
          stoppedAt: null,
          duration: null,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, session.id))
        .returning();

      return { ok: true as const, session: updated };
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.limit !== undefined ? { limit: result.limit } : {}),
        ...(result.current !== undefined ? { current: result.current } : {}),
      });
    }

    await logActivity(
      db,
      req.user!.id,
      'reactivate',
      'session',
      result.session.id,
      undefined,
      req.ip,
    );

    res.json(serializeSession(result.session, null, false));
  }),
);

router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    const db = dbOf(req);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, req.params.id))
      .limit(1);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Session belongs to another user' });
    }

    await db.delete(sessions).where(eq(sessions.id, session.id));
    await logActivity(
      db,
      req.user!.id,
      'delete',
      'session',
      session.id,
      undefined,
      req.ip,
    );

    res.json({ message: 'Sesion eliminada.' });
  }),
);

export default router;

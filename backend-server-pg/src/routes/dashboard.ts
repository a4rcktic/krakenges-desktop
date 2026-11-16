import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { apiKeys, profiles, sessions } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const userId = req.user!.id;

    const [
      profilesCountRow,
      sessionsCountRow,
      activeSessionsCountRow,
      latestProfiles,
      latestSessionRows,
      stoppedSessions,
      apiKeysCountRow,
    ] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(profiles)
        .where(eq(profiles.userId, userId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.status, 'active'))),
      db
        .select({
          id: profiles.id,
          name: profiles.name,
          createdAt: profiles.createdAt,
          updatedAt: profiles.updatedAt,
        })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .orderBy(desc(profiles.createdAt))
        .limit(5),
      db
        .select({
          session: {
            id: sessions.id,
            status: sessions.status,
            startedAt: sessions.startedAt,
            createdAt: sessions.createdAt,
          },
          profile: { id: profiles.id, name: profiles.name, os: profiles.os },
        })
        .from(sessions)
        .leftJoin(profiles, eq(sessions.profileId, profiles.id))
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.createdAt))
        .limit(5),
      db
        .select({ duration: sessions.duration })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.status, 'stopped'))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId)),
    ]);

    const totalMinutes = stoppedSessions.reduce((sum, s) => sum + (s.duration || 0), 0);

    res.json({
      profilesCount: profilesCountRow[0]?.count ?? 0,
      sessionsCount: sessionsCountRow[0]?.count ?? 0,
      activeSessionsCount: activeSessionsCountRow[0]?.count ?? 0,
      totalMinutes,
      latestProfiles,
      latestSessions: latestSessionRows.map(({ session, profile }) => ({
        ...session,
        profileId: profile?.id ? profile : null,
      })),
      apiKeysCount: apiKeysCountRow[0]?.count ?? 0,
    });
  }),
);

export default router;

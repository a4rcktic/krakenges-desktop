import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { apiKeys, profiles, sessions, users } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import { PLAN_CONFIGS } from '../config/plans';
import {
  checkAndHandleSubscriptionExpiry,
  getSubscriptionStatus,
  redeemLicenseKey,
} from '../services/subscriptionService';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Demasiados intentos de canje de claves. Espera 15 minutos antes de reintentar.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const redeemSchema = z.object({
  key: z.string().min(1, 'La clave de licencia es requerida'),
});

router.get('/plans', (_req, res) => {
  res.json(Object.values(PLAN_CONFIGS));
});

router.get(
  '/status',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    if (!found) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = await checkAndHandleSubscriptionExpiry(db, found, req.ip);
    res.json(getSubscriptionStatus(user));
  }),
);

router.get(
  '/usage',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    if (!found) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = await checkAndHandleSubscriptionExpiry(db, found, req.ip);
    const status = getSubscriptionStatus(user);

    const [profilesCount, apiKeysCount, activeSessionsCount] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(profiles)
        .where(eq(profiles.userId, req.user!.id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, req.user!.id), eq(apiKeys.isActive, true))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.userId, req.user!.id), eq(sessions.status, 'active'))),
    ]);

    res.json({
      plan: status.normalizedPlan,
      planName: status.planName,
      isLifetime: status.isLifetime,
      daysRemaining: status.daysRemaining,
      planExpiresAt: status.planExpiresAt,
      usage: {
        profiles: { current: profilesCount[0]?.count ?? 0, max: status.limits.maxProfiles },
        sessions: {
          current: activeSessionsCount[0]?.count ?? 0,
          max: status.limits.maxSessions,
        },
        apiKeys: { current: apiKeysCount[0]?.count ?? 0, max: status.limits.maxApiKeys },
      },
    });
  }),
);

router.post(
  '/redeem',
  authenticate,
  redeemLimiter,
  asyncHandler(async (req, res) => {
    const parsed = redeemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    try {
      const result = await redeemLicenseKey(
        dbOf(req),
        req.user!.id,
        parsed.data.key,
        req.ip,
      );
      res.json({ success: true, message: result.message, status: result.status });
    } catch (err: any) {
      res.status(400).json({
        error: err?.message || 'Error al canjear la clave de licencia',
      });
    }
  }),
);

export default router;

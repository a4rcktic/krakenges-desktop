import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import User from '../models/User';
import Profile from '../models/Profile';
import ApiKey from '../models/ApiKey';
import Session from '../models/Session';
import { authenticate } from '../authMiddleware';
import { PLAN_CONFIGS } from '../config/plans';
import {
  checkAndHandleSubscriptionExpiry,
  getSubscriptionStatus,
  redeemLicenseKey,
} from '../services/subscriptionService';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Max 10 intentos de canje cada 15 min
  message: { error: 'Demasiados intentos de canje de claves. Espera 15 minutos antes de reintentar.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const redeemSchema = z.object({
  key: z.string().min(1, 'La clave de licencia es requerida'),
});

router.get('/plans', (_req, res) => {
  const plans = Object.values(PLAN_CONFIGS);
  res.json(plans);
});

router.get('/status', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  await checkAndHandleSubscriptionExpiry(user, req.ip);
  const status = getSubscriptionStatus(user);

  res.json(status);
}));

router.get('/usage', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  await checkAndHandleSubscriptionExpiry(user, req.ip);
  const status = getSubscriptionStatus(user);

  const [profilesCount, apiKeysCount, activeSessionsCount] = await Promise.all([
    Profile.countDocuments({ userId: req.user!._id }),
    ApiKey.countDocuments({ userId: req.user!._id, isActive: true }),
    Session.countDocuments({ userId: req.user!._id, status: 'active' }),
  ]);

  res.json({
    plan: status.normalizedPlan,
    planName: status.planName,
    isLifetime: status.isLifetime,
    daysRemaining: status.daysRemaining,
    planExpiresAt: status.planExpiresAt,
    usage: {
      profiles: { current: profilesCount, max: status.limits.maxProfiles },
      sessions: { current: activeSessionsCount, max: status.limits.maxSessions },
      apiKeys: { current: apiKeysCount, max: status.limits.maxApiKeys },
    },
  });
}));

router.post('/redeem', authenticate, redeemLimiter, asyncHandler(async (req, res) => {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  try {
    const result = await redeemLicenseKey(req.user!._id.toString(), parsed.data.key, req.ip);
    res.json({
      success: true,
      message: result.message,
      status: result.status,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Error al canjear la clave de licencia' });
  }
}));

export default router;

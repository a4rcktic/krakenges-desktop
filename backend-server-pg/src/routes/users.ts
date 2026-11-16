import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  activityLogs,
  apiKeys,
  licenseKeys,
  profiles,
  refreshTokens,
  sessions,
  users,
} from '../db/schema';
import type { UserRow } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate, requireAdmin, requireOwner } from '../middleware/auth';
import { logActivity } from '../services/activityLog';
import { generateTwoFactorSecret, verifyTwoFactorToken } from '../services/twoFactor';
import { isMailConfigured, sendPasswordResetEmail } from '../services/mailer';
import { normalizePlan, PLAN_CONFIGS } from '../config/plans';
import {
  checkAndHandleSubscriptionExpiry,
  getSubscriptionStatus,
} from '../services/subscriptionService';
import { safeUserJson } from '../services/licenseTicket';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../errors';
import { isValidId } from '../services/profileService';
import { omitNullish } from '../utils/omitNullish';

const router = Router();

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiadas solicitudes de recuperación. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de restablecimiento. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const banSchema = z.object({ banned: z.boolean() });
const resetPasswordSchema = z.object({ password: z.string().min(8).max(128) });
const updateProfileSchema = z.object({ name: z.string().min(2).max(100).optional() });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});
const enable2FASchema = z.object({ token: z.string().length(6) });
const disable2FASchema = z.object({ password: z.string().min(1).max(128) });
const forgotPasswordSchema = z.object({ email: z.string().email().max(254) });
const resetPasswordWithTokenSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(8).max(128),
});
const adminUpdatePlanSchema = z.object({
  plan: z.enum(['ghost', 'shadow', 'specter', 'phantom', 'free', 'pro', 'enterprise']),
  durationDays: z.number().min(-1).max(36_500).optional(),
  durationHours: z.number().min(-1).max(876_000).optional(),
  isLifetime: z.boolean().optional(),
  customPlanName: z.string().trim().min(1).max(80).nullable().optional(),
  maxProfiles: z.number().int().min(-1).max(1_000_000).nullable().optional(),
  maxSessions: z.number().int().min(-1).max(1_000_000).nullable().optional(),
  maxApiKeys: z.number().int().min(-1).max(1_000_000).nullable().optional(),
});
const updateRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'seller', 'user']),
  sellerCredits: z.number().int().min(0).optional(),
});

async function getUser(db: ReturnType<typeof dbOf>, id: string): Promise<UserRow | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

router.get(
  '/',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));

    const [profileCounts, apiKeyCounts, sessionCounts] = await Promise.all([
      db
        .select({ userId: profiles.userId, count: sql<number>`count(*)::int` })
        .from(profiles)
        .groupBy(profiles.userId),
      db
        .select({ userId: apiKeys.userId, count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(eq(apiKeys.isActive, true))
        .groupBy(apiKeys.userId),
      db
        .select({ userId: sessions.userId, count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(eq(sessions.status, 'active'))
        .groupBy(sessions.userId),
    ]);

    const profileMap = new Map(profileCounts.map((r) => [r.userId, r.count]));
    const apiKeyMap = new Map(apiKeyCounts.map((r) => [r.userId, r.count]));
    const sessionMap = new Map(sessionCounts.map((r) => [r.userId, r.count]));

    const result = [];
    for (const original of allUsers) {
      const user = await checkAndHandleSubscriptionExpiry(db, original);
      const subStatus = getSubscriptionStatus(user);
      const limits = subStatus.limits;

      result.push(
        omitNullish(
          {
            id: user.id,
            name: user.name,
            username: user.username,
            email: user.email,
            role: user.role || (user.isAdmin ? 'admin' : 'user'),
            isAdmin: user.isAdmin,
            banned: user.banned,
            sellerCredits: user.sellerCredits ?? 0,
            plan: subStatus.normalizedPlan,
            planName: subStatus.planName,
            isLifetime: subStatus.isLifetime,
            planExpiresAt: subStatus.planExpiresAt,
            daysRemaining: subStatus.daysRemaining,
            planUpgradedAt: user.planUpgradedAt,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            twoFactorEnabled: user.twoFactorEnabled,
            stats: {
              profiles: { current: profileMap.get(user.id) ?? 0, max: limits.maxProfiles },
              activeSessions: {
                current: sessionMap.get(user.id) ?? 0,
                max: limits.maxSessions,
              },
              apiKeys: { current: apiKeyMap.get(user.id) ?? 0, max: limits.maxApiKeys },
            },
          },
          ['username', 'email', 'planUpgradedAt', 'lastLoginAt'],
        ),
      );
    }

    res.json(result);
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    let user = await getUser(db, req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user = await checkAndHandleSubscriptionExpiry(db, user, req.ip);
    const subStatus = getSubscriptionStatus(user);

    res.json({
      ...safeUserJson(user),
      role: user.role || (user.isAdmin ? 'admin' : 'user'),
      sellerCredits: user.sellerCredits ?? 0,
      normalizedPlan: subStatus.normalizedPlan,
      planName: subStatus.planName,
      daysRemaining: subStatus.daysRemaining,
      limits: subStatus.limits,
    });
  }),
);

router.patch(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [updated] = await db
      .update(users)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();

    await logActivity(
      db,
      user.id,
      'update_profile',
      'user',
      user.id,
      { name: updated.name },
      req.ip,
    );

    res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      isAdmin: updated.isAdmin,
      plan: updated.plan,
      twoFactorEnabled: updated.twoFactorEnabled,
    });
  }),
);

router.post(
  '/me/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
    const now = new Date();
    await db
      .update(users)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, user.id));
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));

    await logActivity(db, user.id, 'change_password', 'user', user.id, undefined, req.ip);
    res.json({ message: 'Contraseña actualizada correctamente' });
  }),
);

router.post(
  '/me/2fa/enable',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const user = await getUser(db, req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ error: '2FA already enabled' });
    }

    const { secret, otpauthUrl } = generateTwoFactorSecret();
    await db
      .update(users)
      .set({ twoFactorSecret: secret, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    res.json({ secret, otpauthUrl });
  }),
);

router.post(
  '/me/2fa/verify',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = enable2FASchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.user!.id);
    if (!user || !user.twoFactorSecret) {
      return res.status(400).json({ error: '2FA not initialized' });
    }
    if (!verifyTwoFactorToken(user.twoFactorSecret, parsed.data.token)) {
      return res.status(400).json({ error: 'Invalid 2FA token' });
    }

    await db
      .update(users)
      .set({ twoFactorEnabled: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logActivity(db, user.id, '2fa_enable', 'user', user.id, undefined, req.ip);
    res.json({ message: '2FA enabled' });
  }),
);

router.post(
  '/me/2fa/disable',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = disable2FASchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.user!.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    await db
      .update(users)
      .set({ twoFactorEnabled: false, twoFactorSecret: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logActivity(db, user.id, '2fa_disable', 'user', user.id, undefined, req.ip);
    res.json({ message: '2FA disabled' });
  }),
);

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  asyncHandler(async (req, res) => {
    if (!isMailConfigured()) {
      return res.status(503).json({
        error:
          'El restablecimiento por correo no está configurado. Contacta con el administrador.',
      });
    }

    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);

    if (!user || !user.email) {
      return res.json({
        message: 'Si el correo existe en el sistema, se ha procesado la solicitud.',
      });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

    await db
      .update(users)
      .set({
        passwordResetToken: hashedToken,
        passwordResetExpires: resetExpires,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const delivered = await sendPasswordResetEmail(user.email, rawToken);
    if (!delivered) {
      await db
        .update(users)
        .set({ passwordResetToken: null, passwordResetExpires: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    await logActivity(
      db,
      user.id,
      'forgot_password',
      'user',
      user.id,
      { delivered },
      req.ip,
    );

    res.json({
      message: 'Si el correo existe en el sistema, se ha procesado la solicitud.',
    });
  }),
);

router.post(
  '/reset-password',
  resetPasswordLimiter,
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordWithTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const hashedToken = crypto.createHash('sha256').update(parsed.data.token).digest('hex');
    const [user] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.passwordResetToken, hashedToken),
          sql`${users.passwordResetExpires} > now()`,
        ),
      )
      .limit(1);

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const now = new Date();
    await db
      .update(users)
      .set({
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null,
        passwordChangedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, user.id));
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));

    await logActivity(db, user.id, 'reset_password', 'user', user.id, undefined, req.ip);
    res.json({ message: 'Password reset successfully' });
  }),
);

router.patch(
  '/:id/ban',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = banSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.user!.id) {
      return res.status(400).json({ error: 'No puedes banearte a ti mismo' });
    }
    if (user.role === 'owner') {
      return res
        .status(403)
        .json({ error: 'La cuenta del Owner es inmune y no puede ser baneada.' });
    }

    await db
      .update(users)
      .set({ banned: parsed.data.banned, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    if (parsed.data.banned) {
      await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
    }

    await logActivity(
      db,
      req.user!.id,
      parsed.data.banned ? 'ban' : 'unban',
      'user',
      user.id,
      { email: user.email },
      req.ip,
    );

    res.json({ id: user.id, banned: parsed.data.banned });
  }),
);

router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }
    if (id === req.user!.id) {
      return res
        .status(400)
        .json({ error: 'No puedes eliminar tu propia cuenta desde el panel.' });
    }

    const db = dbOf(req);
    const user = await getUser(db, id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.role === 'owner') {
      return res.status(403).json({ error: 'La cuenta del Owner no se puede eliminar.' });
    }

    const [profileCount, sessionCount, apiKeyCount, refreshCount] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(profiles)
        .where(eq(profiles.userId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(eq(sessions.userId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(eq(apiKeys.userId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, id)),
    ]);

    await db.delete(users).where(eq(users.id, id));

    await logActivity(
      db,
      req.user!.id,
      'admin_delete_user',
      'user',
      id,
      {
        email: user.email,
        profiles: profileCount[0]?.count ?? 0,
        sessions: sessionCount[0]?.count ?? 0,
        apiKeys: apiKeyCount[0]?.count ?? 0,
        refreshTokens: refreshCount[0]?.count ?? 0,
      },
      req.ip,
    );

    res.json({
      success: true,
      deleted: {
        profiles: profileCount[0]?.count ?? 0,
        sessions: sessionCount[0]?.count ?? 0,
        apiKeys: apiKeyCount[0]?.count ?? 0,
        refreshTokens: refreshCount[0]?.count ?? 0,
        browserStates: profileCount[0]?.count ?? 0,
      },
    });
  }),
);

router.post(
  '/:id/reset-password',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner' && req.user!.role !== 'owner') {
      return res
        .status(403)
        .json({ error: 'Solo el Owner puede resetear su propia contraseña.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const now = new Date();
    await db
      .update(users)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, user.id));
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));

    await logActivity(
      db,
      req.user!.id,
      'reset_password',
      'user',
      user.id,
      { email: user.email },
      req.ip,
    );
    res.json({ message: 'Password actualizado' });
  }),
);

router.patch(
  '/:id/plan',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = adminUpdatePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner' && req.user!.role !== 'owner') {
      return res
        .status(403)
        .json({ error: 'Solo el Owner puede cambiar el plan de su propia cuenta.' });
    }

    const previousPlan = user.plan;
    const targetPlan = normalizePlan(parsed.data.plan);
    const durationHours = parsed.data.durationHours;
    const durationDays =
      durationHours !== undefined
        ? durationHours === -1
          ? -1
          : durationHours / 24
        : parsed.data.durationDays;

    const patch: Partial<typeof users.$inferInsert> = {
      plan: targetPlan,
      planUpgradedAt: new Date(),
      updatedAt: new Date(),
    };

    if (parsed.data.isLifetime || durationDays === -1 || targetPlan === 'ghost') {
      patch.isLifetime =
        targetPlan !== 'ghost' &&
        (Boolean(parsed.data.isLifetime) || durationDays === -1);
      patch.planExpiresAt = null;
    } else if (durationDays !== undefined && durationDays > 0) {
      patch.isLifetime = false;
      patch.planExpiresAt = new Date(
        Date.now() + durationDays * 86_400_000,
      );
    }

    // Los límites personalizados solo se conservan si se sigue en el mismo
    // plan y el admin no envió un paquete nuevo. Al cambiar de plan se vuelve
    // a los límites base para no heredar privilegios de la licencia anterior.
    const planChanged = normalizePlan(user.plan) !== targetPlan;
    if (targetPlan === 'ghost') {
      patch.customPlanName = null;
      patch.maxProfiles = null;
      patch.maxSessions = null;
      patch.maxApiKeys = null;
    } else if (
      parsed.data.customPlanName !== undefined ||
      parsed.data.maxProfiles !== undefined ||
      parsed.data.maxSessions !== undefined ||
      parsed.data.maxApiKeys !== undefined
    ) {
      if (parsed.data.customPlanName !== undefined) {
        patch.customPlanName = parsed.data.customPlanName;
      }
      if (parsed.data.maxProfiles !== undefined) patch.maxProfiles = parsed.data.maxProfiles;
      if (parsed.data.maxSessions !== undefined) patch.maxSessions = parsed.data.maxSessions;
      if (parsed.data.maxApiKeys !== undefined) patch.maxApiKeys = parsed.data.maxApiKeys;
    } else if (planChanged) {
      patch.customPlanName = null;
      patch.maxProfiles = null;
      patch.maxSessions = null;
      patch.maxApiKeys = null;
    }

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, user.id))
      .returning();

    await logActivity(
      db,
      req.user!.id,
      'admin_plan_change',
      'user',
      user.id,
      {
        from: previousPlan,
        to: targetPlan,
        isLifetime: updated.isLifetime,
        planExpiresAt: updated.planExpiresAt,
      },
      req.ip,
    );

    const status = getSubscriptionStatus(updated);
    res.json({
      id: updated.id,
      plan: updated.plan,
      planName: status.planName,
      isLifetime: updated.isLifetime,
      planExpiresAt: updated.planExpiresAt,
      daysRemaining: status.daysRemaining,
      planUpgradedAt: updated.planUpgradedAt,
    });
  }),
);

router.patch(
  '/:id/role',
  authenticate,
  requireOwner,
  asyncHandler(async (req, res) => {
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'owner' && parsed.data.role !== 'owner') {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.role, 'owner'));
      if ((row?.count ?? 0) <= 1) {
        return res.status(409).json({
          error: 'No se puede quitar el rol al último Owner. Asigna otro Owner primero.',
        });
      }
    }

    const previousRole = user.role;
    const [updated] = await db
      .update(users)
      .set({
        role: parsed.data.role,
        isAdmin: parsed.data.role === 'owner' || parsed.data.role === 'admin',
        ...(parsed.data.sellerCredits !== undefined
          ? { sellerCredits: parsed.data.sellerCredits }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();

    await logActivity(
      db,
      req.user!.id,
      'owner_role_change',
      'user',
      user.id,
      {
        fromRole: previousRole,
        toRole: updated.role,
        sellerCredits: updated.sellerCredits,
      },
      req.ip,
    );

    res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      isAdmin: updated.isAdmin,
      sellerCredits: updated.sellerCredits ?? 0,
    });
  }),
);

router.get(
  '/admin/analytics',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const countOf = async (table: any, condition?: any) => {
      const query = db.select({ count: sql<number>`count(*)::int` }).from(table);
      const [row] = condition ? await query.where(condition) : await query;
      return row?.count ?? 0;
    };

    const [
      totalUsers,
      ghostUsers,
      shadowUsers,
      specterUsers,
      phantomUsers,
      totalProfiles,
      activeSessions,
      totalKeys,
      activeKeys,
      redeemedKeys,
      revokedKeys,
    ] = await Promise.all([
      countOf(users),
      countOf(users, eq(users.plan, 'ghost')),
      countOf(users, eq(users.plan, 'shadow')),
      countOf(users, eq(users.plan, 'specter')),
      countOf(users, eq(users.plan, 'phantom')),
      countOf(profiles),
      countOf(sessions, eq(sessions.status, 'active')),
      countOf(licenseKeys),
      countOf(licenseKeys, eq(licenseKeys.status, 'active')),
      countOf(licenseKeys, eq(licenseKeys.status, 'redeemed')),
      countOf(licenseKeys, eq(licenseKeys.status, 'revoked')),
    ]);

    const mrr =
      shadowUsers * PLAN_CONFIGS.shadow.price +
      specterUsers * PLAN_CONFIGS.specter.price +
      phantomUsers * PLAN_CONFIGS.phantom.price;

    res.json({
      totalUsers,
      usersByPlan: {
        ghost: ghostUsers,
        shadow: shadowUsers,
        specter: specterUsers,
        phantom: phantomUsers,
      },
      mrr,
      mrrEstimated: true,
      mrrCurrency: 'USD',
      mrrNote:
        'Estimación con precio de lista; no incluye descuentos, créditos ni licencias vitalicias.',
      totalProfiles,
      activeSessions,
      keys: {
        total: totalKeys,
        active: activeKeys,
        redeemed: redeemedKeys,
        revoked: revokedKeys,
      },
    });
  }),
);

router.post(
  '/:id/reset-hwid',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }

    const db = dbOf(req);
    const user = await getUser(db, req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.role === 'owner' && req.user!.role !== 'owner') {
      return res
        .status(403)
        .json({ error: 'Solo el Owner puede resetear su propio HWID.' });
    }

    await db
      .update(users)
      .set({ deviceHwid: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));

    await logActivity(db, req.user!.id, 'admin_reset_hwid', 'user', user.id, {}, req.ip);
    res.json({ success: true, message: 'Dispositivo HWID desvinculado con éxito.' });
  }),
);

router.get(
  '/admin/backup',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    res.set('Cache-Control', 'no-store');

    const [userRows, keyRows, profileRows] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
          email: users.email,
          role: users.role,
          isAdmin: users.isAdmin,
          banned: users.banned,
          plan: users.plan,
          sellerCredits: users.sellerCredits,
          planUpgradedAt: users.planUpgradedAt,
          planExpiresAt: users.planExpiresAt,
          isLifetime: users.isLifetime,
          lastLoginAt: users.lastLoginAt,
          twoFactorEnabled: users.twoFactorEnabled,
          createdAt: users.createdAt,
        })
        .from(users),
      db.select().from(licenseKeys),
      db.select().from(profiles),
    ]);

    await logActivity(
      db,
      req.user!.id,
      'admin_export_data',
      'system',
      'users,keys,profiles',
      { users: userRows.length, keys: keyRows.length, profiles: profileRows.length },
      req.ip,
    );

    res.json({
      exportedAt: new Date().toISOString(),
      exportedBy: req.user!.id,
      complete: false,
      note:
        'Exportación parcial de datos. Para un backup completo y restaurable usa ops/backup/krakenges-backup.sh.',
      usersCount: userRows.length,
      keysCount: keyRows.length,
      profilesCount: profileRows.length,
      users: userRows,
      keys: keyRows,
      profiles: profileRows,
    });
  }),
);

router.post(
  '/admin/purge-sessions',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(sessions)
      .where(and(eq(sessions.status, 'stopped'), lt(sessions.stoppedAt, cutoff)))
      .returning({ id: sessions.id });

    res.json({ success: true, deletedCount: deleted.length });
  }),
);

router.get(
  '/:id/activity',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido' });
    }

    const db = dbOf(req);
    const logs = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.userId, req.params.id))
      .orderBy(desc(activityLogs.createdAt))
      .limit(50);

    res.json(logs);
  }),
);

export default router;

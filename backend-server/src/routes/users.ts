import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import User from '../models/User';
import Profile from '../models/Profile';
import BrowserState from '../models/BrowserState';
import ApiKey from '../models/ApiKey';
import ActivityLog from '../models/ActivityLog';
import Session from '../models/Session';
import LicenseKey from '../models/LicenseKey';
import RefreshToken from '../models/RefreshToken';
import { authenticate, requireAdmin, requireOwner } from '../authMiddleware';
import { logActivity } from '../services/activityLog';
import { generateTwoFactorSecret, verifyTwoFactorToken } from '../services/twoFactor';
import { isMailConfigured, sendPasswordResetEmail } from '../services/mailer';
import { normalizePlan, PLAN_CONFIGS } from '../config/plans';
import { checkAndHandleSubscriptionExpiry, getSubscriptionStatus } from '../services/subscriptionService';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const banSchema = z.object({
  banned: z.boolean(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8),
});

const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const enable2FASchema = z.object({
  token: z.string().length(6),
});

const disable2FASchema = z.object({
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordWithTokenSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

const adminUpdatePlanSchema = z.object({
  plan: z.enum(['ghost', 'shadow', 'specter', 'phantom', 'free', 'pro', 'enterprise']),
  durationDays: z.number().int().min(-1).optional(),
  isLifetime: z.boolean().optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'seller', 'user']),
  sellerCredits: z.number().int().min(0).optional(),
});

router.get('/', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });

  const usersWithStats = await Promise.all(
    users.map(async (user) => {
      await checkAndHandleSubscriptionExpiry(user);
      const subStatus = getSubscriptionStatus(user);

      const [profilesCount, apiKeysCount, activeSessionsCount] = await Promise.all([
        Profile.countDocuments({ userId: user._id }),
        ApiKey.countDocuments({ userId: user._id, isActive: true }),
        Session.countDocuments({ userId: user._id, status: 'active' }),
      ]);

      const limits = subStatus.limits;

      return {
        id: user._id,
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
          profiles: { current: profilesCount, max: limits.maxProfiles },
          activeSessions: { current: activeSessionsCount, max: limits.maxSessions },
          apiKeys: { current: apiKeysCount, max: limits.maxApiKeys },
        },
      };
    })
  );

  res.json(usersWithStats);
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!._id).select('-passwordHash');
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  await checkAndHandleSubscriptionExpiry(user, req.ip);
  const subStatus = getSubscriptionStatus(user);

  res.json({
    ...user.toJSON(),
    role: user.role || (user.isAdmin ? 'admin' : 'user'),
    sellerCredits: user.sellerCredits ?? 0,
    normalizedPlan: subStatus.normalizedPlan,
    planName: subStatus.planName,
    daysRemaining: subStatus.daysRemaining,
    limits: subStatus.limits,
  });
}));

router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (parsed.data.name) {
    user.name = parsed.data.name.trim();
  }

  await user.save();
  await logActivity(user._id, 'update_profile', 'user', user._id.toString(), { name: user.name }, req.ip);

  res.json({
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    isAdmin: user.isAdmin,
    plan: user.plan,
    twoFactorEnabled: user.twoFactorEnabled,
  });
}));

router.post('/me/change-password', authenticate, asyncHandler(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const validPassword = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!validPassword) {
    return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
  }

  user.passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  user.passwordChangedAt = new Date();
  await user.save();

  // Cambiar la contraseña invalida todas las sesiones emitidas con la anterior.
  await RefreshToken.deleteMany({ userId: user._id });

  await logActivity(user._id, 'change_password', 'user', user._id.toString(), undefined, req.ip);

  res.json({ message: 'Contraseña actualizada correctamente' });
}));

router.post('/me/2fa/enable', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }

  const { secret, otpauthUrl } = generateTwoFactorSecret();

  user.twoFactorSecret = secret;
  await user.save();

  res.json({ secret, otpauthUrl });
}));

router.post('/me/2fa/verify', authenticate, asyncHandler(async (req, res) => {
  const parsed = enable2FASchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.user!._id);
  if (!user || !user.twoFactorSecret) {
    return res.status(400).json({ error: '2FA not initialized' });
  }

  const isValid = verifyTwoFactorToken(user.twoFactorSecret, parsed.data.token);
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid 2FA token' });
  }

  user.twoFactorEnabled = true;
  await user.save();

  await logActivity(user._id, '2fa_enable', 'user', user._id.toString(), undefined, req.ip);

  res.json({ message: '2FA enabled' });
}));

router.post('/me/2fa/disable', authenticate, asyncHandler(async (req, res) => {
  const parsed = disable2FASchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const validPassword = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  await user.save();

  await logActivity(user._id, '2fa_disable', 'user', user._id.toString(), undefined, req.ip);

  res.json({ message: '2FA disabled' });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  // Sin proveedor de correo el flujo no puede funcionar. Antes se generaba el
  // token, se guardaba y se respondía como si se hubiera enviado: el usuario
  // esperaba un correo que nunca llegaba. Ahora se falla de forma explícita.
  if (!isMailConfigured()) {
    return res.status(503).json({
      error: 'El restablecimiento por correo no está configurado. Contacta con el administrador.',
    });
  }

  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findOne({ email: parsed.data.email });
  if (!user || !user.email) {
    return res.json({ message: 'Si el correo existe en el sistema, se ha procesado la solicitud.' });
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = resetExpires;
  await user.save();

  const delivered = await sendPasswordResetEmail(user.email, rawToken);
  if (!delivered) {
    // No dejar un token vivo que el usuario no puede usar.
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
  }

  await logActivity(
    user._id,
    'forgot_password',
    'user',
    user._id.toString(),
    { delivered },
    req.ip,
  );

  // Respuesta genérica siempre: no revelar si el correo existe ni si el envío
  // falló. El administrador lo ve en el log de actividad y en los errores.
  res.json({ message: 'Si el correo existe en el sistema, se ha procesado la solicitud.' });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const parsed = resetPasswordWithTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const hashedToken = crypto.createHash('sha256').update(parsed.data.token).digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  user.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.passwordChangedAt = new Date();
  await user.save();

  // Un reset invalida cualquier sesión que siguiera abierta.
  await RefreshToken.deleteMany({ userId: user._id });

  await logActivity(user._id, 'reset_password', 'user', user._id.toString(), undefined, req.ip);

  res.json({ message: 'Password reset successfully' });
}));

router.patch('/:id/ban', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user._id.equals(req.user!._id)) {
    return res.status(400).json({ error: 'No puedes banearte a ti mismo' });
  }

  if (user.role === 'owner') {
    return res.status(403).json({ error: 'La cuenta del Owner es inmune y no puede ser baneada.' });
  }

  user.banned = parsed.data.banned;
  await user.save();

  if (parsed.data.banned) {
    // Un baneo no puede dejar sesiones activas por detrás.
    await RefreshToken.deleteMany({ userId: user._id });
  }

  await logActivity(req.user!._id, parsed.data.banned ? 'ban' : 'unban', 'user', user._id.toString(), { email: user.email }, req.ip);

  res.json({ id: user._id, banned: user.banned });
}));

/**
 * Borrado de usuario desde el panel.
 *
 * La vista ya llamaba a `DELETE /users/:id`, pero la ruta no existía: el botón
 * devolvía 404. Se borra en cascada lo que pertenece al usuario, no las
 * licencias ya canjeadas (se conservan como historial) ni el log de auditoría.
 */
router.delete('/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Identificador de usuario inválido' });
  }
  if (id === req.user!._id.toString()) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta desde el panel.' });
  }

  const user = await User.findById(id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'owner') {
    return res.status(403).json({ error: 'La cuenta del Owner no se puede eliminar.' });
  }

  const [profiles, sessions, apiKeys, refreshTokens, browserStates] = await Promise.all([
    Profile.deleteMany({ userId: user._id }),
    Session.deleteMany({ userId: user._id }),
    ApiKey.deleteMany({ userId: user._id }),
    RefreshToken.deleteMany({ userId: user._id }),
    BrowserState.deleteMany({ userId: user._id }),
  ]);

  await user.deleteOne();

  // Las licencias canjeadas se conservan para auditoría, pero se desvinculan
  // del usuario borrado.
  await LicenseKey.updateMany({ redeemedBy: user._id }, { $set: { redeemedBy: null } });

  await logActivity(
    req.user!._id,
    'admin_delete_user',
    'user',
    id,
    {
      email: user.email,
      profiles: profiles.deletedCount,
      sessions: sessions.deletedCount,
      apiKeys: apiKeys.deletedCount,
      refreshTokens: refreshTokens.deletedCount,
      browserStates: browserStates.deletedCount,
    },
    req.ip,
  );

  res.json({
    success: true,
    deleted: {
      profiles: profiles.deletedCount,
      sessions: sessions.deletedCount,
      apiKeys: apiKeys.deletedCount,
      refreshTokens: refreshTokens.deletedCount,
      browserStates: browserStates.deletedCount,
    },
  });
}));

router.post('/:id/reset-password', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.role === 'owner' && req.user!.role !== 'owner') {
    return res.status(403).json({ error: 'Solo el Owner puede resetear su propia contraseña.' });
  }

  user.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  user.passwordChangedAt = new Date();
  await user.save();

  // El reset del administrador también cierra las sesiones del usuario.
  await RefreshToken.deleteMany({ userId: user._id });

  await logActivity(req.user!._id, 'reset_password', 'user', user._id.toString(), { email: user.email }, req.ip);

  res.json({ message: 'Password actualizado' });
}));

router.patch('/:id/plan', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const parsed = adminUpdatePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const previousPlan = user.plan;
  const targetPlan = normalizePlan(parsed.data.plan);
  user.plan = targetPlan;
  user.planUpgradedAt = new Date();

  if (parsed.data.isLifetime || parsed.data.durationDays === -1 || targetPlan === 'ghost') {
    user.isLifetime = targetPlan !== 'ghost' && (!!parsed.data.isLifetime || parsed.data.durationDays === -1);
    user.planExpiresAt = null;
  } else if (parsed.data.durationDays && parsed.data.durationDays > 0) {
    user.isLifetime = false;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + parsed.data.durationDays);
    user.planExpiresAt = expiry;
  }

  await user.save();

  await logActivity(
    req.user!._id,
    'admin_plan_change',
    'user',
    user._id.toString(),
    { from: previousPlan, to: targetPlan, isLifetime: user.isLifetime, planExpiresAt: user.planExpiresAt },
    req.ip
  );

  const status = getSubscriptionStatus(user);
  res.json({
    id: user._id,
    plan: user.plan,
    planName: status.planName,
    isLifetime: user.isLifetime,
    planExpiresAt: user.planExpiresAt,
    daysRemaining: status.daysRemaining,
    planUpgradedAt: user.planUpgradedAt,
  });
}));

// OWNER ONLY: Assign roles (Owner, Admin, Seller, User) and Seller credits
router.patch('/:id/role', authenticate, requireOwner, asyncHandler(async (req, res) => {
  const parsed = updateRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // No dejar el sistema sin Owner. Sin esto, el único owner podía cambiarse
  // el rol a sí mismo y dejar la instalación sin nadie que pudiera revertirlo.
  if (user.role === 'owner' && parsed.data.role !== 'owner') {
    const owners = await User.countDocuments({ role: 'owner' });
    if (owners <= 1) {
      return res.status(409).json({
        error: 'No se puede quitar el rol al último Owner. Asigna otro Owner primero.',
      });
    }
  }

  const previousRole = user.role;
  user.role = parsed.data.role;
  user.isAdmin = parsed.data.role === 'owner' || parsed.data.role === 'admin';

  if (parsed.data.sellerCredits !== undefined) {
    user.sellerCredits = parsed.data.sellerCredits;
  }

  await user.save();

  await logActivity(
    req.user!._id,
    'owner_role_change',
    'user',
    user._id.toString(),
    { fromRole: previousRole, toRole: user.role, sellerCredits: user.sellerCredits },
    req.ip
  );

  res.json({
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    isAdmin: user.isAdmin,
    sellerCredits: user.sellerCredits ?? 0,
  });
}));

router.get('/admin/analytics', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
  const totalUsers = await User.countDocuments();
  const ghostUsers = await User.countDocuments({ plan: { $in: ['ghost', 'free'] } });
  const shadowUsers = await User.countDocuments({ plan: { $in: ['shadow', 'pro'] } });
  const specterUsers = await User.countDocuments({ plan: 'specter' });
  const phantomUsers = await User.countDocuments({ plan: { $in: ['phantom', 'enterprise'] } });

  // Precio de lista, no caja real: no hay modelo de pagos, descuentos,
  // créditos de revendedor ni licencias vitalicias. Se etiqueta como estimación
  // para no presentar una cifra inventada como ingreso contable.
  const mrr =
    shadowUsers * PLAN_CONFIGS.shadow.price +
    specterUsers * PLAN_CONFIGS.specter.price +
    phantomUsers * PLAN_CONFIGS.phantom.price;

  const totalProfiles = await Profile.countDocuments();
  const activeSessions = await Session.countDocuments({ status: 'active' });

  const totalKeys = await LicenseKey.countDocuments();
  const activeKeys = await LicenseKey.countDocuments({ status: 'active' });
  const redeemedKeys = await LicenseKey.countDocuments({ status: 'redeemed' });
  const revokedKeys = await LicenseKey.countDocuments({ status: 'revoked' });

  res.json({
    totalUsers,
    usersByPlan: { ghost: ghostUsers, shadow: shadowUsers, specter: specterUsers, phantom: phantomUsers },
    mrr,
    mrrEstimated: true,
    mrrCurrency: 'USD',
    mrrNote: 'Estimación con precio de lista; no incluye descuentos, créditos ni licencias vitalicias.',
    totalProfiles,
    activeSessions,
    keys: { total: totalKeys, active: activeKeys, redeemed: redeemedKeys, revoked: revokedKeys },
  });
}));

router.post('/:id/reset-hwid', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Un admin no puede desvincular el dispositivo del Owner.
  if (user.role === 'owner' && req.user!.role !== 'owner') {
    return res.status(403).json({ error: 'Solo el Owner puede resetear su propio HWID.' });
  }

  (user as any).deviceHwid = undefined;
  await user.save();
  await RefreshToken.deleteMany({ userId: user._id });
  await logActivity(req.user!._id, 'admin_reset_hwid', 'user', user._id.toString(), {}, req.ip);
  res.json({ success: true, message: 'Dispositivo HWID desvinculado con éxito.' });
}));

router.get('/admin/backup', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  // No es un backup de MongoDB: no incluye BrowserState, sesiones, actividad,
  // refresh tokens ni configuración. Se mantiene como exportación de datos para
  // el panel, pero se marca como parcial y se audita. El backup real se hace
  // con ops/backup/krakenges-backup.sh (mongodump cifrado).
  res.set('Cache-Control', 'no-store');

  const users = await User.find().select(
    '-passwordHash -twoFactorSecret -passwordResetToken -passwordResetExpires',
  );
  const keys = await LicenseKey.find();
  const profiles = await Profile.find();

  await logActivity(
    req.user!._id,
    'admin_export_data',
    'system',
    'users,keys,profiles',
    { users: users.length, keys: keys.length, profiles: profiles.length },
    req.ip,
  );

  res.json({
    exportedAt: new Date().toISOString(),
    exportedBy: req.user!._id.toString(),
    complete: false,
    note: 'Exportación parcial de datos. Para un backup completo y restaurable usa ops/backup/krakenges-backup.sh.',
    usersCount: users.length,
    keysCount: keys.length,
    profilesCount: profiles.length,
    users,
    keys,
    profiles,
  });
}));

router.post('/admin/purge-sessions', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await Session.deleteMany({ status: 'stopped', updatedAt: { $lt: thirtyDaysAgo } });
  res.json({ success: true, deletedCount: result.deletedCount });
}));

router.get('/:id/activity', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const logs = await ActivityLog.find({ userId: req.params.id })
    .sort({ createdAt: -1 })
    .limit(50);
  res.json(logs);
}));

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import User, { UserRole } from '../models/User';
import LicenseKey from '../models/LicenseKey';
import RefreshToken, { hashRefreshToken, storedRefreshTokenValue, type IRefreshToken } from '../models/RefreshToken';
import { config } from '../config';
import { signJwt, PRE_AUTH_PURPOSE } from '../utils/jwt';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { logActivity } from '../services/activityLog';
import { verifyTwoFactorToken } from '../services/twoFactor';
import { normalizePlan } from '../config/plans';
import { checkAndHandleSubscriptionExpiry } from '../services/subscriptionService';
import { publicUser } from '../services/licenseTicket';
import { authenticate } from '../authMiddleware';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// Anti-Brute Force rate limiters for authentication
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Max 10 intentos de login cada 15 min por IP
  message: { error: 'Demasiados intentos de inicio de sesión fallidos. Por favor espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 15, // Max 15 cuentas creadas por hora por IP
  message: { error: 'Has alcanzado el límite de registros permitidos. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// El TOTP acepta ±2 pasos de 30s => ~5 códigos válidos simultáneos. Sin este
// límite (que antes no existía) el 2FA era susceptible a fuerza bruta.
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 códigos 2FA por IP cada 15 min
  message: { error: 'Demasiados intentos de verificación 2FA. Por favor espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerSchema = z.object({
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(100).trim(),
  username: z
    .string()
    .min(3, 'El usuario debe tener al menos 3 caracteres')
    .max(30, 'El usuario no puede superar 30 caracteres')
    .regex(/^[a-zA-Z0-9_]+$/, 'El usuario solo puede contener letras, números y guión bajo')
    .trim(),
  email: z.string().email('Formato de correo inválido').optional().or(z.literal('')),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128),
  key: z.string().min(1, 'El código de licencia es obligatorio para registrarse.').trim(),
});

/**
 * Deduce la plataforma desde el prefijo del HWID.
 *
 * El cliente Rust genera un hash hexadecimal sin prefijo; el movil usa otro
 * formato, asi que se usa lo que declara el cliente cuando viene y se cae a
 * "unknown" antes que inventar. No es critico: el dato es informativo.
 */
function inferPlatform(declared: string | undefined, hwid: string): string {
  if (declared) return declared.toLowerCase();
  const lower = hwid.toLowerCase();
  if (lower.startsWith('android-')) return 'android';
  if (lower.startsWith('ios-')) return 'ios';
  if (lower.startsWith('win')) return 'windows';
  if (lower.startsWith('mac')) return 'macos';
  if (lower.startsWith('linux')) return 'linux';
  return 'unknown';
}

const loginSchema = z
  .object({
    email: z.string().email().optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1, 'La contraseña es obligatoria'),
    hwid: z.string().optional(),
    // Plataforma desde la que se inicia sesion. Se registra junto al HWID para
    // que el usuario vea en que equipos esta activa su cuenta.
    platform: z.string().max(24).optional(),
    deviceLabel: z.string().max(120).optional(),
  })
  .refine((d) => d.email || d.username, { message: 'Debes ingresar usuario o correo' });

async function createRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(64).toString('hex');
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 días de validez máxima

  await RefreshToken.create({
    userId: new Types.ObjectId(userId),
    // `token` es el alias único del hash; el valor en claro solo se devuelve
    // al cliente y no se persiste.
    token: storedRefreshTokenValue(tokenHash),
    tokenHash,
    expiresAt,
  });

  return token;
}

router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const { name, username, email, password, key } = parsed.data;
  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email && email.trim().length > 0 ? email.trim().toLowerCase() : undefined;
  const cleanKey = key.trim().toUpperCase();

  const existingUser = await User.findOne({
    $or: [
      { username: { $regex: new RegExp(`^${cleanUsername}$`, 'i') } },
      ...(cleanEmail ? [{ email: cleanEmail }] : []),
    ],
  });
  if (existingUser) {
    return res.status(409).json({ error: 'El nombre de usuario o correo ya está registrado.' });
  }

  // Validación y canje atómico de la clave de licencia
  const matchedLicense = await LicenseKey.findOneAndUpdate(
    {
      key: cleanKey,
      status: 'active',
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    },
    {
      $set: {
        status: 'redeemed',
        isActive: false,
      },
    },
    { new: true }
  );

  if (!matchedLicense) {
    const existing = await LicenseKey.findOne({ key: cleanKey });
    if (!existing) {
      return res.status(400).json({ error: 'La clave de licencia no existe o es inválida.' });
    }
    if (existing.status === 'redeemed') {
      return res.status(400).json({ error: 'Esta clave de licencia ya ha sido utilizada.' });
    }
    if (existing.status === 'revoked') {
      return res.status(400).json({ error: 'Esta clave de licencia ha sido revocada.' });
    }
    if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'Esta clave de licencia ha expirado.' });
    }
    return res.status(400).json({ error: 'La clave de licencia no está disponible para su activación.' });
  }

  const assignedPlan = normalizePlan(matchedLicense.plan);
  const userRole: UserRole = matchedLicense.role || 'user';
  let isLifetime = false;
  let planExpiresAt: Date | null = null;

  if (matchedLicense.durationDays === -1) {
    isLifetime = true;
    planExpiresAt = null;
  } else {
    isLifetime = false;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + (matchedLicense.durationDays || 30));
    planExpiresAt = expiry;
  }

  let newUser;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    newUser = await User.create({
      name: name.trim(),
      username: cleanUsername,
      email: cleanEmail,
      passwordHash,
      role: userRole,
      isAdmin: userRole === 'admin',
      plan: assignedPlan,
      planUpgradedAt: new Date(),
      planExpiresAt,
      isLifetime,
    });

    matchedLicense.redeemedBy = newUser._id;
    matchedLicense.redeemedAt = new Date();
    await matchedLicense.save();
  } catch (err: any) {
    // Revertir canje de la clave si la creación de usuario falla
    await LicenseKey.findByIdAndUpdate(matchedLicense._id, {
      status: 'active',
      isActive: true,
      redeemedBy: null,
      redeemedAt: null,
    });
    return res.status(500).json({ error: 'Error al registrar el usuario en la base de datos.' });
  }

  const accessToken = signJwt({ userId: newUser._id.toString(), isAdmin: newUser.isAdmin }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  const refreshToken = await createRefreshToken(newUser._id.toString());

  await logActivity(newUser._id, 'register', 'user', newUser._id.toString(), { email: cleanEmail, plan: assignedPlan }, req.ip);

  res.cookie('gestor_access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.cookie('gestor_refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.status(201).json({
    accessToken,
    refreshToken,
    user: publicUser(newUser),
  });
}));

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const { email, username, password } = parsed.data;

  const user = await User.findOne({
    $or: [
      ...(username ? [{ username }] : []),
      ...(email ? [{ email }] : []),
    ],
  });
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (user.banned) {
    return res.status(403).json({ error: 'Account has been suspended' });
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Registro del dispositivo. ANTES esto era un candado: un unico `deviceHwid`
  // y un 403 si venia de otro equipo. Eso hacia imposible el uso normal de un
  // producto multiplataforma, donde la misma persona abre Kraken Ges en Windows, en
  // Linux y en el movil con la misma key.
  //
  // Ahora el HWID SOLO se registra: sirve para que el usuario y soporte vean
  // donde esta activa la cuenta, no para limitarlo. El limite de dispositivos y
  // la verificacion fuerte se implementaran mas adelante.
  const clientHwid = parsed.data.hwid ? parsed.data.hwid.trim() : null;
  if (clientHwid) {
    // La plataforma no la manda el cliente de forma confiable, asi que se
    // infiere del HWID que produce cada motor (ver license.rs / get_hwid).
    const platform = inferPlatform(parsed.data.platform, clientHwid);
    const devices = Array.isArray(user.devices) ? user.devices : [];

    const existing = devices.find((d) => d.hwid === clientHwid);
    if (existing) {
      existing.lastSeen = new Date();
      existing.platform = platform;
    } else {
      devices.push({
        hwid: clientHwid,
        platform,
        label: parsed.data.deviceLabel || '',
        firstSeen: new Date(),
        lastSeen: new Date(),
      });
    }
    user.devices = devices;
    // Se conserva el campo legacy: algunas consultas de soporte lo leen.
    if (!user.deviceHwid) user.deviceHwid = clientHwid;
  }

  await checkAndHandleSubscriptionExpiry(user, req.ip);
  user.lastLoginAt = new Date();
  await user.save();

  // Antes se devolvía el userId y /login/2fa solo pedía userId + código: la
  // contraseña no intervenía en el segundo paso, así que bastaba conocer el id
  // de alguien para entrar con un TOTP. Ahora el paso 1 emite un token firmado
  // de 5 minutos que demuestra que la contraseña ya se verificó.
  if (user.twoFactorEnabled) {
    const preAuthToken = signJwt(
      { sub: user._id.toString(), purpose: PRE_AUTH_PURPOSE },
      config.jwtSecret,
      { expiresIn: '5m' },
    );
    return res.json({ requires2FA: true, preAuthToken });
  }

  const accessToken = signJwt({ userId: user._id.toString(), isAdmin: user.isAdmin }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  const refreshToken = await createRefreshToken(user._id.toString());

  await logActivity(user._id, 'login', 'user', user._id.toString(), { username: user.username }, req.ip);

  res.cookie('gestor_access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.cookie('gestor_refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    accessToken,
    refreshToken,
    user: publicUser(user),
  });
}));

const login2FASchema = z.object({
  preAuthToken: z.string().min(1),
  token: z.string().length(6),
});

router.post('/login/2fa', twoFactorLimiter, asyncHandler(async (req, res) => {
  const parsed = login2FASchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  let pending: { sub?: string; purpose?: string; iat?: number };
  try {
    pending = jwt.verify(parsed.data.preAuthToken, config.jwtSecret) as typeof pending;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired 2FA session' });
  }
  if (pending.purpose !== PRE_AUTH_PURPOSE || !pending.sub) {
    return res.status(401).json({ error: 'Invalid or expired 2FA session' });
  }

  const user = await User.findById(pending.sub);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Un token pre-2FA emitido antes de un cambio de contraseña ya no vale.
  if (user.passwordChangedAt && pending.iat) {
    if (pending.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      return res.status(401).json({ error: 'Invalid or expired 2FA session' });
    }
  }

  if (user.banned) {
    return res.status(403).json({ error: 'Account has been suspended' });
  }

  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    return res.status(400).json({ error: '2FA not enabled' });
  }

  const isValid = verifyTwoFactorToken(user.twoFactorSecret, parsed.data.token);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid 2FA token' });
  }

  await checkAndHandleSubscriptionExpiry(user, req.ip);
  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = signJwt({ userId: user._id.toString(), isAdmin: user.isAdmin }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  const refreshToken = await createRefreshToken(user._id.toString());

  await logActivity(user._id, 'login', 'user', user._id.toString(), { username: user.username, twoFactor: true }, req.ip);

  res.cookie('gestor_access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.cookie('gestor_refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    accessToken,
    refreshToken,
    user: publicUser(user),
  });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.gestor_refresh_token || (req.body as any)?.refreshToken;
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const presentedHash = hashRefreshToken(refreshToken);
  let stored = (await RefreshToken.findOne({ tokenHash: presentedHash })) as IRefreshToken | null;

  // Compatibilidad con tokens emitidos antes del hash: se migran en el primer
  // refresco. No se acepta `sha256:<hash>` como token en claro.
  if (!stored && !refreshToken.startsWith('sha256:')) {
    const legacy = await RefreshToken.findOne({ token: refreshToken }).select('+token +tokenHash');
    if (legacy) {
      stored = legacy as unknown as IRefreshToken;
      stored.token = storedRefreshTokenValue(presentedHash);
      stored.tokenHash = presentedHash;
      await stored.save();
    }
  }

  if (!stored || stored.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const user = await User.findById(stored.userId).select('-passwordHash');
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  if (user.banned) {
    return res.status(403).json({ error: 'Account has been suspended' });
  }

  const accessToken = signJwt({ userId: user._id.toString(), isAdmin: user.isAdmin }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  const newRefreshToken = await createRefreshToken(user._id.toString());
  await RefreshToken.findByIdAndDelete(stored._id);

  res.cookie('gestor_access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.cookie('gestor_refresh_token', newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken, refreshToken: newRefreshToken });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.gestor_refresh_token || (req.body as any)?.refreshToken;
  if (refreshToken && typeof refreshToken === 'string') {
    const presentedHash = hashRefreshToken(refreshToken);
    const legacy = refreshToken.startsWith('sha256:') ? null : refreshToken;
    await RefreshToken.deleteMany({
      $or: [
        { tokenHash: presentedHash },
        ...(legacy ? [{ token: legacy }] : []),
      ],
    });
  }

  const userId = (req as any).user?._id;
  if (userId) {
    await logActivity(userId, 'logout', 'user', userId.toString(), undefined, req.ip);
  }

  res.clearCookie('gestor_access_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });

  res.clearCookie('gestor_refresh_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });

  res.json({ message: 'Logged out' });
}));

// Ticket de licencia fresco (con revalidación online). La app lo usa para
// actualizar su estado sin volver a hacer login, y para verificar que la
// licencia sigue válida (revocaciones, baneos, downgrades).
router.get('/ticket', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.banned) {
    return res.status(403).json({ error: 'Account has been suspended' });
  }

  await checkAndHandleSubscriptionExpiry(user, req.ip);

  res.json({ user: publicUser(user) });
}));

export default router;

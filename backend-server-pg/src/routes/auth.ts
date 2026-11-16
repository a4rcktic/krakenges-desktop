import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { and, eq, gt, ilike, isNull, or } from 'drizzle-orm';
import { licenseKeys, refreshTokens, users } from '../db/schema';
import type { Database } from '../db/client';
import type { UserRow } from '../db/schema';
import { config } from '../config';
import { signJwt, PRE_AUTH_PURPOSE } from '../utils/jwt';
import { dbOf } from '../db/context';
import { logActivity } from '../services/activityLog';
import { verifyTwoFactorToken } from '../services/twoFactor';
import { normalizePlan } from '../config/plans';
import { checkAndHandleSubscriptionExpiry } from '../services/subscriptionService';
import { publicUser } from '../services/licenseTicket';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../errors';
import { hashRefreshToken, storedRefreshTokenValue } from '../services/tokenHash';
import { isValidId } from '../services/profileService';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de inicio de sesión fallidos. Por favor espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { error: 'Has alcanzado el límite de registros permitidos. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de verificación 2FA. Por favor espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Límite adicional por cuenta. El límite por IP no frena un ataque distribuido
// contra un mismo userId; este sí. Se mantiene holgado para no bloquear a un
// usuario legítimo que se equivoque varias veces.
const twoFactorUserLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => {
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    if (userId) return `user:${userId}`;
    const preAuthToken =
      typeof req.body?.preAuthToken === 'string' ? req.body.preAuthToken : '';
    if (preAuthToken) return `preauth:${hashRefreshToken(preAuthToken)}`;
    return ipKeyGenerator(req.ip ?? '');
  },
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

const loginSchema = z
  .object({
    email: z.string().email().max(254).optional(),
    username: z.string().min(1).max(30).optional(),
    password: z.string().min(1, 'La contraseña es obligatoria').max(128),
    hwid: z.string().max(256).optional(),
    platform: z.string().max(24).optional(),
    deviceLabel: z.string().max(120).optional(),
  })
  .refine((d) => d.email || d.username, { message: 'Debes ingresar usuario o correo' });

const login2FASchema = z
  .object({
    // El cliente histórico envía `userId`; las versiones nuevas pueden enviar
    // el token pre-auth firmado. Se aceptan ambos para no romper la app móvil.
    userId: z.string().min(1).optional(),
    preAuthToken: z.string().min(1).optional(),
    token: z.string().length(6),
  })
  .refine((data) => Boolean(data.userId || data.preAuthToken), {
    message: 'userId o preAuthToken es obligatorio',
  });

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

async function createRefreshToken(db: Database, userId: string): Promise<string> {
  const token = crypto.randomBytes(64).toString('hex');
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokens).values({
    userId,
    token: storedRefreshTokenValue(tokenHash),
    tokenHash,
    expiresAt,
  });

  return token;
}

const cookieBase = {
  httpOnly: true,
  secure: config.isProduction,
  sameSite: 'strict' as const,
};

async function issueSession(
  db: Database,
  res: import('express').Response,
  user: UserRow,
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signJwt(
    { userId: user.id, isAdmin: user.isAdmin },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
  const refreshToken = await createRefreshToken(db, user.id);

  res.cookie('gestor_access_token', accessToken, {
    ...cookieBase,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.cookie('gestor_refresh_token', refreshToken, {
    ...cookieBase,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return { accessToken, refreshToken };
}

router.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const { name, username, email, password, key } = parsed.data;
    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email && email.trim().length > 0 ? email.trim().toLowerCase() : undefined;
    const cleanKey = key.trim().toUpperCase();
    const db = dbOf(req);

    const conditions = [ilike(users.username, cleanUsername)];
    if (cleanEmail) conditions.push(ilike(users.email, cleanEmail));

    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(...conditions))
      .limit(1);

    if (existingUser) {
      return res.status(409).json({ error: 'El nombre de usuario o correo ya está registrado.' });
    }

    let newUser: UserRow;
    try {
      newUser = await db.transaction(async (tx) => {
        const now = new Date();
        const [matchedLicense] = await tx
          .update(licenseKeys)
          .set({ status: 'redeemed', isActive: false })
          .where(
            and(
              eq(licenseKeys.key, cleanKey),
              eq(licenseKeys.status, 'active'),
              eq(licenseKeys.isActive, true),
              or(isNull(licenseKeys.expiresAt), gt(licenseKeys.expiresAt, now)),
            ),
          )
          .returning();

        if (!matchedLicense) {
          const [existing] = await tx
            .select()
            .from(licenseKeys)
            .where(eq(licenseKeys.key, cleanKey))
            .limit(1);

          if (!existing) {
            throw new HttpError(400, 'La clave de licencia no existe o es inválida.');
          }
          if (existing.status === 'redeemed') {
            throw new HttpError(400, 'Esta clave de licencia ya ha sido utilizada.');
          }
          if (existing.status === 'revoked') {
            throw new HttpError(400, 'Esta clave de licencia ha sido revocada.');
          }
          if (existing.expiresAt && new Date(existing.expiresAt) < now) {
            throw new HttpError(400, 'Esta clave de licencia ha expirado.');
          }
          throw new HttpError(400, 'La clave de licencia no está disponible para su activación.');
        }

        const assignedPlan = normalizePlan(matchedLicense.plan);
        const userRole = (matchedLicense.role || 'user') as 'user' | 'seller' | 'admin';
        let isLifetime = false;
        let planExpiresAt: Date | null = null;

        if (matchedLicense.durationDays === -1) {
          isLifetime = true;
        } else {
          // `??` y no `||`: una duración de 0 debe caducar de inmediato, no
          // convertirse en 30 días.
          const days = matchedLicense.durationDays ?? 30;
          planExpiresAt = new Date(now.getTime() + days * 86_400_000);
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const [created] = await tx
          .insert(users)
          .values({
            name: name.trim(),
            username: cleanUsername,
            email: cleanEmail ?? null,
            passwordHash,
            role: userRole,
            isAdmin: userRole === 'admin',
            plan: assignedPlan,
            customPlanName: matchedLicense.customPlanName ?? null,
            maxProfiles: matchedLicense.maxProfiles ?? null,
            maxSessions: matchedLicense.maxSessions ?? null,
            maxApiKeys: matchedLicense.maxApiKeys ?? null,
            planUpgradedAt: now,
            planExpiresAt,
            isLifetime,
            devices: [],
          })
          .returning();

        await tx
          .update(licenseKeys)
          .set({ redeemedBy: created.id, redeemedAt: now })
          .where(eq(licenseKeys.id, matchedLicense.id));

        return created;
      });
    } catch (err: any) {
      if (err instanceof HttpError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'El nombre de usuario o correo ya está registrado.' });
      }
      throw err;
    }

    const { accessToken, refreshToken } = await issueSession(db, res, newUser);

    await logActivity(
      db,
      newUser.id,
      'register',
      'user',
      newUser.id,
      { email: cleanEmail, plan: newUser.plan },
      req.ip,
    );

    return res.status(201).json({
      accessToken,
      refreshToken,
      user: publicUser(newUser),
    });
  }),
);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const { email, username, password } = parsed.data;
    const db = dbOf(req);

    const conditions = [];
    if (username) conditions.push(ilike(users.username, username.trim()));
    if (email) conditions.push(ilike(users.email, email.trim()));

    const [found] = await db
      .select()
      .from(users)
      .where(or(...conditions))
      .limit(1);

    if (!found) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (found.banned) {
      return res.status(403).json({ error: 'Account has been suspended' });
    }

    const validPassword = await bcrypt.compare(password, found.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let user = await checkAndHandleSubscriptionExpiry(db, found, req.ip);
    const patch: Partial<typeof users.$inferInsert> = {
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    };

    const clientHwid = parsed.data.hwid ? parsed.data.hwid.trim() : null;
    if (clientHwid) {
      const platform = inferPlatform(parsed.data.platform, clientHwid);
      const devices = Array.isArray(user.devices) ? [...user.devices] : [];
      const existing = devices.find((device) => device.hwid === clientHwid);
      const now = new Date().toISOString();

      if (existing) {
        existing.lastSeen = now;
        existing.platform = platform;
      } else {
        // Evita que una cuenta con credenciales válidas haga crecer el JSONB
        // sin límite enviando hwids distintos en cada login.
        const MAX_DEVICES = 20;
        if (devices.length >= MAX_DEVICES) {
          devices.sort(
            (a, b) =>
              new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime(),
          );
          devices.splice(0, devices.length - MAX_DEVICES + 1);
        }
        devices.push({
          hwid: clientHwid,
          platform,
          label: parsed.data.deviceLabel || '',
          firstSeen: now,
          lastSeen: now,
        });
      }

      patch.devices = devices;
      if (!user.deviceHwid) patch.deviceHwid = clientHwid;
    }

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, user.id))
      .returning();
    user = updated ?? user;

    if (user.twoFactorEnabled) {
      const preAuthToken = signJwt(
        { sub: user.id, purpose: PRE_AUTH_PURPOSE },
        config.jwtSecret,
        { expiresIn: '5m' },
      );
      return res.json({ requires2FA: true, userId: user.id, preAuthToken });
    }

    const { accessToken, refreshToken } = await issueSession(db, res, user);

    await logActivity(
      db,
      user.id,
      'login',
      'user',
      user.id,
      { username: user.username },
      req.ip,
    );

    return res.json({
      accessToken,
      refreshToken,
      user: publicUser(user),
    });
  }),
);

router.post(
  '/login/2fa',
  twoFactorLimiter,
  twoFactorUserLimiter,
  asyncHandler(async (req, res) => {
    const parsed = login2FASchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    type PreAuthPayload = { sub?: string; purpose?: string; iat?: number };
    let pending: PreAuthPayload | null = null;
    if (parsed.data.preAuthToken) {
      try {
        pending = jwt.verify(parsed.data.preAuthToken, config.jwtSecret, {
          algorithms: ['HS256'],
        }) as PreAuthPayload;
      } catch {
        return res.status(401).json({ error: 'Invalid or expired 2FA session' });
      }

      if (pending.purpose !== PRE_AUTH_PURPOSE || !pending.sub) {
        return res.status(401).json({ error: 'Invalid or expired 2FA session' });
      }

      if (parsed.data.userId && parsed.data.userId !== pending.sub) {
        return res.status(401).json({ error: 'Invalid or expired 2FA session' });
      }
    }

    const userId = pending?.sub ?? parsed.data.userId;
    if (!userId || !isValidId(userId)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const db = dbOf(req);
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!found) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (found.passwordChangedAt && pending?.iat) {
      if (pending.iat < Math.floor(found.passwordChangedAt.getTime() / 1000)) {
        return res.status(401).json({ error: 'Invalid or expired 2FA session' });
      }
    }

    if (found.banned) {
      return res.status(403).json({ error: 'Account has been suspended' });
    }
    if (!found.twoFactorEnabled || !found.twoFactorSecret) {
      return res.status(400).json({ error: '2FA not enabled' });
    }

    if (!verifyTwoFactorToken(found.twoFactorSecret, parsed.data.token)) {
      return res.status(401).json({ error: 'Invalid 2FA token' });
    }

    let user = await checkAndHandleSubscriptionExpiry(db, found, req.ip);
    const [updated] = await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    user = updated ?? user;

    const { accessToken, refreshToken } = await issueSession(db, res, user);

    await logActivity(
      db,
      user.id,
      'login',
      'user',
      user.id,
      { username: user.username, twoFactor: true },
      req.ip,
    );

    return res.json({
      accessToken,
      refreshToken,
      user: publicUser(user),
    });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const refreshToken =
      (req.cookies?.gestor_refresh_token as string | undefined) ||
      (req.body as any)?.refreshToken;

    if (
      !refreshToken ||
      typeof refreshToken !== 'string' ||
      refreshToken.length > 512
    ) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const db = dbOf(req);
    const presentedHash = hashRefreshToken(refreshToken);
    let stored = (
      await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, presentedHash))
        .limit(1)
    )[0];

    // Compatibilidad con tokens emitidos antes del hash.
    if (!stored && !refreshToken.startsWith('sha256:')) {
      const legacy = (
        await db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.token, refreshToken))
          .limit(1)
      )[0];

      if (legacy) {
        const [migrated] = await db
          .update(refreshTokens)
          .set({
            token: storedRefreshTokenValue(presentedHash),
            tokenHash: presentedHash,
          })
          .where(eq(refreshTokens.id, legacy.id))
          .returning();
        stored = migrated;
      }
    }

    if (!stored || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, stored.userId))
      .limit(1);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (user.banned) {
      return res.status(403).json({ error: 'Account has been suspended' });
    }

    // Rotación de un solo uso: el DELETE condicional dentro de la transacción
    // garantiza que dos peticiones concurrentes con el mismo token no emitan
    // dos sesiones válidas. La segunda recibe 401.
    const rotated = await db.transaction(async (tx) => {
      const [consumed] = await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.id, stored.id))
        .returning({ id: refreshTokens.id });

      if (!consumed) return null;

      const token = crypto.randomBytes(64).toString('hex');
      const tokenHash = hashRefreshToken(token);
      await tx.insert(refreshTokens).values({
        userId: user.id,
        token: storedRefreshTokenValue(tokenHash),
        tokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      return token;
    });

    if (!rotated) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    const newRefreshToken = rotated;

    const accessToken = signJwt(
      { userId: user.id, isAdmin: user.isAdmin },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn },
    );

    res.cookie('gestor_access_token', accessToken, {
      ...cookieBase,
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.cookie('gestor_refresh_token', newRefreshToken, {
      ...cookieBase,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ accessToken, refreshToken: newRefreshToken });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const refreshToken =
      (req.cookies?.gestor_refresh_token as string | undefined) ||
      (req.body as any)?.refreshToken;

    if (
      refreshToken &&
      typeof refreshToken === 'string' &&
      refreshToken.length <= 512
    ) {
      const db = dbOf(req);
      const presentedHash = hashRefreshToken(refreshToken);
      const conditions = [eq(refreshTokens.tokenHash, presentedHash)];
      if (!refreshToken.startsWith('sha256:')) {
        conditions.push(eq(refreshTokens.token, refreshToken));
      }
      await db.delete(refreshTokens).where(or(...conditions));
    }

    res.clearCookie('gestor_access_token', cookieBase);
    res.clearCookie('gestor_refresh_token', cookieBase);
    res.json({ message: 'Logged out' });
  }),
);

router.get(
  '/ticket',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);

    if (!found) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (found.banned) {
      return res.status(403).json({ error: 'Account has been suspended' });
    }

    const user = await checkAndHandleSubscriptionExpiry(db, found, req.ip);
    res.json({ user: publicUser(user) });
  }),
);

export default router;

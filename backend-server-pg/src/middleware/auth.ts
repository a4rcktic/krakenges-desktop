import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { apiKeys, users } from '../db/schema';
import type { UserRow } from '../db/schema';
import { dbOf } from '../db/context';
import { config } from '../config';
import { hashApiKey, storedApiKeyValue } from '../services/tokenHash';
import { checkAndHandleSubscriptionExpiry } from '../services/subscriptionService';

export type UserRole = 'owner' | 'admin' | 'seller' | 'user';

function roleOf(user: UserRow): UserRole {
  return (user.role as UserRole) || (user.isAdmin ? 'admin' : 'user');
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  const db = dbOf(req);
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  if (apiKeyHeader) {
    try {
      const presentedHash = hashApiKey(apiKeyHeader);
      let apiKey = (
        await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.keyHash, presentedHash), eq(apiKeys.isActive, true)))
          .limit(1)
      )[0];

      // Compatibilidad con claves creadas antes del hash. Solo se aceptan las
      // que tienen forma de clave (`gwt_...`), nunca el alias `sha256:<hash>`.
      if (!apiKey && !apiKeyHeader.startsWith('sha256:')) {
        const legacy = (
          await db
            .select()
            .from(apiKeys)
            .where(and(eq(apiKeys.key, apiKeyHeader), eq(apiKeys.isActive, true)))
            .limit(1)
        )[0];

        if (legacy) {
          await db
            .update(apiKeys)
            .set({ key: storedApiKeyValue(presentedHash), keyHash: presentedHash })
            .where(eq(apiKeys.id, legacy.id));
          apiKey = {
            ...legacy,
            key: storedApiKeyValue(presentedHash),
            keyHash: presentedHash,
          };
        }
      }

      if (!apiKey) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return res.status(401).json({ error: 'API key expired' });
      }

      const user = (
        await db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1)
      )[0];

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (user.banned) {
        return res.status(403).json({ error: 'Account has been suspended' });
      }

      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id));

      // Un plan caducado no debe conservar límites personalizados ni de pago
      // solo porque el cliente evite llamar a /membership/status.
      req.user = await checkAndHandleSubscriptionExpiry(db, user, req.ip);
      next();
      return;
    } catch {
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }

  const authHeader = req.headers.authorization;
  let accessToken = req.cookies?.gestor_access_token as string | undefined;

  if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
    accessToken = authHeader.slice('Bearer '.length);
  }

  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(accessToken, config.jwtSecret, {
      algorithms: ['HS256'],
    }) as {
      userId?: string;
      isAdmin?: boolean;
      iat?: number;
      purpose?: string;
    };

    // Los tokens con `purpose` (por ejemplo el pre-2FA) no son de acceso.
    if (payload.purpose || !payload.userId) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = (
      await db.select().from(users).where(eq(users.id, payload.userId)).limit(1)
    )[0];

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (user.banned) {
      return res.status(403).json({ error: 'Account has been suspended' });
    }

    // Un access token emitido antes del último cambio de contraseña ya no vale.
    if (user.passwordChangedAt && payload.iat) {
      const changedAt = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (payload.iat < changedAt) {
        return res.status(401).json({ error: 'Session expired' });
      }
    }

    req.user = await checkAndHandleSubscriptionExpiry(db, user, req.ip);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export const requireRole = (allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autenticación requerida' });
    }

    const currentRole = roleOf(req.user);
    if (!allowedRoles.includes(currentRole)) {
      return res.status(403).json({
        error: `Acceso restringido. Se requiere rol [${allowedRoles.join(', ')}]. Tu rol actual es: ${currentRole}`,
      });
    }
    next();
  };
};

export const requireOwner = requireRole(['owner']);
export const requireAdmin = requireRole(['owner', 'admin']);
export const requireSeller = requireRole(['owner', 'admin', 'seller']);

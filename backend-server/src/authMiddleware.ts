import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User, { UserRole } from './models/User';
import ApiKey, { hashApiKey, storedApiKeyValue, type IApiKey } from './models/ApiKey';
import { config } from './config';

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  if (apiKeyHeader) {
    try {
      const presentedHash = hashApiKey(apiKeyHeader);
      let apiKey = (await ApiKey.findOne({ keyHash: presentedHash, isActive: true })) as IApiKey | null;

      // Compatibilidad con claves creadas antes del hash. Solo se aceptan las
      // que tienen forma de clave (`kgs_...`), nunca el valor `sha256:<hash>`
      // que se guarda en el campo legacy de las claves nuevas.
      if (!apiKey && !apiKeyHeader.startsWith('sha256:')) {
        const legacy = await ApiKey.findOne({ key: apiKeyHeader, isActive: true }).select('+key +keyHash');
        if (legacy) {
          apiKey = legacy as unknown as IApiKey;
          apiKey.key = storedApiKeyValue(presentedHash);
          apiKey.keyHash = presentedHash;
          await apiKey.save();
        }
      }

      if (!apiKey) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return res.status(401).json({ error: 'API key expired' });
      }

      const user = await User.findById(apiKey.userId).select('-passwordHash');
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      if (user.banned) {
        return res.status(403).json({ error: 'Account has been suspended' });
      }

      apiKey.lastUsedAt = new Date();
      await apiKey.save();

      req.user = user;
      next();
      return;
    } catch {
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }

  const authHeader = req.headers.authorization;
  let accessToken = req.cookies?.gestor_access_token;

  if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
    accessToken = authHeader.split(' ')[1];
  }

  if (!accessToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(accessToken, config.jwtSecret) as {
      userId: string;
      isAdmin: boolean;
      iat?: number;
      purpose?: string;
    };
    // Los tokens con `purpose` (p. ej. el pre-2FA) no son de acceso.
    if (payload.purpose || !payload.userId) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const user = await User.findById(payload.userId).select('-passwordHash');
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (user.banned) {
      return res.status(403).json({ error: 'Account has been suspended' });
    }

    // Un access token emitido antes del último cambio de contraseña ya no vale.
    // Sin esto, revocar los refresh tokens dejaba viva la sesión hasta 12 h.
    if (user.passwordChangedAt && payload.iat) {
      const changedAt = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (payload.iat < changedAt) {
        return res.status(401).json({ error: 'Session expired' });
      }
    }

    req.user = user;
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

    const currentRole = req.user.role || (req.user.isAdmin ? 'admin' : 'user');
    if (!allowedRoles.includes(currentRole as UserRole)) {
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

import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { apiKeys, users } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import { getEffectiveLimits, getEffectivePlanName } from '../config/plans';
import { logActivity } from '../services/activityLog';
import { asyncHandler } from '../utils/asyncHandler';
import { generateApiKey, storedApiKeyValue } from '../services/tokenHash';
import { isValidId } from '../services/profileService';
import { omitNullish } from '../utils/omitNullish';

const router = Router();

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'expiresAt debe ser una fecha ISO válida')
    .optional(),
});

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const keys = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, req.user!.id))
      .orderBy(desc(apiKeys.createdAt));

    res.json(
      keys.map((k) =>
        omitNullish(
          {
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            isActive: k.isActive,
            lastUsedAt: k.lastUsedAt,
            expiresAt: k.expiresAt,
            createdAt: k.createdAt,
          },
          ['lastUsedAt', 'expiresAt'],
        ),
      ),
    );
  }),
);

router.post(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const { key, prefix, keyHash } = generateApiKey();
    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, req.user!.id))
        .limit(1)
        .for('update');
      if (!user) return { ok: false as const, status: 404, error: 'User not found' };

      const limits = getEffectiveLimits(user);
      const planName = getEffectivePlanName(user);

      if (limits.maxApiKeys === 0) {
        return {
          ok: false as const,
          status: 403,
          error: `Tu plan ${planName} no incluye acceso a API Keys. Actualiza tu plan.`,
          code: 'PLAN_LIMIT_REACHED',
          limit: 0,
        };
      }

      if (limits.maxApiKeys !== -1) {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(and(eq(apiKeys.userId, req.user!.id), eq(apiKeys.isActive, true)));
        const activeKeysCount = row?.count ?? 0;

        if (activeKeysCount >= limits.maxApiKeys) {
          return {
            ok: false as const,
            status: 403,
            error: `Límite de API Keys activas alcanzado (${limits.maxApiKeys}) para tu plan ${planName}.`,
            code: 'PLAN_LIMIT_REACHED',
            limit: limits.maxApiKeys,
            current: activeKeysCount,
          };
        }
      }

      const [created] = await tx
        .insert(apiKeys)
        .values({
          userId: req.user!.id,
          name: parsed.data.name.trim(),
          key: storedApiKeyValue(keyHash),
          keyHash,
          prefix,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
          isActive: true,
        })
        .returning();

      return { ok: true as const, created };
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.limit !== undefined ? { limit: result.limit } : {}),
        ...(result.current !== undefined ? { current: result.current } : {}),
      });
    }
    const created = result.created;

    await logActivity(
      db,
      req.user!.id,
      'create',
      'api_key',
      created.id,
      { name: created.name },
      req.ip,
    );

    res.status(201).json(
      omitNullish(
        {
          id: created.id,
          name: created.name,
          key,
          prefix: created.prefix,
          isActive: created.isActive,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
        },
        ['expiresAt'],
      ),
    );
  }),
);

router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de API key inválido' });
    }

    const db = dbOf(req);
    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, req.user!.id)))
      .limit(1);
    if (!apiKey) return res.status(404).json({ error: 'API key not found' });

    await db.delete(apiKeys).where(eq(apiKeys.id, apiKey.id));
    await logActivity(
      db,
      req.user!.id,
      'delete',
      'api_key',
      apiKey.id,
      { name: apiKey.name },
      req.ip,
    );

    res.json({ message: 'API key eliminada' });
  }),
);

router.patch(
  '/:id/toggle',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identificador de API key inválido' });
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

      const [apiKey] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, req.user!.id)))
        .limit(1)
        .for('update');
      if (!apiKey) return { ok: false as const, status: 404, error: 'API key not found' };

      // Reactivar una clave también consume cuota. Sin esto se podían crear
      // claves inactivas de más y luego activarlas todas.
      if (!apiKey.isActive) {
        const limits = getEffectiveLimits(user);
        if (limits.maxApiKeys !== -1) {
          const [row] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(apiKeys)
            .where(and(eq(apiKeys.userId, req.user!.id), eq(apiKeys.isActive, true)));
          const activeKeysCount = row?.count ?? 0;
          if (activeKeysCount >= limits.maxApiKeys) {
            return {
              ok: false as const,
              status: 403,
              error: `Límite de API Keys activas alcanzado (${limits.maxApiKeys}) para tu plan ${getEffectivePlanName(user)}.`,
              code: 'PLAN_LIMIT_REACHED',
              limit: limits.maxApiKeys,
              current: activeKeysCount,
            };
          }
        }
      }

      const [updated] = await tx
        .update(apiKeys)
        .set({ isActive: !apiKey.isActive })
        .where(eq(apiKeys.id, apiKey.id))
        .returning();

      return { ok: true as const, updated };
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.limit !== undefined ? { limit: result.limit } : {}),
        ...(result.current !== undefined ? { current: result.current } : {}),
      });
    }

    res.json({ id: result.updated.id, isActive: result.updated.isActive });
  }),
);

export default router;

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { and, desc, eq, gte, ilike, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { licenseKeys, users } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate, requireSeller } from '../middleware/auth';
import { normalizePlan } from '../config/plans';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../errors';
import { isValidId } from '../services/profileService';
import { omitNullish } from '../utils/omitNullish';

const router = Router();

const limitField = z.number().int().min(-1).max(1_000_000).optional();

const createKeySchema = z
  .object({
    plan: z.enum(['ghost', 'shadow', 'specter', 'phantom', 'pro', 'enterprise']).default('shadow'),
    // -1 = vitalicia; 0.2083 = 5 horas; >= 1 = días. Se puede usar
    // `durationHours` para escribir 1 hora de forma legible.
    durationDays: z.number().min(-1).max(36_500).optional(),
    durationHours: z.number().min(-1).max(876_000).optional(),
    role: z.enum(['user', 'seller', 'admin']).default('user'),
    count: z.number().int().min(1).max(100).default(1),
    tag: z.string().max(100).optional(),
    // Entitlements personalizados. Si no se envían, la clave usa el plan base.
    customPlanName: z.string().trim().min(1).max(80).optional(),
    maxProfiles: limitField,
    maxSessions: limitField,
    maxApiKeys: limitField,
    expiresAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), 'expiresAt debe ser una fecha ISO válida')
      .optional(),
  })
  .refine(
    (data) => data.durationDays === undefined || data.durationHours === undefined,
    { message: 'Usa durationDays o durationHours, no ambos' },
  );

const patchKeySchema = z.object({
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  isActive: z.boolean().optional(),
  tag: z.string().max(100).optional(),
  customPlanName: z.string().trim().min(1).max(80).nullable().optional(),
  maxProfiles: z.number().int().min(-1).max(1_000_000).nullable().optional(),
  maxSessions: z.number().int().min(-1).max(1_000_000).nullable().optional(),
  maxApiKeys: z.number().int().min(-1).max(1_000_000).nullable().optional(),
});

function resolveDurationDays(data: {
  durationDays?: number;
  durationHours?: number;
}): number {
  if (data.durationHours !== undefined) {
    return data.durationHours === -1 ? -1 : data.durationHours / 24;
  }
  return data.durationDays ?? 30;
}

function generateMaskKey(planCode: string): string {
  const prefix = `MSK-${planCode.toUpperCase().slice(0, 4)}`;
  const p1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${p1}-${p2}`;
}

function serializePopulatedUser<T extends object>(user: T): T {
  return omitNullish({ ...user }, ['email']);
}

function serializeLicenseKey<T extends object>(key: T): T {
  return omitNullish(
    { ...key },
    ['createdBy', 'redeemedBy', 'redeemedAt', 'tag', 'expiresAt'],
  );
}

class InsufficientCreditsError extends Error {
  constructor(
    public current: number,
    public requested: number,
  ) {
    super('Créditos de revendedor insuficientes');
    this.name = 'InsufficientCreditsError';
  }
}

router.get(
  '/',
  authenticate,
  requireSeller,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const { status, plan, tag, search, sellerId } = req.query;
    const conditions = [];

    const isSeller = req.user!.role === 'seller';

    // Un seller solo ve las claves que generó él.
    if (isSeller) {
      conditions.push(eq(licenseKeys.createdBy, req.user!.id));
    } else if (sellerId && typeof sellerId === 'string') {
      if (!isValidId(sellerId)) {
        return res.status(400).json({ error: 'sellerId inválido' });
      }
      conditions.push(eq(licenseKeys.createdBy, sellerId));
    }

    if (status && typeof status === 'string') {
      conditions.push(eq(licenseKeys.status, status));
    }
    if (plan && typeof plan === 'string') {
      conditions.push(eq(licenseKeys.plan, normalizePlan(plan)));
    }
    if (tag && typeof tag === 'string') {
      conditions.push(ilike(licenseKeys.tag, `%${tag}%`));
    }
    if (search && typeof search === 'string') {
      conditions.push(ilike(licenseKeys.key, `%${search.trim()}%`));
    }

    const creator = alias(users, 'creator');
    const redeemer = alias(users, 'redeemer');

    const rows = await db
      .select({
        key: licenseKeys,
        creator: {
          id: creator.id,
          name: creator.name,
          username: creator.username,
          email: creator.email,
          role: creator.role,
        },
        redeemer: {
          id: redeemer.id,
          name: redeemer.name,
          username: redeemer.username,
          email: redeemer.email,
        },
      })
      .from(licenseKeys)
      .leftJoin(creator, eq(licenseKeys.createdBy, creator.id))
      .leftJoin(redeemer, eq(licenseKeys.redeemedBy, redeemer.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(licenseKeys.createdAt))
      .limit(200);

    res.json(
      rows.map(({ key, creator: createdBy, redeemer: redeemedBy }) =>
        serializeLicenseKey({
          ...key,
          createdBy: createdBy?.id ? serializePopulatedUser(createdBy) : null,
          redeemedBy: redeemedBy?.id ? serializePopulatedUser(redeemedBy) : null,
        }),
      ),
    );
  }),
);

router.post(
  '/',
  authenticate,
  requireSeller,
  asyncHandler(async (req, res) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const normalizedPlan = normalizePlan(parsed.data.plan);
    const count = parsed.data.count || 1;
    const durationDays = resolveDurationDays(parsed.data);
    const db = dbOf(req);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isSeller = user.role === 'seller';

    if (isSeller && (parsed.data.role === 'admin' || parsed.data.role === 'seller')) {
      return res
        .status(403)
        .json({ error: 'Los revendedores solo pueden generar claves con rol de usuario cliente.' });
    }

    // Los límites y el nombre personalizados son una herramienta del operador.
    // Un revendedor ya puede elegir el plan base; permitirle sobrescribir sus
    // límites convertiría cualquier clave barata en un plan ilimitado.
    if (
      isSeller &&
      (parsed.data.customPlanName !== undefined ||
        parsed.data.maxProfiles !== undefined ||
        parsed.data.maxSessions !== undefined ||
        parsed.data.maxApiKeys !== undefined)
    ) {
      return res.status(403).json({
        error: 'Los revendedores no pueden definir límites ni nombres de plan personalizados.',
      });
    }

    const keysToCreate = Array.from({ length: count }, () => ({
      key: generateMaskKey(normalizedPlan),
      plan: normalizedPlan,
      customPlanName: parsed.data.customPlanName ?? null,
      maxProfiles: parsed.data.maxProfiles ?? null,
      maxSessions: parsed.data.maxSessions ?? null,
      maxApiKeys: parsed.data.maxApiKeys ?? null,
      durationDays,
      role: isSeller ? 'user' : parsed.data.role,
      status: 'active',
      isActive: true,
      tag:
        parsed.data.tag ||
        (isSeller ? `Seller: ${user.username || user.name}` : null),
      createdBy: req.user!.id,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    }));

    let result: { created: (typeof licenseKeys.$inferSelect)[]; remaining?: number };
    try {
      result = await db.transaction(async (tx) => {
        let remaining: number | undefined;

        if (isSeller) {
          const [debited] = await tx
            .update(users)
            .set({
              sellerCredits: sql`${users.sellerCredits} - ${count}`,
              updatedAt: new Date(),
            })
            .where(and(eq(users.id, user.id), gte(users.sellerCredits, count)))
            .returning();

          if (!debited) {
            const [fresh] = await tx
              .select({ credits: users.sellerCredits })
              .from(users)
              .where(eq(users.id, user.id))
              .limit(1);
            throw new InsufficientCreditsError(fresh?.credits ?? 0, count);
          }
          remaining = debited.sellerCredits ?? 0;
        }

        const created = await tx.insert(licenseKeys).values(keysToCreate).returning();
        return { created, remaining };
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(403).json({
          error: `Créditos de revendedor insuficientes. Tienes ${err.current} créditos y solicitaste generar ${err.requested} clave(s). Contacta al Owner para recargar.`,
          currentCredits: err.current,
          requestedCount: err.requested,
        });
      }
      if (err instanceof HttpError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      throw err;
    }

    res.status(201).json({
      count: result.created.length,
      remainingSellerCredits: result.remaining,
      keys: result.created.map(serializeLicenseKey),
    });
  }),
);

router.patch(
  '/:id',
  authenticate,
  requireSeller,
  asyncHandler(async (req, res) => {
    const parsed = patchKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'Identificador de clave inválido' });
    }

    const db = dbOf(req);
    const [key] = await db
      .select()
      .from(licenseKeys)
      .where(eq(licenseKeys.id, id))
      .limit(1);
    if (!key) return res.status(404).json({ error: 'Clave no encontrada' });

    if (req.user!.role === 'seller' && (!key.createdBy || key.createdBy !== req.user!.id)) {
      return res
        .status(403)
        .json({ error: 'No tienes permiso para modificar una clave creada por otro usuario.' });
    }

    // Una clave canjeada es un estado final.
    const changesStatus = parsed.data.status !== undefined || parsed.data.isActive !== undefined;
    const changesEntitlements =
      parsed.data.customPlanName !== undefined ||
      parsed.data.maxProfiles !== undefined ||
      parsed.data.maxSessions !== undefined ||
      parsed.data.maxApiKeys !== undefined;
    if (req.user!.role === 'seller' && changesEntitlements) {
      return res.status(403).json({
        error: 'Los revendedores no pueden definir límites ni nombres de plan personalizados.',
      });
    }
    if (key.status === 'redeemed' && (changesStatus || changesEntitlements)) {
      return res
        .status(409)
        .json({ error: 'La clave ya fue canjeada y sus condiciones no se pueden cambiar.' });
    }

    const patch: Partial<typeof licenseKeys.$inferInsert> = {};
    if (parsed.data.status) {
      patch.status = parsed.data.status;
      patch.isActive = parsed.data.status === 'active';
    } else if (parsed.data.isActive !== undefined) {
      patch.isActive = parsed.data.isActive;
      patch.status = parsed.data.isActive ? 'active' : 'revoked';
    }
    if (parsed.data.tag !== undefined) patch.tag = parsed.data.tag;
    if (parsed.data.customPlanName !== undefined) {
      patch.customPlanName = parsed.data.customPlanName;
    }
    if (parsed.data.maxProfiles !== undefined) patch.maxProfiles = parsed.data.maxProfiles;
    if (parsed.data.maxSessions !== undefined) patch.maxSessions = parsed.data.maxSessions;
    if (parsed.data.maxApiKeys !== undefined) patch.maxApiKeys = parsed.data.maxApiKeys;

    const [updated] = await db
      .update(licenseKeys)
      .set(patch)
      .where(eq(licenseKeys.id, key.id))
      .returning();

    res.json(serializeLicenseKey(updated));
  }),
);

router.delete(
  '/:id',
  authenticate,
  requireSeller,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ error: 'Identificador de clave inválido' });
    }

    const db = dbOf(req);
    const [key] = await db
      .select()
      .from(licenseKeys)
      .where(eq(licenseKeys.id, id))
      .limit(1);
    if (!key) return res.status(404).json({ error: 'Clave no encontrada' });

    const isOwnerOrAdmin = req.user!.role === 'owner' || req.user!.role === 'admin';
    if (!isOwnerOrAdmin) {
      if (!key.createdBy || key.createdBy !== req.user!.id) {
        return res
          .status(403)
          .json({ error: 'No tienes permiso para eliminar una clave creada por otro usuario.' });
      }
      if (key.status === 'redeemed') {
        return res.status(400).json({
          error: 'Los revendedores no pueden eliminar una clave que ya ha sido canjeada',
        });
      }
    }

    await db.delete(licenseKeys).where(eq(licenseKeys.id, key.id));
    res.json({ success: true, message: 'Clave eliminada permanentemente de la base de datos' });
  }),
);

export default router;

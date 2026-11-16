import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import crypto from 'crypto';
import LicenseKey from '../models/LicenseKey';
import User from '../models/User';
import { authenticate, requireSeller } from '../authMiddleware';
import { normalizePlan } from '../config/plans';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const createKeySchema = z.object({
  plan: z.enum(['ghost', 'shadow', 'specter', 'phantom', 'pro', 'enterprise']).default('shadow'),
  durationDays: z.number().min(-1).default(30), // -1 for lifetime, 0.2083 for 5 hours, or >= 1 days
  role: z.enum(['user', 'seller', 'admin']).default('user'),
  count: z.number().int().min(1).max(100).default(1),
  tag: z.string().max(100).optional(),
  expiresAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'expiresAt debe ser una fecha ISO válida')
    .optional(),
});

const patchKeySchema = z.object({
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  isActive: z.boolean().optional(),
  tag: z.string().max(100).optional(),
});

function generateMaskKey(planCode: string): string {
  const prefix = `MSK-${planCode.toUpperCase().slice(0, 4)}`;
  const p1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${p1}-${p2}`;
}

router.get('/', authenticate, requireSeller, asyncHandler(async (req, res) => {
  const { status, plan, tag, search, sellerId } = req.query;
  const filter: Record<string, unknown> = {};

  const isSeller = req.user!.role === 'seller';

  // Sellers can ONLY see keys they generated themselves
  if (isSeller) {
    filter.createdBy = req.user!._id;
  } else if (sellerId && typeof sellerId === 'string') {
    filter.createdBy = sellerId;
  }

  if (status && typeof status === 'string') {
    filter.status = status;
  }
  if (plan && typeof plan === 'string') {
    filter.plan = normalizePlan(plan);
  }
  if (tag && typeof tag === 'string') {
    const escapedTag = tag.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    filter.tag = { $regex: escapedTag, $options: 'i' };
  }
  if (search && typeof search === 'string') {
    const escapedSearch = search.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    filter.key = { $regex: escapedSearch, $options: 'i' };
  }

  const keys = await LicenseKey.find(filter)
    .populate('createdBy', 'name username email role')
    .populate('redeemedBy', 'name username email')
    .sort({ createdAt: -1 })
    .limit(200);

  res.json(keys);
}));

router.post('/', authenticate, requireSeller, asyncHandler(async (req, res) => {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const normalizedPlan = normalizePlan(parsed.data.plan);
  const count = parsed.data.count || 1;
  const user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  const isSeller = user.role === 'seller';

  let remainingSellerCredits: number | undefined;

  // Specific restrictions for Sellers
  if (isSeller) {
    if (parsed.data.role === 'admin' || parsed.data.role === 'seller') {
      return res.status(403).json({ error: 'Los revendedores solo pueden generar claves con rol de usuario cliente.' });
    }

    // Descuento atómico: antes se leía el saldo, se comparaba y se guardaba
    // en tres pasos, y dos peticiones simultáneas gastaban el mismo crédito.
    const debited = await User.findOneAndUpdate(
      { _id: user._id, sellerCredits: { $gte: count } },
      { $inc: { sellerCredits: -count } },
      { new: true },
    );
    if (!debited) {
      const credits = user.sellerCredits ?? 0;
      return res.status(403).json({
        error: `Créditos de revendedor insuficientes. Tienes ${credits} créditos y solicitaste generar ${count} clave(s). Contacta al Owner para recargar.`,
        currentCredits: credits,
        requestedCount: count,
      });
    }
    remainingSellerCredits = debited.sellerCredits ?? 0;
  }

  const keysToCreate = [];

  for (let i = 0; i < count; i++) {
    keysToCreate.push({
      key: generateMaskKey(normalizedPlan),
      plan: normalizedPlan,
      durationDays: parsed.data.durationDays,
      role: isSeller ? 'user' : parsed.data.role,
      status: 'active',
      isActive: true,
      tag: parsed.data.tag || (isSeller ? `Seller: ${user.username || user.name}` : undefined),
      createdBy: req.user!._id,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
    });
  }

  let createdKeys;
  try {
    createdKeys = await LicenseKey.insertMany(keysToCreate);
  } catch (err) {
    // Si no se crearon las claves, el seller recupera lo que se le cobró.
    if (isSeller) {
      await User.updateOne({ _id: user._id }, { $inc: { sellerCredits: count } });
    }
    throw err;
  }

  res.status(201).json({
    count: createdKeys.length,
    remainingSellerCredits,
    keys: createdKeys,
  });
}));

router.patch('/:id', authenticate, requireSeller, asyncHandler(async (req, res) => {
  const parsed = patchKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  // Sin esta comprobación, un id mal formado acababa en un CastError de
  // Mongoose y en un 500: culpa al servidor de una petición del cliente.
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Identificador de clave inválido' });
  }

  const key = await LicenseKey.findById(id);
  if (!key) {
    return res.status(404).json({ error: 'Clave no encontrada' });
  }

  // Si es seller, la clave tiene que tener dueño y ser suyo. Antes bastaba con
  // que `createdBy` fuera null para saltarse la comprobación y tocar cualquier
  // clave huérfana del sistema.
  if (
    req.user!.role === 'seller' &&
    (!key.createdBy || !key.createdBy.equals(req.user!._id))
  ) {
    return res.status(403).json({ error: 'No tienes permiso para modificar una clave creada por otro usuario.' });
  }

  // Una clave canjeada es un estado final. Antes se podía devolver a 'active'
  // y volver a canjearla: un seller convertía un solo crédito en cuentas
  // ilimitadas. Para cortar el acceso a quien la canjeó está el baneo.
  const changesStatus = parsed.data.status !== undefined || parsed.data.isActive !== undefined;
  if (key.status === 'redeemed' && changesStatus) {
    return res.status(409).json({ error: 'La clave ya fue canjeada y su estado no se puede cambiar.' });
  }

  if (parsed.data.status) {
    key.status = parsed.data.status;
    key.isActive = parsed.data.status === 'active';
  } else if (parsed.data.isActive !== undefined) {
    key.isActive = parsed.data.isActive;
    key.status = parsed.data.isActive ? 'active' : 'revoked';
  }

  if (parsed.data.tag !== undefined) {
    key.tag = parsed.data.tag;
  }

  await key.save();
  res.json(key);
}));

router.delete('/:id', authenticate, requireSeller, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Identificador de clave inválido' });
  }
  const key = await LicenseKey.findById(id);
  if (!key) {
    return res.status(404).json({ error: 'Clave no encontrada' });
  }

  const isOwnerOrAdmin = req.user!.role === 'owner' || req.user!.role === 'admin';

  // Si no es owner/admin, la clave tiene que tener dueño y ser suyo.
  if (!isOwnerOrAdmin) {
    if (!key.createdBy || !key.createdBy.equals(req.user!._id)) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar una clave creada por otro usuario.' });
    }
    if (key.status === 'redeemed') {
      return res.status(400).json({ error: 'Los revendedores no pueden eliminar una clave que ya ha sido canjeada' });
    }
  }

  await key.deleteOne();
  res.json({ success: true, message: 'Clave eliminada permanentemente de la base de datos' });
}));

export default router;

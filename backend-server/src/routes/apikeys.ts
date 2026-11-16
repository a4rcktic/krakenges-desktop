import { Router } from 'express';
import { z } from 'zod';
import { Model } from 'mongoose';
import ApiKey, { IApiKey, storedApiKeyValue } from '../models/ApiKey';
import User from '../models/User';
import { getPlanLimits } from '../config/plans';
import { checkAndHandleSubscriptionExpiry } from '../services/subscriptionService';

type ApiKeyModelWithStatic = Model<IApiKey> & {
  generateKey: () => { key: string; prefix: string; keyHash: string };
};

const ApiKeyModel = ApiKey as ApiKeyModelWithStatic;
import { authenticate } from '../authMiddleware';
import { logActivity } from '../services/activityLog';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().optional(),
});

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const keys = await ApiKey.find({ userId: req.user!._id }).sort({ createdAt: -1 });
  res.json(keys.map((k) => ({
    id: k._id,
    name: k.name,
    prefix: k.prefix,
    isActive: k.isActive,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    createdAt: k.createdAt,
  })));
}));

router.post('/', authenticate, asyncHandler(async (req, res) => {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  let user = await User.findById(req.user!._id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  user = await checkAndHandleSubscriptionExpiry(user, req.ip);
  const limits = getPlanLimits(user.plan);

  if (limits.maxApiKeys === 0) {
    return res.status(403).json({
      error: `Tu plan ${user.plan} no incluye acceso a API Keys. Actualiza tu plan a Shadow o superior.`,
      code: 'PLAN_LIMIT_REACHED',
      limit: 0,
    });
  }

  if (limits.maxApiKeys !== -1) {
    const activeKeysCount = await ApiKey.countDocuments({ userId: req.user!._id, isActive: true });
    if (activeKeysCount >= limits.maxApiKeys) {
      return res.status(403).json({
        error: `Límite de API Keys activas alcanzado (${limits.maxApiKeys}) para tu plan ${user.plan}.`,
        code: 'PLAN_LIMIT_REACHED',
        limit: limits.maxApiKeys,
        current: activeKeysCount,
      });
    }
  }

  const { key, prefix, keyHash } = ApiKeyModel.generateKey();

  const apiKey = await ApiKey.create({
    userId: req.user!._id,
    name: parsed.data.name.trim(),
    // `key` queda como alias único del hash; la clave en claro solo se envía
    // una vez en la respuesta y nunca se persiste.
    key: storedApiKeyValue(keyHash),
    keyHash,
    prefix,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
    isActive: true,
  });

  await logActivity(req.user!._id, 'create', 'api_key', apiKey._id.toString(), { name: apiKey.name }, req.ip);

  res.status(201).json({
    id: apiKey._id,
    name: apiKey.name,
    key,
    prefix: apiKey.prefix,
    isActive: apiKey.isActive,
    expiresAt: apiKey.expiresAt,
    createdAt: apiKey.createdAt,
  });
}));

router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  const apiKey = await ApiKey.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!apiKey) {
    return res.status(404).json({ error: 'API key not found' });
  }

  await ApiKey.findByIdAndDelete(apiKey._id);
  await logActivity(req.user!._id, 'delete', 'api_key', apiKey._id.toString(), { name: apiKey.name }, req.ip);

  res.json({ message: 'API key eliminada' });
}));

router.patch('/:id/toggle', authenticate, asyncHandler(async (req, res) => {
  const apiKey = await ApiKey.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!apiKey) {
    return res.status(404).json({ error: 'API key not found' });
  }

  apiKey.isActive = !apiKey.isActive;
  await apiKey.save();

  res.json({ id: apiKey._id, isActive: apiKey.isActive });
}));

export default router;

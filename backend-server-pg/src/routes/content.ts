import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PLAN_CONFIGS } from '../config/plans';
import {
  loadPublicContent,
  previewPublicContent,
  savePublicContent,
  listContentHistory,
  revertPublicContent,
  type PublicContent,
} from '../config/publicContent';
import { authenticate, requireAdmin } from '../middleware/auth';
import { dbOf } from '../db/context';
import { logActivity } from '../services/activityLog';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const contentWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas publicaciones. Espera unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function publicPayload(content: PublicContent) {
  const plans = Object.fromEntries(
    Object.entries(PLAN_CONFIGS).map(([id, plan]) => [
      id,
      {
        ...plan,
        ...(content.plans[id] ?? {}),
        id: plan.id,
        limits: plan.limits,
      },
    ]),
  );

  return { ...content, plans };
}

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
  res.json(publicPayload(loadPublicContent()));
});

router.get(
  '/admin',
  authenticate,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: loadPublicContent() });
  }),
);

router.post(
  '/preview',
  authenticate,
  requireAdmin,
  contentWriteLimiter,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: previewPublicContent(req.body) });
  }),
);

router.put(
  '/',
  authenticate,
  requireAdmin,
  contentWriteLimiter,
  asyncHandler(async (req, res) => {
    const saved = await savePublicContent(req.body);
    await logActivity(
      dbOf(req),
      req.user!.id,
      'publish_content',
      'content',
      String(saved.version),
      { version: saved.version },
      req.ip,
    );
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: saved });
  }),
);

router.get(
  '/history',
  authenticate,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const items = await listContentHistory();
    res.set('Cache-Control', 'private, no-store');
    res.json({ items });
  }),
);

router.post(
  '/revert',
  authenticate,
  requireAdmin,
  contentWriteLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.body?.id ?? '');
    const restored = await revertPublicContent(id);
    await logActivity(
      dbOf(req),
      req.user!.id,
      'revert_content',
      'content',
      String(restored.version),
      { version: restored.version, from: id },
      req.ip,
    );
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: restored });
  }),
);

export default router;

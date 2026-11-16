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
import { authenticate, requireAdmin } from '../authMiddleware';
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

/**
 * Vista pública: el archivo puede cambiar el precio o el texto, nunca los
 * límites ni el id que usa el backend para autorizar. Los límites efectivos
 * siguen saliendo de `PLAN_CONFIGS`.
 */
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
    ])
  );

  return { ...content, plans };
}

/**
 * Contenido público y versionado para la app.
 *
 * No requiere autenticación: solo devuelve datos que ya se muestran en la
 * interfaz (precios, textos y tema).
 */
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
  res.json(publicPayload(loadPublicContent()));
});

/** Contenido editable actual, solo para owner/admin. */
router.get(
  '/admin',
  authenticate,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: loadPublicContent() });
  })
);

/** Valida y devuelve el contenido resultante sin publicarlo. */
router.post(
  '/preview',
  authenticate,
  requireAdmin,
  contentWriteLimiter,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: previewPublicContent(req.body) });
  })
);

/** Publica contenido nuevo y archiva la versión anterior. */
router.put(
  '/',
  authenticate,
  requireAdmin,
  contentWriteLimiter,
  asyncHandler(async (req, res) => {
    const saved = await savePublicContent(req.body);
    await logActivity(
      req.user!._id,
      'publish_content',
      'content',
      String(saved.version),
      { version: saved.version },
      req.ip
    );
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: saved });
  })
);

/** Historial de versiones publicadas. */
router.get(
  '/history',
  authenticate,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const items = await listContentHistory();
    res.set('Cache-Control', 'private, no-store');
    res.json({ items });
  })
);

/** Restaura una versión del historial como publicación nueva. */
router.post(
  '/revert',
  authenticate,
  requireAdmin,
  contentWriteLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.body?.id ?? '');
    const restored = await revertPublicContent(id);
    await logActivity(
      req.user!._id,
      'revert_content',
      'content',
      String(restored.version),
      { version: restored.version, from: id },
      req.ip
    );
    res.set('Cache-Control', 'private, no-store');
    res.json({ content: restored });
  })
);

export default router;

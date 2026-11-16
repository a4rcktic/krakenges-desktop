import { Router } from 'express';
import { z } from 'zod';
import { and, arrayContains, desc, eq, ilike, sql } from 'drizzle-orm';
import { browserStates, profiles } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import { validateProxy } from '../services/proxyValidator';
import { computeFingerprint } from '../services/fingerprintService';
import { logActivity } from '../services/activityLog';
import { encryptProxy, decryptProxy } from '../services/proxyCipher';
import { asyncHandler } from '../utils/asyncHandler';
import { rawRows } from '../db/raw';
import {
  createProfile,
  createProfilesBulk,
  serializeProfile,
  isValidId,
  loadOwnedProfile,
  cloneProfile,
  type CreateResult,
} from '../services/profileService';

const router = Router();

function sendCreateError(res: import('express').Response, result: Extract<CreateResult, { ok: false }>, requested?: number) {
  return res.status(result.status).json({
    error: result.error,
    ...(result.code ? { code: result.code } : {}),
    ...(result.limit !== undefined ? { limit: result.limit } : {}),
    ...(result.current !== undefined ? { current: result.current } : {}),
    ...(requested !== undefined ? { requested } : {}),
  });
}

// El servidor NO guarda proxys: cada usuario los mantiene solo en su máquina.
// Este middleware los descarta en cualquier request a /api/profiles.
router.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object' && 'proxy' in req.body) {
    delete req.body.proxy;
  }
  next();
});

const requireUuid =
  (param = 'id') =>
  (req: any, res: any, next: any) => {
    const value = req.params?.[param];
    if (!isValidId(String(value ?? ''))) {
      return res.status(400).json({
        error: `El identificador "${value}" no tiene un formato válido.`,
      });
    }
    next();
  };

const osField = z.enum(['windows', 'macos', 'linux', 'android', 'ios']);

const createProfileSchema = z.object({
  name: z.string().min(1).max(100),
  proxy: z.string().max(500).optional(),
  startUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  os: osField.optional(),
});

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  proxy: z.string().max(500).optional(),
  startUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  os: osField.optional(),
});

const bulkCreateSchema = z.object({
  profiles: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        proxy: z.string().max(500).optional(),
        startUrl: z.string().url().optional(),
        tags: z.array(z.string()).optional(),
        os: osField.optional(),
      }),
    )
    .min(1)
    .max(100),
});

const importSchema = z.object({
  profiles: z
    .array(
      z.object({
        name: z.string().min(1),
        proxy: z.string().optional(),
        startUrl: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const { tag, search } = req.query;
    const conditions = [eq(profiles.userId, req.user!.id)];

    if (tag && typeof tag === 'string') {
      conditions.push(arrayContains(profiles.tags, [tag]));
    }
    if (search && typeof search === 'string') {
      conditions.push(ilike(profiles.name, `%${search.trim()}%`));
    }

    const rows = await db
      .select()
      .from(profiles)
      .where(and(...conditions))
      .orderBy(desc(profiles.createdAt));

    res.json(rows.map(serializeProfile));
  }),
);

router.get(
  '/tags',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const rows = await rawRows<{ tag: string; count: number }>(
      db,
      sql`SELECT t.tag AS tag, count(*)::int AS count
          FROM profiles p, unnest(p.tags) AS t(tag)
          WHERE p.user_id = ${req.user!.id}
          GROUP BY t.tag
          ORDER BY count DESC`,
    );
    res.json(rows);
  }),
);

router.post(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = createProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const result = await createProfile(db, req.user!.id, parsed.data, { ip: req.ip });
    if (!result.ok) return sendCreateError(res, result);

    res.status(201).json(serializeProfile(result.profile as any));
  }),
);

router.post(
  '/bulk',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = bulkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const requested = parsed.data.profiles.length;
    const result = await createProfilesBulk(db, req.user!.id, parsed.data.profiles, {
      ip: req.ip,
    });
    if (!result.ok) return sendCreateError(res, result, requested);

    const created = (result.profile as any[]).map(serializeProfile);
    res.status(201).json({ created: created.length, profiles: created });
  }),
);

router.post(
  '/import',
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const requested = parsed.data.profiles.length;
    const result = await createProfilesBulk(db, req.user!.id, parsed.data.profiles, {
      ip: req.ip,
    });
    if (!result.ok) return sendCreateError(res, result, requested);

    res.status(201).json({ imported: (result.profile as any[]).length });
  }),
);

router.get(
  '/export',
  authenticate,
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const rows = await db.select().from(profiles).where(eq(profiles.userId, req.user!.id));

    const exportData = rows.map((p) => ({
      name: p.name,
      proxy: p.proxy ? decryptProxy(p.proxy) ?? null : undefined,
      startUrl: p.startUrl,
      tags: p.tags,
      notes: p.notes,
    }));

    res.setHeader('Content-Disposition', 'attachment; filename=profiles.json');
    res.json(exportData);
  }),
);

router.get(
  '/:id',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    res.json(serializeProfile(loaded.profile));
  }),
);

router.post(
  '/:id/clone',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    const { name } = req.body as { name?: string };
    const cloned = await cloneProfile(db, loaded.profile, req.user!.id, name, { ip: req.ip });
    if (!cloned.ok) return sendCreateError(res, cloned);
    res.status(201).json(serializeProfile(cloned.profile as any));
  }),
);

router.patch(
  '/:id',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const profile = loaded.profile;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
    if (parsed.data.proxy !== undefined) {
      patch.proxy = parsed.data.proxy?.trim()
        ? encryptProxy(parsed.data.proxy.trim()) ?? null
        : null;
    }
    if (parsed.data.startUrl !== undefined) patch.startUrl = parsed.data.startUrl || null;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes || null;

    if (parsed.data.os !== undefined && parsed.data.os !== profile.os) {
      const from = profile.os ?? 'sin fijar';
      patch.os = parsed.data.os;
      await logActivity(
        db,
        req.user!.id,
        'update',
        'profile',
        profile.id,
        { os: { from, to: parsed.data.os } },
        req.ip,
      );
    }

    const [updated] = await db
      .update(profiles)
      .set(patch)
      .where(eq(profiles.id, profile.id))
      .returning();

    res.json(serializeProfile(updated));
  }),
);

router.delete(
  '/:id',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    await db.delete(profiles).where(eq(profiles.id, loaded.profile.id));
    await logActivity(
      db,
      req.user!.id,
      'delete',
      'profile',
      loaded.profile.id,
      { name: loaded.profile.name },
      req.ip,
    );

    res.json({ message: 'Perfil eliminado.' });
  }),
);

router.post(
  '/:id/clear-session',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    const updated = await db
      .update(browserStates)
      .set({ cookies: '[]', localStorage: '{}', lastUsedAt: new Date() })
      .where(eq(browserStates.profileId, loaded.profile.id))
      .returning({ id: browserStates.id });

    if (updated.length === 0) {
      return res.status(404).json({ error: 'No hay datos de sesion guardados' });
    }

    await logActivity(
      db,
      req.user!.id,
      'clear_session',
      'profile',
      loaded.profile.id,
      undefined,
      req.ip,
    );

    res.json({ message: 'Datos de sesion limpiados.' });
  }),
);

const saveStateSchema = z.object({
  cookies: z.string().max(5_000_000),
  localStorage: z.string().max(5_000_000),
});

router.put(
  '/:id/browser-state',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const parsed = saveStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }

    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    const updated = await db
      .update(browserStates)
      .set({
        cookies: parsed.data.cookies,
        localStorage: parsed.data.localStorage,
        lastUsedAt: new Date(),
      })
      .where(eq(browserStates.profileId, loaded.profile.id))
      .returning({ id: browserStates.id });

    if (updated.length === 0) {
      return res.status(404).json({ error: 'No browser state found' });
    }

    res.json({ message: 'Estado guardado.' });
  }),
);

router.get(
  '/:id/browser-state',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    const [state] = await db
      .select()
      .from(browserStates)
      .where(eq(browserStates.profileId, loaded.profile.id))
      .limit(1);

    if (!state) return res.json({ hasState: false });

    let cookiesCount = 0;
    try {
      cookiesCount = JSON.parse(state.cookies || '[]').length;
    } catch {
      /* datos legacy corruptos: se informa 0 */
    }

    const recipe = computeFingerprint(
      loaded.profile.id,
      loaded.profile.os as any,
    );
    const { uaOs, fullVersion, screenWidth, screenHeight, devicePixelRatio, timezone } =
      recipe.identity;

    res.json({
      hasState: true,
      cookiesCount,
      lastUsedAt: state.lastUsedAt,
      fingerprint: {
        userAgent: `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`,
        viewport: { width: screenWidth, height: screenHeight },
        timezone,
        devicePixelRatio,
      },
    });
  }),
);

router.post(
  '/:id/validate-proxy',
  authenticate,
  requireUuid(),
  asyncHandler(async (req, res) => {
    const db = dbOf(req);
    const loaded = await loadOwnedProfile(db, req.params.id, req.user!.id);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    if (!loaded.profile.proxy) {
      return res.status(400).json({ error: 'Este perfil no tiene proxy configurado' });
    }

    res.json(await validateProxy(decryptProxy(loaded.profile.proxy) ?? ''));
  }),
);

router.post(
  '/validate-proxy',
  authenticate,
  asyncHandler(async (req, res) => {
    const { proxy } = req.body as { proxy?: string };
    if (!proxy) return res.status(400).json({ error: 'proxy is required' });
    res.json(await validateProxy(proxy));
  }),
);

export default router;

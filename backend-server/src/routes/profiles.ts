import { Router } from 'express';
import { z } from 'zod';
import Profile from '../models/Profile';
import BrowserState from '../models/BrowserState';
import User, { PLAN_LIMITS } from '../models/User';
import { authenticate } from '../authMiddleware';
import { validateProxy } from '../services/proxyValidator';
import { computeFingerprint } from '../services/fingerprintService';
import { logActivity } from '../services/activityLog';
import { encryptProxy, decryptProxy, isEncrypted } from '../services/proxyCipher';
import { asyncHandler } from '../utils/asyncHandler';
import {
  checkProfileQuota,
  createProfile,
  createProfilesBulk,
  serializeProfile,
  isValidObjectId,
  loadOwnedProfile,
  cloneProfile,
} from '../services/profileService';

const router = Router();

// El servidor NO guarda proxys: cada usuario los mantiene solo en su máquina.
// Este middleware los descarta en cualquier request a /api/profiles (create,
// update, bulk...). Los registros antiguos ya fueron limpiados en producción.
router.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object' && 'proxy' in req.body) {
    delete req.body.proxy;
  }
  next();
});

/**
 * Valida que `:id` sea un ObjectId antes de llegar a la ruta.
 *
 * `Profile.findById('cualquier cosa')` lanza un CastError de Mongoose, que el
 * asyncHandler convierte en un 500. Es decir: pedir /api/profiles/loquesea
 * devolvía un error interno de servidor por una petición del cliente mal
 * formada. Con este middleware se responde 400 diciendo qué se esperaba.
 *
 * Se aplica como precondición en las rutas con :id en lugar de repetir el
 * `if (!isValidObjectId(...))` en cada una: son nueve sitios, y el noveno sería
 * el que se olvidaría.
 */
const requireObjectId =
  (param = 'id') =>
  (req: any, res: any, next: any) => {
    const value = req.params?.[param];
    if (!isValidObjectId(String(value ?? ''))) {
      return res.status(400).json({
        error: `El identificador "${value}" no tiene un formato válido.`,
      });
    }
    next();
  };

// `os` es opcional en las tres: si no viene, el servidor lo sortea y lo fija en
// la primera petición de huella (ver resolveOs). Si viene, se guarda ya.
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
  profiles: z.array(z.object({
    name: z.string().min(1).max(100),
    proxy: z.string().max(500).optional(),
    startUrl: z.string().url().optional(),
    tags: z.array(z.string()).optional(),
    os: osField.optional(),
  })).min(1).max(100),
});

const importSchema = z.object({
  profiles: z.array(z.object({
    name: z.string().min(1),
    proxy: z.string().optional(),
    startUrl: z.string().optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })).min(1).max(500),
});

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { tag, search } = req.query;
  const filter: Record<string, unknown> = { userId: req.user!._id };

  if (tag && typeof tag === 'string') {
    filter.tags = tag;
  }
  if (search && typeof search === 'string') {
    const escapedSearch = search.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    filter.name = { $regex: escapedSearch, $options: 'i' };
  }

  const profiles = await Profile.find(filter).sort({ createdAt: -1 });
  res.json(profiles.map(serializeProfile));
}));

router.get('/tags', authenticate, asyncHandler(async (req, res) => {
  const tags = await Profile.aggregate([
    { $match: { userId: req.user!._id } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  res.json(tags.map((t) => ({ tag: t._id, count: t.count })));
}));

router.post('/', authenticate, asyncHandler(async (req, res) => {
  const parsed = createProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  // La regla del limite de perfiles vive en profileService: antes estaba
  // escrita aqui y en /bulk, con dos comparaciones distintas.
  const quota = await checkProfileQuota(req.user!._id, 1);
  if (!quota.ok) {
    return res.status(quota.status).json({
      error: quota.error,
      ...(quota.code ? { code: quota.code } : {}),
      ...(quota.limit !== undefined ? { limit: quota.limit } : {}),
      ...(quota.current !== undefined ? { current: quota.current } : {}),
    });
  }

  const result = await createProfile(req.user!._id, parsed.data, { ip: req.ip });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.status(201).json(serializeProfile(result.profile));
}));

router.post('/bulk', authenticate, asyncHandler(async (req, res) => {
  const parsed = bulkCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const requested = parsed.data.profiles.length;

  // Misma comprobación que en POST /, ahora con la aritmética del bloque en el
  // servicio: count + requested > limite, siempre.
  const quota = await checkProfileQuota(req.user!._id, requested);
  if (!quota.ok) {
    return res.status(quota.status).json({
      error: quota.error,
      ...(quota.code ? { code: quota.code } : {}),
      ...(quota.limit !== undefined ? { limit: quota.limit } : {}),
      ...(quota.current !== undefined ? { current: quota.current } : {}),
      requested,
    });
  }

  const result = await createProfilesBulk(req.user!._id, parsed.data.profiles, { ip: req.ip });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  const created = (result.profile as any[]).map(serializeProfile);
  res.status(201).json({ created: created.length, profiles: created });
}));

router.post('/import', authenticate, asyncHandler(async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const requested = parsed.data.profiles.length;

  // Tercera copia de la regla del plan que existía aquí, con OTRO mensaje.
  // Ahora las tres rutas (/, /bulk, /import) comparten la misma comparación.
  const quota = await checkProfileQuota(req.user!._id, requested, { verb: 'import' });
  if (!quota.ok) {
    return res.status(quota.status).json({
      error: quota.error,
      ...(quota.code ? { code: quota.code } : {}),
      ...(quota.limit !== undefined ? { limit: quota.limit } : {}),
      ...(quota.current !== undefined ? { current: quota.current } : {}),
      requested,
    });
  }

  const result = await createProfilesBulk(req.user!._id, parsed.data.profiles, { ip: req.ip });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.status(201).json({ imported: (result.profile as any[]).length });
}));

router.get('/export', authenticate, asyncHandler(async (req, res) => {
  const profiles = await Profile.find({ userId: req.user!._id }).lean();
  const exportData = profiles.map((p) => ({
    name: p.name,
    proxy: p.proxy ? decryptProxy(p.proxy) ?? null : undefined,
    startUrl: p.startUrl,
    tags: p.tags,
    notes: p.notes,
  }));

  res.setHeader('Content-Disposition', 'attachment; filename=profiles.json');
  res.json(exportData);
}));

router.get('/:id', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;
  res.json(serializeProfile(profile));
}));

// GET /:id/fingerprint se eliminó el 03/10/2026.
//
// Devolvía el `fingerprint` guardado en BrowserState, que generaba un módulo
// distinto del que sirve la identidad real y se contradecía con ella en el
// 47,5% de los perfiles (medido sobre 200). No lo consumía nadie dentro del
// repo. La ruta que manda es POST /api/fingerprint: recibe profileId, devuelve
// la receta y además fija el `os` del perfil la primera vez.

router.post('/:id/clone', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  const { name } = req.body as { name?: string };

  // La clonacion (copia del proxy cifrado, del estado del navegador y la
  // auditoria) vivia entera en el handler. Ahora la hace el servicio, que es
  // donde se puede testear.
  const cloned = await cloneProfile(profile, req.user!._id, name, { ip: req.ip });

  res.status(201).json(serializeProfile(cloned));
}));

router.patch('/:id', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  if (parsed.data.name !== undefined) profile.name = parsed.data.name.trim();
  if (parsed.data.proxy !== undefined)
    profile.proxy = parsed.data.proxy?.trim() ? encryptProxy(parsed.data.proxy.trim()) ?? undefined : undefined;
  if (parsed.data.startUrl !== undefined) profile.startUrl = parsed.data.startUrl || undefined;
  if (parsed.data.tags !== undefined) profile.tags = parsed.data.tags;
  if (parsed.data.notes !== undefined) profile.notes = parsed.data.notes || undefined;

  // Cambiar el SO REESCRIBE la identidad del perfil: kit, token de UA, pantalla,
  // RAM y nucleos salen de la familia del SO. Es una decision consciente del
  // usuario, no un efecto secundario, asi que se guarda en auditoria para que
  // quede constancia de que la huella cambio.
  if (parsed.data.os !== undefined && parsed.data.os !== profile.os) {
    const from = profile.os ?? 'sin fijar';
    profile.os = parsed.data.os;
    await logActivity(
      req.user!._id,
      'update',
      'profile',
      profile._id.toString(),
      { os: { from, to: parsed.data.os } },
      req.ip
    );
  }

  await profile.save();
  res.json(serializeProfile(profile));
}));

router.delete('/:id', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  await BrowserState.deleteOne({ profileId: profile._id });
  await Profile.findByIdAndDelete(profile._id);

  await logActivity(req.user!._id, 'delete', 'profile', profile._id.toString(), { name: profile.name }, req.ip);

  res.json({ message: 'Perfil eliminado.' });
}));

router.post('/:id/clear-session', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  const result = await BrowserState.findOneAndUpdate(
    { profileId: profile._id },
    { cookies: '[]', localStorage: '{}', lastUsedAt: new Date() },
  );

  if (!result) {
    return res.status(404).json({ error: 'No hay datos de sesion guardados' });
  }

  await logActivity(req.user!._id, 'clear_session', 'profile', profile._id.toString(), undefined, req.ip);

  res.json({ message: 'Datos de sesion limpiados.' });
}));

const saveStateSchema = z.object({
  cookies: z.string().max(5_000_000),
  localStorage: z.string().max(5_000_000),
});

router.put('/:id/browser-state', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const parsed = saveStateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  const state = await BrowserState.findOneAndUpdate(
    { profileId: profile._id },
    { cookies: parsed.data.cookies, localStorage: parsed.data.localStorage, lastUsedAt: new Date() },
    { new: true },
  );

  if (!state) {
    return res.status(404).json({ error: 'No browser state found' });
  }

  res.json({ message: 'Estado guardado.' });
}));

router.get('/:id/browser-state', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  const state = await BrowserState.findOne({ profileId: profile._id });
  if (!state) {
    return res.json({ hasState: false });
  }

  let cookiesCount = 0;
  try { cookiesCount = JSON.parse(state.cookies || '[]').length; } catch { /* */ }

  // El resumen de identidad sale de la receta, no de un dato guardado. Antes
  // venía de BrowserState.fingerprint, que era otro generador y podía no
  // coincidir con lo que el motor recibe de verdad: el mismo perfil aparecía con
  // dos sistemas operativos según dónde se mirara.
  const recipe = computeFingerprint(profile._id.toString(), profile.os);
  const { uaOs, fullVersion, screenWidth, screenHeight, devicePixelRatio, timezone } = recipe.identity;

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
}));

router.post('/:id/validate-proxy', authenticate, requireObjectId(), asyncHandler(async (req, res) => {
  const loaded = await loadOwnedProfile(req.params.id, req.user!._id);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ error: loaded.error });
  }
  const profile = loaded.profile;

  if (!profile.proxy) {
    return res.status(400).json({ error: 'Este perfil no tiene proxy configurado' });
  }

  const result = await validateProxy(decryptProxy(profile.proxy) ?? '');
  res.json(result);
}));

router.post('/validate-proxy', authenticate, asyncHandler(async (req, res) => {
  const { proxy } = req.body as { proxy?: string };
  if (!proxy) {
    return res.status(400).json({ error: 'proxy is required' });
  }

  const result = await validateProxy(proxy);
  res.json(result);
}));

export default router;

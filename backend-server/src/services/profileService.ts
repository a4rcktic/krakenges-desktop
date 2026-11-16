import Profile from '../models/Profile';
import BrowserState from '../models/BrowserState';
import User, { IUser, PLAN_LIMITS } from '../models/User';
import { encryptProxy, decryptProxy, isEncrypted } from './proxyCipher';
import { logActivity } from './activityLog';

/**
 * Reglas de negocio de los perfiles, fuera de la capa HTTP.
 *
 * MOTIVACIÓN
 *
 * Este servicio existe por un bug concreto: el límite de perfiles del plan
 * estaba escrito DOS veces en routes/profiles.ts con dos comparaciones
 * distintas.
 *
 *   POST /        →  if (count >= limits.maxProfiles)            // crea 1
 *   POST /bulk    →  if (count + n > limits.maxProfiles)          // crea n
 *
 * Dos copias de la misma regla, escritas por separado. El día que cambiasen el
 * cómputo del plan, una se olvidaría y el usuario vería el mismo endpoint
 * aceptando más perfiles de los que le tocan.
 *
 * Ahora la comprobación vive aquí una sola vez, y ambas rutas la llaman. El
 * handler queda en su trabajo: validar entrada, delegar, responder.
 *
 * También permite testear la regla sin levantar HTTP ni fabricar un JWT:
 *
 *   await checkProfileQuota(userId, 1)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Resultado de las operaciones, para que el handler decida el status HTTP.
// Devolver 'ok: false' en vez de lanzar permite responder 403 con un cuerpo
// enriquecido (límite, uso actual, plan) sin que el servicio conozca Express.
// ─────────────────────────────────────────────────────────────────────────────

export type QuotaResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      limit?: number;
      current?: number;
    };

export type CreateResult =
  | { ok: true; profile: any }
  | { ok: false; status: number; error: string; code?: string; limit?: number; current?: number };

/**
 * ¿Puede `userId` crear `requesting` perfiles más según su plan?
 *
 * Se usa tanto para uno como para varios: la comparación es siempre
 * `count + requesting`, de modo que no puede haber dos versiones de la regla.
 */
export async function checkProfileQuota(
  userId: unknown,
  requesting: number,
  opts: { verb?: 'create' | 'import' } = {}
): Promise<QuotaResult> {
  const user = await User.findById(userId);
  if (!user) {
    return { ok: false, status: 404, error: 'User not found' };
  }

  const limits = PLAN_LIMITS[user.plan];
  if (limits.maxProfiles === -1) {
    return { ok: true }; // plan sin tope
  }

  const count = await Profile.countDocuments({ userId });
  if (count + requesting > limits.maxProfiles) {
    // El mensaje distingue "importar" de "crear", y "crear varios" de "crear
    // uno", porque el cliente lo muestra tal cual y cada caso guia a una accion
    // distinta. La COMPARACION es una sola; solo cambia el texto.
    let error: string;
    if (opts.verb === 'import') {
      error = `No puedes importar ${requesting} perfiles. Tienes ${count}/${limits.maxProfiles}.`;
    } else if (requesting === 1) {
      error = `Límite de perfiles alcanzado (${limits.maxProfiles}) para tu plan ${user.plan}. Actualiza tu plan para crear más.`;
    } else {
      error = `No puedes crear ${requesting} perfiles. Tienes ${count}/${limits.maxProfiles}. Actualiza tu plan.`;
    }

    return {
      ok: false,
      status: 403,
      error,
      code: 'PLAN_LIMIT_REACHED',
      limit: limits.maxProfiles,
      current: count,
    };
  }

  return { ok: true };
}

export interface ProfileInput {
  name: string;
  startUrl?: string;
  tags?: string[];
  notes?: string;
  /** SO que anunciará el perfil. Si no viene, lo fija el servidor al pedir la huella. */
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
}

/**
 * Crea un perfil con su estado de navegador inicial y registra la actividad.
 *
 * El proxy se cifra si viene, aunque el middleware de la ruta lo borra del body
 * por la política del proyecto (el servidor no guarda proxies). Se deja la
 * llamada explícita para que, si algún día se revisa esa política, el sitio de
 * cifrado sea uno solo y visible.
 */
export async function createProfile(
  userId: unknown,
  input: ProfileInput,
  opts: { proxy?: string; ip?: string } = {}
): Promise<CreateResult> {
  const profile = await Profile.create({
    userId,
    name: input.name.trim(),
    proxy: opts.proxy?.trim() ? encryptProxy(opts.proxy.trim()) : undefined,
    startUrl: input.startUrl || undefined,
    tags: input.tags || [],
    notes: input.notes || undefined,
    os: input.os || undefined,
  });

  // Solo se crea el estado vacío. La identidad NO se guarda aquí: la decide
  // fingerprintService y se sirve en POST /api/fingerprint. Antes se guardaba
  // además un segundo fingerprint, generado por otro módulo, que se
  // contradecía con ese en casi la mitad de los perfiles.
  await BrowserState.create({
    profileId: profile._id,
    userId,
    cookies: '[]',
    localStorage: '{}',
  });

  await logActivity(
    userId as any,
    'create',
    'profile',
    profile._id.toString(),
    { name: profile.name },
    opts.ip
  );

  return { ok: true, profile };
}

/**
 * Crea varios perfiles en una sola pasada de cuota.
 *
 * No delega en createProfile() a proposito: el flujo real de /bulk y /import
 * crea los documentos en bloque y registra una unica actividad con el resumen,
 * en lugar de una por perfil. Reutilizar createProfile() aqui haria N
 * countDocuments y N entradas de auditoria por cada importacion, que es
 * justo lo que un import masivo no debe hacer.
 */
export async function createProfilesBulk(
  userId: unknown,
  inputs: ProfileInput[],
  opts: { ip?: string; totalRequested?: number } = {}
): Promise<CreateResult> {
  const docs = inputs.map((input) => ({
    userId,
    name: input.name.trim(),
    // Política del proyecto: el servidor no guarda proxies.
    proxy: undefined,
    startUrl: input.startUrl || undefined,
    tags: input.tags || [],
    notes: input.notes || undefined,
    os: input.os || undefined,
  }));

  const created = await Profile.insertMany(docs);

  // Estado inicial para cada perfil nuevo.
  await BrowserState.insertMany(
    created.map((profile) => ({
      profileId: profile._id,
      userId,
      cookies: '[]',
      localStorage: '{}',
    }))
  );

  await logActivity(
    userId as any,
    'create',
    'profile',
    'bulk',
    { count: created.length, names: created.map((p) => p.name) },
    opts.ip
  );

  return { ok: true, profile: created };
}

/**
 * Serializa un perfil para devolvérselo a su dueño, descifrando el proxy.
 *
 * El proxy se guardaba cifrado (krakenges:v1:...) aunque la política actual
 * indique que no se almacenan: esto mantiene la lectura compatible con los
 * registros antiguos que aún queden en la base.
 */
export function serializeProfile(profile: unknown): unknown {
  const toJson = profile as { toJSON?: () => unknown } | null;
  const obj =
    toJson && typeof toJson.toJSON === 'function' ? toJson.toJSON() : { ...(toJson as object) };
  const rec = obj as Record<string, unknown> | null;
  if (rec && typeof rec.proxy === 'string' && rec.proxy.startsWith('krakenges:v1:')) {
    rec.proxy = decryptProxy(rec.proxy) ?? null;
  }
  return obj;
}

/**
 * Busca un perfil exigiendo que sea del usuario.
 *
 * Antes cada ruta repetia el mismo par de comprobaciones:
 *
 *     const profile = await Profile.findById(req.params.id);
 *     if (!profile) return 404
 *     if (!profile.userId.equals(req.user._id)) return 403
 *
 * en NUEVE sitios. La comprobacion de pertenencia es la que protege datos entre
 * usuarios, y repetirla nueve veces es la forma habitual de que una se olvide.
 * Aqui es una sola funcion y las nueve la llaman.
 *
 * Distingue 404 de 403 a proposito, como antes: 403 sobre un id ajeno confirma
 * que ese perfil existe, asi que un atacante podria enumerar ids validos. No es
 * un problema serio aqui (los ids son ObjectId), pero la distincion ya existia y
 * mantenerla evita cambiar comportamiento sin querer.
 */
export async function loadOwnedProfile(
  profileId: string,
  userId: unknown
): Promise<
  | { ok: true; profile: any }
  | { ok: false; status: 404 | 403; error: string }
> {
  const profile = await Profile.findById(profileId);
  if (!profile) {
    return { ok: false, status: 404, error: 'Profile not found' };
  }
  if (!profile.userId.equals(userId as any)) {
    return { ok: false, status: 403, error: 'Profile belongs to another user' };
  }
  return { ok: true, profile };
}

/** Clona un perfil con su estado de navegador. */
export async function cloneProfile(
  source: any,
  userId: unknown,
  newName: string | undefined,
  opts: { ip?: string } = {}
): Promise<any> {
  const name = newName || `${source.name} (copia)`;

  const cloned = await Profile.create({
    userId,
    name,
    // El proxy del original ya viene cifrado; se re-cifra solo si llega en
    // claro, para no double-cifrar.
    proxy: source.proxy
      ? isEncrypted(source.proxy)
        ? source.proxy
        : encryptProxy(source.proxy) ?? undefined
      : undefined,
    startUrl: source.startUrl,
    tags: [...(source.tags || [])],
    notes: source.notes,
    // Un clon DEBERIA arrancar con el mismo SO que el original: clonar es
    // repetir ese perfil, no crear uno nuevo con otra identidad.
    os: source.os || undefined,
  });

  const originalState = await BrowserState.findOne({ profileId: source._id });
  await BrowserState.create({
    profileId: cloned._id,
    userId,
    cookies: originalState?.cookies || '[]',
    localStorage: originalState?.localStorage || '{}',
  });

  await logActivity(
    userId as any,
    'clone',
    'profile',
    cloned._id.toString(),
    { original: source.name, clone: cloned.name },
    opts.ip
  );

  return cloned;
}

/**
 * Perfil del usuario, o 404. Centraliza la comprobación de pertenencia para que
 * ningún endpoint pueda olvidar de comprobar que el perfil es suyo.
 */
export async function findOwnedProfile(profileId: string, userId: unknown) {
  return Profile.findOne({ _id: profileId, userId });
}

/** ¿Es 'id' un ObjectId válido? Evita castear basura y producir 500. */
export function isValidObjectId(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

export type { IUser };
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '../logger';

/**
 * Contenido público que el cliente puede actualizar sin recompilar la app.
 *
 * Qué entra aquí:
 *   - precios, nombres y textos comerciales de los planes;
 *   - textos de la interfaz que cambian por campaña;
 *   - tema activo (la app lo consume cuando el motor de temas esté activo).
 *
 * Qué NO entra aquí:
 *   - límites de plan, permisos, claves, secretos o reglas de negocio. Esos
 *     siguen en `config/plans.ts` y en el backend, porque un cambio de límites
 *     debe validarse y auditarse, no publicarse como si fuera un precio.
 */

const planOverrideSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    price: z.number().finite().min(0).max(100000).optional(),
    currency: z.string().trim().min(1).max(8).optional(),
    interval: z.string().trim().min(1).max(32).optional(),
    tagline: z.string().trim().max(240).optional(),
    features: z.array(z.string().trim().min(1).max(180)).max(20).optional(),
  })
  .strict();

const contentSchema = z
  .object({
    version: z.number().int().nonnegative().optional(),
    updatedAt: z.string().datetime().nullable().optional(),
    brand: z.record(z.string(), z.string().max(160)).optional(),
    texts: z.record(z.string(), z.string().max(2000)).optional(),
    plans: z.record(z.string(), planOverrideSchema).optional(),
    theme: z
      .object({
        id: z.string().trim().min(1).max(64).optional(),
        version: z.number().int().nonnegative().optional(),
        // El CSS viaja con el contenido para que un cambio de tema no exija
        // recompilar la app. El cliente lo inyecta con textContent, nunca como
        // HTML, así que no puede escapar a un <script>.
        css: z.string().max(200_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PublicPlanOverride = z.infer<typeof planOverrideSchema>;

export interface PublicContent {
  version: number;
  updatedAt: string | null;
  brand: Record<string, string>;
  texts: Record<string, string>;
  plans: Record<string, PublicPlanOverride>;
  theme: { id: string; version: number; css?: string };
}

export const DEFAULT_PUBLIC_CONTENT: PublicContent = {
  version: 1,
  updatedAt: null,
  brand: {},
  texts: {},
  plans: {},
  theme: { id: 'default', version: 1 },
};

const CONTENT_PATH = process.env.PUBLIC_CONTENT_PATH
  ? path.resolve(process.env.PUBLIC_CONTENT_PATH)
  : path.resolve(process.cwd(), 'content/public-content.json');

let cache: { mtimeMs: number; size: number; data: PublicContent } | null = null;

function mergeContent(parsed: z.infer<typeof contentSchema>): PublicContent {
  const plans: Record<string, PublicPlanOverride> = {};
  for (const [id, override] of Object.entries(parsed.plans ?? {})) {
    // Solo se aceptan ids de plan reales. Un id inventado no debe llegar al
    // cliente y menos aún crear una tarjeta fantasma.
    if (['ghost', 'shadow', 'specter', 'phantom'].includes(id)) {
      plans[id] = override;
    }
  }

  return {
    version: parsed.version ?? 1,
    updatedAt: parsed.updatedAt ?? null,
    brand: parsed.brand ?? {},
    texts: parsed.texts ?? {},
    plans,
    theme: {
      id: parsed.theme?.id ?? DEFAULT_PUBLIC_CONTENT.theme.id,
      version: parsed.theme?.version ?? DEFAULT_PUBLIC_CONTENT.theme.version,
      ...(parsed.theme?.css ? { css: parsed.theme.css } : {}),
    },
  };
}

/**
 * Lee el archivo de contenido si cambió. Si no existe o es inválido, devuelve
 * los valores por defecto: el cliente nunca se queda sin catálogo por un JSON
 * mal editado.
 */
export function loadPublicContent(): PublicContent {
  try {
    const stat = fs.statSync(CONTENT_PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.data;
    }

    const raw = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
    const parsed = contentSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(
        { path: CONTENT_PATH, issues: parsed.error.issues },
        'Contenido público inválido; se conserva la última versión buena'
      );
      return cache?.data ?? DEFAULT_PUBLIC_CONTENT;
    }

    const data = mergeContent(parsed.data);
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.error({ path: CONTENT_PATH, err: err?.message }, 'No se pudo leer el contenido público');
    }
    return cache?.data ?? DEFAULT_PUBLIC_CONTENT;
  }
}

export function publicContentPath(): string {
  return CONTENT_PATH;
}

export interface ContentHistoryEntry {
  id: string;
  version: number;
  size: number;
  createdAt: string;
}

/**
 * Error de contenido con estado HTTP. Lo usa la ruta para responder 400/404
 * sin exponer detalles internos del sistema de archivos.
 */
export class PublicContentError extends Error {
  readonly statusCode: number;
  readonly issues?: unknown;

  constructor(message: string, statusCode = 400, issues?: unknown) {
    super(message);
    this.name = 'PublicContentError';
    this.statusCode = statusCode;
    this.issues = issues;
  }
}

const HISTORY_DIR = path.join(path.dirname(CONTENT_PATH), 'history');
const HISTORY_ID_RE = /^\d{14}(\d{3})?\.json$/;
const MAX_HISTORY = 50;

function historyTimestamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[-:T]/g, '').replace('.', '').slice(0, 17);
}

function historyCreatedAt(id: string): string {
  const raw = id.replace('.json', '');
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  const hour = raw.slice(8, 10);
  const minute = raw.slice(10, 12);
  const second = raw.slice(12, 14);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

/** Invalida la caché en memoria; la siguiente lectura relee el archivo. */
export function invalidatePublicContentCache(): void {
  cache = null;
}

/** Valida y normaliza un contenido sin publicarlo. */
export function previewPublicContent(input: unknown): PublicContent {
  const parsed = contentSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublicContentError('El contenido no tiene el formato esperado.', 400, parsed.error.issues);
  }
  return mergeContent(parsed.data);
}

async function writeContentFile(content: PublicContent): Promise<void> {
  await fs.promises.mkdir(path.dirname(CONTENT_PATH), { recursive: true, mode: 0o750 });
  const directory = path.dirname(CONTENT_PATH);
  const temporary = path.join(directory, `.public-content.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o640 });
  await fs.promises.rename(temporary, CONTENT_PATH);
}

async function pruneHistory(): Promise<void> {
  const files = (await fs.promises.readdir(HISTORY_DIR))
    .filter((name) => HISTORY_ID_RE.test(name))
    .sort()
    .reverse();
  const stale = files.slice(MAX_HISTORY);
  await Promise.all(stale.map((name) => fs.promises.unlink(path.join(HISTORY_DIR, name)).catch(() => undefined)));
}

/** Guarda una copia de la versión actual antes de reemplazarla. */
async function archiveCurrent(current: PublicContent): Promise<void> {
  await fs.promises.mkdir(HISTORY_DIR, { recursive: true, mode: 0o750 });
  const id = `${historyTimestamp()}.json`;
  await fs.promises.writeFile(path.join(HISTORY_DIR, id), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o640 });
  await pruneHistory();
}

/**
 * Publica contenido nuevo. Valida, archiva la versión anterior y escribe el
 * archivo de forma atómica. La versión siempre avanza para invalidar cachés.
 */
export async function savePublicContent(input: unknown): Promise<PublicContent> {
  const next = previewPublicContent(input);
  const current = loadPublicContent();
  next.version = Math.max(current.version, next.version) + 1;
  next.updatedAt = new Date().toISOString();
  await archiveCurrent(current);
  await writeContentFile(next);
  invalidatePublicContentCache();
  return next;
}

export async function listContentHistory(): Promise<ContentHistoryEntry[]> {
  try {
    const files = (await fs.promises.readdir(HISTORY_DIR)).filter((name) => HISTORY_ID_RE.test(name));
    const entries = await Promise.all(
      files.map(async (id) => {
        try {
          const stat = await fs.promises.stat(path.join(HISTORY_DIR, id));
          let version = 0;
          try {
            const raw = JSON.parse(await fs.promises.readFile(path.join(HISTORY_DIR, id), 'utf8'));
            if (typeof raw?.version === 'number' && Number.isFinite(raw.version)) version = raw.version;
          } catch {
            // Un archivo dañado no debe romper el listado.
          }
          return { id, version, size: stat.size, createdAt: historyCreatedAt(id) };
        } catch (err: any) {
          if (err?.code === 'ENOENT') return null;
          throw err;
        }
      })
    );
    return entries
      .filter((entry): entry is ContentHistoryEntry => entry !== null)
      .sort((a, b) => b.id.localeCompare(a.id));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

export async function readHistoryContent(id: string): Promise<PublicContent> {
  if (!HISTORY_ID_RE.test(id)) {
    throw new PublicContentError('La versión indicada no es válida.', 400);
  }
  const file = path.join(HISTORY_DIR, id);
  if (!file.startsWith(HISTORY_DIR + path.sep)) {
    throw new PublicContentError('La versión indicada no es válida.', 400);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new PublicContentError('La versión indicada ya no existe.', 404);
    }
    throw new PublicContentError('La versión indicada no se pudo leer.', 400);
  }
  return previewPublicContent(raw);
}

/** Restaura una versión del historial como nueva publicación. */
export async function revertPublicContent(id: string): Promise<PublicContent> {
  const restored = await readHistoryContent(id);
  const current = loadPublicContent();
  restored.version = current.version + 1;
  restored.updatedAt = new Date().toISOString();
  await archiveCurrent(current);
  await writeContentFile(restored);
  invalidatePublicContentCache();
  return restored;
}

import { useEffect, useState } from 'react';
import { invoke } from '../services/tauriBridge';

/**
 * Contenido público remoto con caché local.
 *
 * La app arranca siempre con su catálogo local y refresca en segundo plano. Si
 * el backend no responde, el usuario sigue viendo la última versión buena; si
 * tampoco hay caché, se usan los valores compilados. Nunca se bloquea el
 * arranque ni se deja una tarjeta vacía por un fallo de red.
 */

export interface RemotePlanOverride {
  name?: string;
  price?: number;
  currency?: string;
  interval?: string;
  tagline?: string;
  features?: string[];
}

export interface PublicContent {
  version: number;
  updatedAt: string | null;
  brand: Record<string, string>;
  texts: Record<string, string>;
  plans: Record<string, RemotePlanOverride>;
  theme: { id: string; version: number; css?: string };
}

const CACHE_KEY = 'krakenges_public_content_v1';
const CACHE_TTL_MS = 60_000;

const EMPTY_CONTENT: PublicContent = {
  version: 0,
  updatedAt: null,
  brand: {},
  texts: {},
  plans: {},
  theme: { id: 'default', version: 1 },
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function normalize(raw: unknown): PublicContent {
  const obj = asRecord(raw);
  const rawPlans = asRecord(obj.plans);
  const plans: Record<string, RemotePlanOverride> = {};

  for (const [id, value] of Object.entries(rawPlans)) {
    if (!['ghost', 'shadow', 'specter', 'phantom'].includes(id)) continue;
    const p = asRecord(value);
    const plan: RemotePlanOverride = {};
    if (typeof p.name === 'string' && p.name.trim()) plan.name = p.name.trim();
    if (typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0) plan.price = p.price;
    if (typeof p.currency === 'string' && p.currency.trim()) plan.currency = p.currency.trim();
    if (typeof p.interval === 'string' && p.interval.trim()) plan.interval = p.interval.trim();
    if (typeof p.tagline === 'string' && p.tagline.trim()) plan.tagline = p.tagline.trim();
    if (Array.isArray(p.features)) {
      plan.features = p.features.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0);
    }
    plans[id] = plan;
  }

  const texts: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(obj.texts))) {
    if (typeof value === 'string' && value.trim()) texts[key] = value;
  }

  const brand: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(obj.brand))) {
    if (typeof value === 'string' && value.trim()) brand[key] = value;
  }

  const theme = asRecord(obj.theme);
  return {
    version: typeof obj.version === 'number' && Number.isFinite(obj.version) ? obj.version : 0,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
    brand,
    texts,
    plans,
    theme: {
      id: typeof theme.id === 'string' && theme.id.trim() ? theme.id.trim() : 'default',
      version: typeof theme.version === 'number' && Number.isFinite(theme.version) ? theme.version : 1,
      ...(typeof theme.css === 'string' && theme.css.trim() ? { css: theme.css } : {}),
    },
  };
}

let cached: PublicContent | null = null;
let cachedAt = 0;
let inflight: Promise<PublicContent> | null = null;

function readCache(): PublicContent {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const content = normalize(parsed?.content);
      if (content.version > 0) {
        cached = content;
        cachedAt = typeof parsed?.cachedAt === 'number' ? parsed.cachedAt : 0;
        return cached;
      }
    }
  } catch {
    /* localStorage puede estar bloqueado; se usa el fallback compilado */
  }
  return EMPTY_CONTENT;
}

function saveCache(content: PublicContent): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ content, cachedAt: Date.now() }));
  } catch {
    /* sin caché persistente; la sesión actual sigue funcionando */
  }
}

export function getCachedPublicContent(): PublicContent {
  return readCache();
}

export async function refreshPublicContent(force = false): Promise<PublicContent> {
  const current = readCache();
  if (!force && cachedAt && Date.now() - cachedAt < CACHE_TTL_MS) {
    return current;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const data = await invoke<unknown>('server_get_public_content');
      const content = normalize(data);
      if (content.version > 0 || Object.keys(content.plans).length > 0 || Object.keys(content.texts).length > 0) {
        cached = content;
        cachedAt = Date.now();
        saveCache(content);
        return content;
      }
      return current;
    } catch {
      // Sin red o backend antiguo sin /content: se conserva la caché local.
      return current;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function usePublicContent(): PublicContent {
  const [content, setContent] = useState<PublicContent>(getCachedPublicContent);

  useEffect(() => {
    let active = true;
    const apply = (next: PublicContent) => {
      if (active) setContent(next);
    };

    refreshPublicContent().then(apply).catch(() => {});

    // Una consulta cada cinco minutos es suficiente para una campaña o un
    // cambio de precio; no compite con el sondeo de perfiles/sesiones.
    const timer = window.setInterval(() => {
      refreshPublicContent(true).then(apply).catch(() => {});
    }, 5 * 60_000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshPublicContent().then(apply).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return content;
}

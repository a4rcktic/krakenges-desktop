/**
 * URLs públicas del backend.
 *
 * Se leen de entorno para que el mismo binario sirva en el dominio original o
 * en el de un comprador sin recompilar. `tools/brand/apply.mjs` mantiene los
 * valores de `.env.example` sincronizados con `brand.config.json`.
 */

import { PUBLIC_BASE_URL as BRAND_PUBLIC_BASE_URL } from './brand';

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const PUBLIC_BASE_URL = stripTrailingSlash(
  process.env.PUBLIC_BASE_URL || BRAND_PUBLIC_BASE_URL,
);

export const DOWNLOAD_BASE_URL = stripTrailingSlash(
  process.env.DOWNLOAD_BASE_URL || `${PUBLIC_BASE_URL}/downloads`,
);

export const APP_PUBLIC_URL = stripTrailingSlash(
  process.env.APP_PUBLIC_URL || PUBLIC_BASE_URL,
);

/** Fecha real de la release. No usar `new Date()`: cambia en cada arranque. */
export const RELEASE_DATE = process.env.RELEASE_DATE || '2026-10-01T00:00:00.000Z';

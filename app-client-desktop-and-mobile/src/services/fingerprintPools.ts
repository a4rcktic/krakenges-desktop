// Wrapper TypeScript para el catálogo de huellas y generador de identidades coherentes.
import {
  BROWSER_TYPES,
  KITS,
  TIMEZONES,
  LANGS,
  fnv1a32,
  buildIdentity as buildIdentityRaw,
  listAvailableKits as listAvailableKitsRaw,
} from '../../fingerprint/pools.mjs';

export interface ScreenSpec {
  w: number;
  h: number;
  dpr: number;
  availH: number;
}

export interface KitSpec {
  id: string;
  name: string;
  platform: string;
  uaOS: string;
  reducedUA?: string;
  model?: string;
  brand?: string;
  platformVersion: string;
  majorBase: number;
  screens: ScreenSpec[];
  gpus: string[];
  memCores: { deviceMemory: number; cores: number }[];
}

export interface BrandHint {
  brand: string;
  version: string;
}

export interface GeneratedIdentity {
  seed: number;
  os: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  browser: 'chrome' | 'edge' | 'opera' | 'samsung' | 'firefox' | 'safari';
  kitId: string;
  kitName: string;
  model: string;
  brand: string;
  ua: string;
  major: number;
  fullVersion: string;
  brands: BrandHint[];
  platform: string;
  platformVersion: string;
  screen: ScreenSpec;
  gpu: string;
  deviceMemory: number;
  hardwareConcurrency: number;
  maxTouchPoints: number;
  timezone: string;
  lang: string;
}

export interface BuildIdentityOptions {
  seed?: number;
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  browser?: 'chrome' | 'edge' | 'opera' | 'samsung' | 'firefox' | 'safari';
  kitId?: string;
  engineVersion?: number | string;
  timezone?: string;
  lang?: string;
}

export { BROWSER_TYPES, KITS, TIMEZONES, LANGS, fnv1a32 };

export function buildIdentity(options: BuildIdentityOptions = {}): GeneratedIdentity {
  return buildIdentityRaw(options) as GeneratedIdentity;
}

export function listAvailableKits(osKey?: string): KitSpec[] {
  return listAvailableKitsRaw(osKey) as KitSpec[];
}

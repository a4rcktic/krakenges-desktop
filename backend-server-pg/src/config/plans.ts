export type PlanType = 'ghost' | 'shadow' | 'specter' | 'phantom' | 'free' | 'pro' | 'enterprise';

export interface PlanLimits {
  maxProfiles: number;
  maxSessions: number;
  maxApiKeys: number;
}

export interface PlanDefinition {
  id: 'ghost' | 'shadow' | 'specter' | 'phantom';
  name: string;
  codename: string;
  tagline: string;
  price: number;
  currency: string;
  interval: string;
  limits: PlanLimits;
  badgeColor: string;
  popular?: boolean;
  features: string[];
}

export const PLAN_CONFIGS: Record<'ghost' | 'shadow' | 'specter' | 'phantom', PlanDefinition> = {
  ghost: {
    id: 'ghost',
    name: 'Ghost',
    codename: 'GHOST',
    tagline: 'Invisibilidad esencial para pruebas y exploración',
    price: 0,
    currency: 'USD',
    interval: 'permanente',
    badgeColor: 'badge-ghost',
    limits: {
      maxProfiles: 3,
      maxSessions: 2,
      maxApiKeys: 0,
    },
    features: [
      '3 perfiles aislados',
      '2 sesiones simultáneas activas',
      '5 horas de prueba completa',
      'Fingerprints deterministas con mulberry32',
      'Proxy checker y GeoIP auto-align',
      'Almacenamiento local persistente',
    ],
  },
  shadow: {
    id: 'shadow',
    name: 'Shadow',
    codename: 'SHADOW',
    tagline: 'Operaciones individuales y multicuenta estándar',
    price: 29,
    currency: 'USD',
    interval: 'mes',
    popular: true,
    badgeColor: 'badge-primary',
    limits: {
      maxProfiles: 50,
      maxSessions: 5,
      maxApiKeys: 2,
    },
    features: [
      '50 perfiles aislados',
      '5 sesiones simultáneas activas',
      '2 API Keys de automatización',
      'Sincronización en la nube cifrada',
      'Soporte prioritario',
      'Exportación/Importación masiva',
    ],
  },
  specter: {
    id: 'specter',
    name: 'Specter',
    codename: 'SPECTER',
    tagline: 'Alto rendimiento para media buyers y automatización intensiva',
    price: 79,
    currency: 'USD',
    interval: 'mes',
    badgeColor: 'badge-secondary',
    limits: {
      maxProfiles: 200,
      maxSessions: 15,
      maxApiKeys: 5,
    },
    features: [
      '200 perfiles aislados',
      '15 sesiones simultáneas activas',
      '5 API Keys de automatización',
      'Sincronización cloud en tiempo real',
      'Rotación de proxies móviles por URL',
      'Soporte VIP 24/7',
      'Integración con Puppeteer/Playwright',
    ],
  },
  phantom: {
    id: 'phantom',
    name: 'Phantom Prime',
    codename: 'PHANTOM',
    tagline: 'Poder absoluto e ilimitado para agencias y equipos masivos',
    price: 199,
    currency: 'USD',
    interval: 'mes',
    badgeColor: 'badge-accent',
    limits: {
      maxProfiles: -1,
      maxSessions: -1,
      maxApiKeys: -1,
    },
    features: [
      'Perfiles ilimitados',
      'Sesiones simultáneas ilimitadas',
      'API Keys ilimitadas',
      'Acceso prioritario a nuevos fingerprints',
      'Webhooks y endpoints dedicados',
      'Soporte técnico directo con ingenieros',
    ],
  },
};

// Map legacy plan names (free, pro, enterprise) to the new stealth tiers.
//
// `pro` -> `shadow` es deliberado: el panel de analitica (routes/users.ts) ya
// cuenta `pro` como Shadow y la interfaz siempre lo llamo Shadow. Antes esta
// funcion devolvia `specter`, asi que un usuario `pro` tenia 50 perfiles en la
// UI y 200 en el servidor.
export function normalizePlan(plan?: string): 'ghost' | 'shadow' | 'specter' | 'phantom' {
  if (!plan) return 'ghost';
  const p = plan.toLowerCase().trim();
  if (p === 'ghost' || p === 'free') return 'ghost';
  if (p === 'shadow' || p === 'pro') return 'shadow';
  if (p === 'specter') return 'specter';
  if (p === 'phantom' || p === 'phantom_prime' || p === 'enterprise') return 'phantom';
  return 'ghost';
}

export function getPlanLimits(plan?: string): PlanLimits {
  const normalized = normalizePlan(plan);
  return PLAN_CONFIGS[normalized].limits;
}

/**
 * Entitlements efectivos de un usuario o de una clave.
 *
 * Los campos personalizados son opcionales: `null`/`undefined` significa
 * "usar el límite del plan base". Esto permite que las claves antiguas sigan
 * funcionando sin migrar datos y que una clave personalizada solo sobrescriba
 * lo que realmente necesita.
 */
export interface EntitlementSource {
  plan?: string | null;
  customPlanName?: string | null;
  maxProfiles?: number | null;
  maxSessions?: number | null;
  maxApiKeys?: number | null;
}

export function getEffectiveLimits(source: EntitlementSource): PlanLimits {
  const base = getPlanLimits(source.plan ?? undefined);
  return {
    maxProfiles: source.maxProfiles ?? base.maxProfiles,
    maxSessions: source.maxSessions ?? base.maxSessions,
    maxApiKeys: source.maxApiKeys ?? base.maxApiKeys,
  };
}

export function getEffectivePlanName(source: EntitlementSource): string {
  const custom = source.customPlanName?.trim();
  if (custom) return custom;
  return PLAN_CONFIGS[normalizePlan(source.plan ?? undefined)].name;
}

export function hasCustomEntitlements(source: EntitlementSource): boolean {
  return (
    Boolean(source.customPlanName?.trim()) ||
    (source.maxProfiles !== null && source.maxProfiles !== undefined) ||
    (source.maxSessions !== null && source.maxSessions !== undefined) ||
    (source.maxApiKeys !== null && source.maxApiKeys !== undefined)
  );
}

export const PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  ghost: PLAN_CONFIGS.ghost.limits,
  shadow: PLAN_CONFIGS.shadow.limits,
  specter: PLAN_CONFIGS.specter.limits,
  phantom: PLAN_CONFIGS.phantom.limits,
  // Legacy aliases
  free: PLAN_CONFIGS.ghost.limits,
  pro: PLAN_CONFIGS.shadow.limits,
  enterprise: PLAN_CONFIGS.phantom.limits,
};

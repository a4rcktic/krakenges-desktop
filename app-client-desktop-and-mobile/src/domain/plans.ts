/**
 * Catálogo de planes — ÚNICA fuente de verdad del cliente.
 *
 * POR QUÉ EXISTE
 *
 * Los identificadores de plan estaban escritos a mano en cuatro sitios y no
 * coincidían entre ellos:
 *
 *   DashboardMobile   free / pro / specter / enterprise
 *   DashboardDesktop  free / pro / specter / enterprise
 *   UsersView         free, ghost, pro, shadow, specter, enterprise, phantom
 *   PlansView         free / pro / specter / enterprise
 *   Backend           ghost / shadow / specter / phantom  (+ alias legacy)
 *
 * El backend entrega `plan: 'phantom'`, pero la comparación del cliente era
 * `currentPlan === 'enterprise'`, así que un usuario Phantom no veía
 * "Suscripción Vigente". Y un usuario legacy con plan `pro` recibía, según el
 * backend, los límites de Specter (200 perfiles) mientras la interfaz le
 * mostraba Shadow (50).
 *
 * Aquí solo viven los DATOS (id, precio, límites, cómo se llama el plan). El
 * texto de marketing de cada tarjeta sigue en PlansView, porque eso sí es
 * presentación y cambia por decisiones de producto, no de código.
 *
 * SI TOCAS ESTO, TOCA TAMBIÉN backend-server/src/config/plans.ts.
 * `tools/plan-check/check.js` corre en CI y falla si los dos se separan.
 */

/** Los cuatro planes reales. Cualquier otro nombre es un alias legacy. */
export type PlanId = 'ghost' | 'shadow' | 'specter' | 'phantom';

export interface PlanLimits {
  /** -1 significa ilimitado. */
  maxProfiles: number;
  maxSessions: number;
  maxApiKeys: number;
}

export interface PlanDefinition {
  id: PlanId;
  /** Nombre comercial. */
  name: string;
  /** Nombre en mayúsculas para chips y contadores. */
  codename: string;
  /** Cómo se llama el plan en el panel móvil/escritorio ("GHOST FLEET"). */
  fleetLabel: string;
  /** Precio mensual en USD. 0 = gratuito. */
  price: number;
  currency: 'USD';
  interval: 'mes' | 'permanente';
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  ghost: {
    id: 'ghost',
    name: 'Ghost',
    codename: 'GHOST',
    fleetLabel: 'GHOST FLEET',
    price: 0,
    currency: 'USD',
    interval: 'permanente',
    limits: { maxProfiles: 3, maxSessions: 2, maxApiKeys: 0 },
  },
  shadow: {
    id: 'shadow',
    name: 'Shadow',
    codename: 'SHADOW',
    fleetLabel: 'SHADOW FLEET',
    price: 29,
    currency: 'USD',
    interval: 'mes',
    limits: { maxProfiles: 50, maxSessions: 5, maxApiKeys: 2 },
  },
  specter: {
    id: 'specter',
    name: 'Specter',
    codename: 'SPECTER',
    fleetLabel: 'SPECTER FLEET',
    price: 79,
    currency: 'USD',
    interval: 'mes',
    limits: { maxProfiles: 200, maxSessions: 15, maxApiKeys: 5 },
  },
  phantom: {
    id: 'phantom',
    name: 'Phantom Prime',
    codename: 'PHANTOM',
    fleetLabel: 'PHANTOM PRIME (ILIMITADO)',
    price: 199,
    currency: 'USD',
    interval: 'mes',
    limits: { maxProfiles: -1, maxSessions: -1, maxApiKeys: -1 },
  },
};

export const PLAN_ORDER: PlanId[] = ['ghost', 'shadow', 'specter', 'phantom'];

/**
 * Alias legacy -> plan real.
 *
 * `pro` -> `shadow` es deliberado y coincide con el panel de analítica del
 * backend, que ya cuenta `pro` como Shadow (routes/users.ts). Antes
 * `normalizePlan('pro')` devolvía `specter`, así que el mismo plan valía 50
 * perfiles en la interfaz y 200 en el servidor.
 */
const ALIASES: Record<string, PlanId> = {
  ghost: 'ghost',
  free: 'ghost',
  shadow: 'shadow',
  pro: 'shadow',
  specter: 'specter',
  phantom: 'phantom',
  phantom_prime: 'phantom',
  enterprise: 'phantom',
};

/** Plan real al que corresponde un nombre del backend, o `ghost` si no se reconoce. */
export function normalizePlan(plan?: string | null): PlanId {
  if (!plan) return 'ghost';
  return ALIASES[plan.toLowerCase().trim()] ?? 'ghost';
}

export function getPlan(plan?: string | null): PlanDefinition {
  return PLANS[normalizePlan(plan)];
}

export function getPlanLimits(plan?: string | null): PlanLimits {
  return getPlan(plan).limits;
}

/** Nombre largo ("Phantom Prime") para cabeceras y tablas. */
export function planName(plan?: string | null): string {
  return getPlan(plan).name;
}

/** Chip de flota ("PHANTOM PRIME (ILIMITADO)"). */
export function planFleetLabel(plan?: string | null): string {
  return getPlan(plan).fleetLabel;
}

/**
 * Precio anual con el descuento histórico del 20 %.
 *
 * El descuento es aritmética local, no un dato que venga del backend: si el
 * servidor cambia el precio mensual, el anual se recalcula solo.
 */
export function annualPrice(plan: PlanDefinition): number {
  return Math.round(plan.price * 0.8);
}

/** "50" o "∞" para pintar un límite sin inventarlo. */
export function formatLimit(value: number): string {
  return value === -1 ? '∞' : String(value);
}

/**
 * Campos de suscripción que entrega el backend.
 *
 * El servidor es la autoridad: un plan puede ser estándar o una licencia
 * personalizada con nombre y límites propios. El catálogo local solo sirve de
 * respaldo para usuarios cacheados de versiones anteriores o si el servidor no
 * manda el campo.
 */
export interface ServerEntitlements {
  plan?: string | null;
  planName?: string | null;
  limits?: Partial<PlanLimits> | null;
}

function pickLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Nombre comercial real: el del servidor (incluye planes personalizados). */
export function effectivePlanName(user: ServerEntitlements): string {
  const remote = user.planName?.trim();
  return remote || planName(user.plan);
}

/** Límites reales: los del servidor, completados con el catálogo si faltan. */
export function effectivePlanLimits(user: ServerEntitlements): PlanLimits {
  const base = getPlanLimits(user.plan);
  const remote = user.limits;
  if (!remote) return base;
  return {
    maxProfiles: pickLimit(remote.maxProfiles, base.maxProfiles),
    maxSessions: pickLimit(remote.maxSessions, base.maxSessions),
    maxApiKeys: pickLimit(remote.maxApiKeys, base.maxApiKeys),
  };
}

/**
 * Etiqueta de flota. Para planes del catálogo conserva el texto de siempre
 * ("PHANTOM PRIME (ILIMITADO)"); para un plan personalizado usa su nombre.
 */
export function effectivePlanFleetLabel(user: ServerEntitlements): string {
  const remote = user.planName?.trim();
  const base = getPlan(user.plan);
  if (remote && remote.toLowerCase() !== base.name.toLowerCase()) {
    return remote.toUpperCase();
  }
  return base.fleetLabel;
}

/** Chip corto del plan ("PHANTOM"), o el nombre personalizado en mayúsculas. */
export function effectivePlanCodename(user: ServerEntitlements): string {
  const remote = user.planName?.trim();
  const base = getPlan(user.plan);
  if (remote && remote.toLowerCase() !== base.name.toLowerCase()) {
    return remote.toUpperCase();
  }
  return base.codename;
}

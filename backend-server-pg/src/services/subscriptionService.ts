import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { licenseKeys, users } from '../db/schema';
import type { Database } from '../db/client';
import type { LicenseKeyRow, UserRow } from '../db/schema';
import {
  getEffectiveLimits,
  getEffectivePlanName,
  hasCustomEntitlements,
  normalizePlan,
  PLAN_CONFIGS,
  type PlanDefinition,
  type PlanLimits,
} from '../config/plans';
import { logActivity } from './activityLog';

export interface SubscriptionStatusResult {
  plan: string;
  normalizedPlan: 'ghost' | 'shadow' | 'specter' | 'phantom';
  planName: string;
  planTagline: string;
  planBadgeColor: string;
  planUpgradedAt?: Date | null;
  planExpiresAt?: Date | null;
  isLifetime: boolean;
  isExpired: boolean;
  daysRemaining: number | null;
  limits: PlanLimits;
  planDetails: PlanDefinition;
}

/**
 * Si el plan de pago ha caducado, baja a ghost y lo audita. Devuelve siempre
 * la fila vigente (la actualizada si hubo downgrade).
 */
export async function checkAndHandleSubscriptionExpiry(
  db: Database,
  user: UserRow,
  ip?: string,
): Promise<UserRow> {
  if (user.isLifetime) return user;
  // Ghost sin caducidad ni entitlements es el plan gratuito permanente.
  // Pero una clave personalizada puede usar ghost como plan base y caducar:
  // en ese caso hay que seguir comprobando planExpiresAt.
  if (
    normalizePlan(user.plan) === 'ghost' &&
    !user.planExpiresAt &&
    !hasCustomEntitlements(user)
  ) {
    return user;
  }
  if (!user.planExpiresAt || new Date(user.planExpiresAt) >= new Date()) return user;

  const previousPlan = user.plan;
  const [updated] = await db
    .update(users)
    .set({
      plan: 'ghost',
      planExpiresAt: null,
      isLifetime: false,
      customPlanName: null,
      maxProfiles: null,
      maxSessions: null,
      maxApiKeys: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();

  await logActivity(
    db,
    user.id,
    'subscription_expired',
    'user',
    user.id,
    { previousPlan, newPlan: 'ghost' },
    ip,
  );

  return updated ?? user;
}

/**
 * Canjea una clave activa. El UPDATE condicional es atómico: dos peticiones
 * simultáneas no pueden canjear la misma clave, y el descuento/plan se aplica
 * en la misma transacción.
 */
export async function redeemLicenseKey(
  db: Database,
  userId: string,
  rawKey: string,
  ip?: string,
): Promise<{
  user: UserRow;
  license: LicenseKeyRow;
  message: string;
  status: SubscriptionStatusResult;
}> {
  const cleanKey = rawKey.trim().toUpperCase();
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [license] = await tx
      .update(licenseKeys)
      .set({ status: 'redeemed', isActive: false })
      .where(
        and(
          eq(licenseKeys.key, cleanKey),
          eq(licenseKeys.status, 'active'),
          eq(licenseKeys.isActive, true),
          or(isNull(licenseKeys.expiresAt), gt(licenseKeys.expiresAt, now)),
        ),
      )
      .returning();

    if (!license) {
      const [existing] = await tx
        .select()
        .from(licenseKeys)
        .where(eq(licenseKeys.key, cleanKey))
        .limit(1);

      if (!existing) throw new Error('Clave de licencia no encontrada');
      if (existing.status === 'redeemed') {
        throw new Error('Esta clave de licencia ya ha sido canjeada');
      }
      if (existing.status === 'revoked') {
        throw new Error('Esta clave de licencia ha sido revocada');
      }
      if (existing.expiresAt && new Date(existing.expiresAt) < now) {
        throw new Error('Esta clave de licencia ha expirado');
      }
      throw new Error('Esta clave de licencia no está disponible para canje');
    }

    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new Error('Usuario no encontrado');

    const keyPlan = normalizePlan(license.plan);
    const keyPlanName = license.customPlanName?.trim() || PLAN_CONFIGS[keyPlan].name;
    const patch: Partial<typeof users.$inferInsert> = {
      updatedAt: now,
      // Cada clave define el paquete resultante. NULL vuelve a los límites
      // del plan base; así una clave fija no hereda privilegios de una
      // licencia personalizada anterior.
      customPlanName: license.customPlanName ?? null,
      maxProfiles: license.maxProfiles ?? null,
      maxSessions: license.maxSessions ?? null,
      maxApiKeys: license.maxApiKeys ?? null,
    };
    let message: string;

    if (license.durationDays === -1) {
      patch.plan = keyPlan;
      patch.isLifetime = true;
      patch.planExpiresAt = null;
      patch.planUpgradedAt = now;
      message = `¡Felicidades! Has activado una membresía VITALICIA de ${keyPlanName}.`;
    } else {
      patch.isLifetime = false;
      const currentNormalized = normalizePlan(user.plan);

      if (
        currentNormalized === keyPlan &&
        user.planExpiresAt &&
        new Date(user.planExpiresAt) > now
      ) {
        // Milisegundos, no setDate: hay claves de 5 horas (0.2083 días).
        const currentExpiry = new Date(
          user.planExpiresAt.getTime() + license.durationDays * 86_400_000,
        );
        patch.planExpiresAt = currentExpiry;
        message = `Tu plan ${keyPlanName} ha sido extendido por ${license.durationDays} días más.`;
      } else {
        patch.plan = keyPlan;
        patch.planUpgradedAt = now;
        const newExpiry = new Date(now.getTime() + license.durationDays * 86_400_000);
        patch.planExpiresAt = newExpiry;
        message = `¡Has activado el plan ${keyPlanName} por ${license.durationDays} días!`;
      }
    }

    if (license.role === 'admin' && !user.isAdmin) {
      patch.isAdmin = true;
      patch.role = 'admin';
    } else if (
      (license.role === 'seller' || (license.role as string) === 'reseller') &&
      user.role === 'user'
    ) {
      patch.role = 'seller';
    }

    const [updatedUser] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, user.id))
      .returning();

    const [updatedLicense] = await tx
      .update(licenseKeys)
      .set({ redeemedBy: user.id, redeemedAt: now })
      .where(eq(licenseKeys.id, license.id))
      .returning();

    return { user: updatedUser, license: updatedLicense, message };
  });

  await logActivity(
    db,
    result.user.id,
    'redeem_license',
    'license',
    result.license.id,
    {
      // No guardar la clave completa en el log de actividad: es un secreto
      // reutilizable y el log lo consultan administradores/revendedores.
      licenseId: result.license.id,
      keyPrefix: cleanKey.slice(0, 8),
      plan: normalizePlan(result.license.plan),
      durationDays: result.license.durationDays,
    },
    ip,
  );

  return {
    ...result,
    status: getSubscriptionStatus(result.user),
  };
}

export function getSubscriptionStatus(user: UserRow): SubscriptionStatusResult {
  const normalized = normalizePlan(user.plan);
  const basePlan = PLAN_CONFIGS[normalized];
  const limits = getEffectiveLimits(user);
  const planName = getEffectivePlanName(user);
  const planConfig: PlanDefinition = {
    ...basePlan,
    name: planName,
    limits,
  };

  let daysRemaining: number | null = null;
  let isExpired = false;

  if (user.isLifetime) {
    daysRemaining = null;
  } else if (user.planExpiresAt) {
    const diffMs = new Date(user.planExpiresAt).getTime() - Date.now();
    if (diffMs <= 0) {
      isExpired = true;
      daysRemaining = 0;
    } else {
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }
  }

  return {
    plan: user.plan,
    normalizedPlan: normalized,
    planName: planConfig.name,
    planTagline: planConfig.tagline,
    planBadgeColor: planConfig.badgeColor,
    planUpgradedAt: user.planUpgradedAt,
    planExpiresAt: user.planExpiresAt,
    isLifetime: Boolean(user.isLifetime),
    isExpired,
    daysRemaining,
    limits: planConfig.limits,
    planDetails: planConfig,
  };
}

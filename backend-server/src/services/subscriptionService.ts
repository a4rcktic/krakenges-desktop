import User, { IUser } from '../models/User';
import LicenseKey, { ILicenseKey } from '../models/LicenseKey';
import { normalizePlan, PLAN_CONFIGS, PlanDefinition, PlanLimits } from '../config/plans';
import { logActivity } from './activityLog';

export interface SubscriptionStatusResult {
  plan: string;
  normalizedPlan: 'ghost' | 'shadow' | 'specter' | 'phantom';
  planName: string;
  planTagline: string;
  planBadgeColor: string;
  planUpgradedAt?: Date;
  planExpiresAt?: Date | null;
  isLifetime: boolean;
  isExpired: boolean;
  daysRemaining: number | null; // null if lifetime or ghost
  limits: PlanLimits;
  planDetails: PlanDefinition;
}

/**
 * Checks if the user's paid subscription has expired.
 * If expired, automatically downgrades to 'ghost' plan and logs the event.
 */
export async function checkAndHandleSubscriptionExpiry<T extends IUser>(user: T, ip?: string): Promise<T> {
  if (user.isLifetime) {
    return user;
  }

  const normalized = normalizePlan(user.plan);
  if (normalized === 'ghost') {
    return user;
  }

  if (user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
    const previousPlan = user.plan;
    user.plan = 'ghost';
    user.planExpiresAt = null;
    user.isLifetime = false;
    await user.save();

    await logActivity(
      user._id,
      'subscription_expired',
      'user',
      user._id.toString(),
      { previousPlan, newPlan: 'ghost' },
      ip
    );
  }

  return user;
}

/**
 * Redeems an active license key for a user and applies the plan and duration.
 */
export async function redeemLicenseKey(
  userId: string,
  rawKey: string,
  ip?: string
): Promise<{ user: IUser; license: ILicenseKey; message: string; status: SubscriptionStatusResult }> {
  const cleanKey = rawKey.trim().toUpperCase();

  // Atomically lock and mark the license key as redeemed to prevent race conditions
  const license = await LicenseKey.findOneAndUpdate(
    {
      key: cleanKey,
      status: 'active',
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    },
    {
      $set: {
        status: 'redeemed',
        isActive: false,
      },
    },
    { new: true }
  );

  if (!license) {
    const existing = await LicenseKey.findOne({ key: cleanKey });
    if (!existing) throw new Error('Clave de licencia no encontrada');
    if (existing.status === 'redeemed') throw new Error('Esta clave de licencia ya ha sido canjeada');
    if (existing.status === 'revoked') throw new Error('Esta clave de licencia ha sido revocada');
    if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
      throw new Error('Esta clave de licencia ha expirado');
    }
    throw new Error('Esta clave de licencia no está disponible para canje');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new Error('Usuario no encontrado');
  }

  const keyPlan = normalizePlan(license.plan);
  const now = new Date();
  let message = '';

  if (license.durationDays === -1) {
    // Lifetime subscription
    user.plan = keyPlan;
    user.isLifetime = true;
    user.planExpiresAt = null;
    user.planUpgradedAt = now;
    message = `¡Felicidades! Has activado una membresía VITALICIA de ${PLAN_CONFIGS[keyPlan].name}.`;
  } else {
    // Timed subscription
    user.isLifetime = false;
    const currentNormalized = normalizePlan(user.plan);

    if (
      currentNormalized === keyPlan &&
      user.planExpiresAt &&
      new Date(user.planExpiresAt) > now
    ) {
      // Same plan: stack / extend existing days!
      const currentExpiry = new Date(user.planExpiresAt);
      currentExpiry.setDate(currentExpiry.getDate() + license.durationDays);
      user.planExpiresAt = currentExpiry;
      message = `Tu plan ${PLAN_CONFIGS[keyPlan].name} ha sido extendido por ${license.durationDays} días más.`;
    } else {
      // New plan or expired plan: start countdown from now
      user.plan = keyPlan;
      user.planUpgradedAt = now;
      const newExpiry = new Date(now);
      newExpiry.setDate(newExpiry.getDate() + license.durationDays);
      user.planExpiresAt = newExpiry;
      message = `¡Has activado el plan ${PLAN_CONFIGS[keyPlan].name} por ${license.durationDays} días!`;
    }
  }

  // If the key has special role elevation
  if (license.role === 'admin' && !user.isAdmin) {
    user.isAdmin = true;
    user.role = 'admin';
  } else if ((license.role === 'seller' || (license.role as string) === 'reseller') && user.role === 'user') {
    user.role = 'seller';
  }

  await user.save();

  // Mark license as redeemed
  license.status = 'redeemed';
  license.isActive = false;
  license.redeemedBy = user._id;
  license.redeemedAt = now;
  await license.save();

  await logActivity(
    user._id,
    'redeem_license',
    'license',
    license._id.toString(),
    { key: cleanKey, plan: keyPlan, durationDays: license.durationDays },
    ip
  );

  const status = getSubscriptionStatus(user);
  return { user, license, message, status };
}

/**
 * Calculates human-friendly subscription status and limits for a user.
 */
export function getSubscriptionStatus(user: IUser): SubscriptionStatusResult {
  const normalized = normalizePlan(user.plan);
  const planConfig = PLAN_CONFIGS[normalized];

  let daysRemaining: number | null = null;
  let isExpired = false;

  if (user.isLifetime) {
    daysRemaining = null;
  } else if (user.planExpiresAt) {
    const now = new Date();
    const expiry = new Date(user.planExpiresAt);
    const diffMs = expiry.getTime() - now.getTime();
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
    isLifetime: !!user.isLifetime,
    isExpired,
    daysRemaining,
    limits: planConfig.limits,
    planDetails: planConfig,
  };
}

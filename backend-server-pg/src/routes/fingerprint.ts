import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { and, eq } from 'drizzle-orm';
import { profiles } from '../db/schema';
import { dbOf } from '../db/context';
import { authenticate } from '../middleware/auth';
import {
  computeFingerprint,
  countryGeo,
  resolveOs,
  isOsKey,
} from '../services/fingerprintService';
import { asyncHandler } from '../utils/asyncHandler';
import { isValidId } from '../services/profileService';

const router = Router();

function devicePlatform(req: { headers: Record<string, unknown> }): string | null {
  // `x-maskos-platform` es la cabecera legacy que usa el cliente histórico.
  // Se acepta también el nombre nuevo para no romper builds futuros.
  const raw =
    req.headers['x-maskos-platform'] ??
    req.headers['x-krakenges-platform'];
  return typeof raw === 'string' ? raw : null;
}

const fingerprintLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/',
  authenticate,
  fingerprintLimiter,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        profileId: z.string().min(1),
        os: z.string().optional(),
        country: z.string().length(2).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'profileId inválido' });
    }
    if (!isValidId(parsed.data.profileId)) {
      return res.status(400).json({ error: 'profileId inválido' });
    }

    if (parsed.data.os !== undefined && !isOsKey(parsed.data.os)) {
      return res.status(400).json({ error: `os no válido: "${parsed.data.os}"` });
    }

    const db = dbOf(req);
    const [profile] = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, parsed.data.profileId), eq(profiles.userId, req.user!.id)))
      .limit(1);

    if (!profile) {
      return res.status(404).json({ error: 'Perfil no encontrado o sin acceso' });
    }

    const resolved = resolveOs({
      profileId: profile.id,
      stored: isOsKey(profile.os) ? profile.os : null,
      requested: parsed.data.os,
      device: devicePlatform(req),
    });

    // Se fija el SO la primera vez para que la huella sea estable.
    if (!profile.os) {
      await db
        .update(profiles)
        .set({ os: resolved.os, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
    }

    const fp = computeFingerprint(profile.id, resolved.os);
    const country = (parsed.data.country || '').toUpperCase().trim();
    if (country) {
      const geo = countryGeo.get(country);
      if (geo) {
        fp.identity.timezone = geo.timezone;
        fp.identity.language = geo.language;
      }
    }

    res.json({ ...fp, osSource: resolved.source });
  }),
);

export default router;

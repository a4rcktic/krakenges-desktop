import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import Profile from '../models/Profile';
import { authenticate } from '../authMiddleware';
import {
  computeFingerprint,
  countryGeo,
  resolveOs,
  isOsKey,
} from '../services/fingerprintService';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/**
 * SO real de la máquina, si el cliente lo declara en la cabecera.
 *
 * Es un RESPALDO, no la fuente principal: lo natural es mandar `os` en el
 * cuerpo. Esta cabecera existe para los clientes que no alcanzan a mandar el
 * cuerpo (peticiones sin JSON) y para integraciones por API key.
 *
 * No se deduce del User-Agent: el producto es justamente un emulador, así que
 * el UA que manda el cliente es el de la huella que quiere, no el de su
 * máquina. Usarlo aquí sería leer la respuesta como si fuera la pregunta.
 */
function devicePlatform(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers['x-krakenges-platform'];
  return typeof raw === 'string' ? raw : null;
}

// Límite dedicado: impedir enumerar el catálogo (receta server-side).
const fingerprintLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/fingerprint { profileId, os?, country? } -> la receta de esa huella.
// Solo el dueño del perfil puede pedirla; el resultado es estable de por vida.
//
// `os` es OPCIONAL a proposito, no por pereza: los clientes ya instalados no lo
// mandan, y si fuera obligatorio el primer POST /fingerprint tras desplegar esto
// devolvería 400 y ningún perfil arrancaría. Sin él se resuelve como antes.
//
// El timezone se alinea con el país del egress SOLO si el cliente lo manda en
// `country`: CreepJS marca 'Timezone spoofed' cuando el tz del navegador no
// coincide con el país del IP de salida. Antes se usaba también el header
// CF-IPCountry, pero la app llama a esta API por su conexión directa, no por el
// proxy del perfil: ese header es el país REAL del usuario y la receta acababa
// con su zona horaria detrás de un proxy de otro país. El cliente de escritorio
// resuelve igualmente timezone e idioma desde la IP de salida al lanzar
// (launcher.rs, resolve_egress_geo). seed/os/identidad siguen siendo del perfil.
router.post('/', authenticate, fingerprintLimiter, asyncHandler(async (req, res) => {
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

  // Un 'os' que no es uno de los cinco se rechaza con 400 en vez de ignorarse.
  // Ignorarlo convertiría un error del cliente (un 'Windows' con mayúscula, un
  // 'mac') en un 200 con la identidad de otro sistema, y el fallo aparecería
  // semanas después como "este perfil se detecta".
  if (parsed.data.os !== undefined && !isOsKey(parsed.data.os)) {
    return res.status(400).json({ error: `os no válido: "${parsed.data.os}"` });
  }

  const profile = await Profile.findOne({ _id: parsed.data.profileId, userId: req.user!._id });
  if (!profile) {
    return res.status(404).json({ error: 'Perfil no encontrado o sin acceso' });
  }

  // El SO lo decide quien pide la huella, no el sorteo: el motor que se ejecuta
  // es el de la máquina del cliente, y su firma TLS no se puede falsificar desde
  // JS. Un perfil que se anuncie como Mac sobre un motor Linux se contradice en
  // la primera petición. Ver resolveOs() para el orden de preferencia.
  const resolved = resolveOs({
    profileId: profile.id,
    stored: profile.os,
    requested: parsed.data.os,
    device: devicePlatform(req),
  });

  // Se fija en el perfil la PRIMERA vez, elija el origen que elija (incluso el
  // sorteo). A partir de ahí manda `stored`: si no se guardara, dos peticiones
  // del mismo perfil podrían devolver sistemas distintos y la huella dejaría de
  // ser estable, que es lo único que la hace inservible para un antidetect.
  if (!profile.os) {
    profile.os = resolved.os;
    await profile.save();
  }

  const fp = computeFingerprint(profile.id, resolved.os);

  // De donde salio el SO, para que el cliente pueda explicarle al usuario por que
  // su perfil dice una cosa, y para no reenviar un 'os' distinto cada vez.
  const osSource = resolved.source;

  const country = (parsed.data.country || '').toUpperCase().trim();
  if (country) {
    // El país cambia timezone e idioma JUNTOS. Si se cambiara solo uno, un
    // egress sueco podría acabar con `Europe/Stockholm` + `es-ES`.
    const geo = countryGeo.get(country);
    if (geo) {
      fp.identity.timezone = geo.timezone;
      fp.identity.language = geo.language;
    }
  }

  res.json({ ...fp, osSource });
}));

export default router;
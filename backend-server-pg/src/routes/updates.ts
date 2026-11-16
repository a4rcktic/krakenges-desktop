import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const router = Router();

/**
 * Endpoint retirado.
 *
 * `/check` era el updater anterior al plugin nativo. Anunciaba una release
 * hardcodeada (versión, URLs y checksums de una compilación concreta) y un
 * changelog que ya no era cierto. Mantenerlo devolviendo datos viejos es peor
 * que retirarlo: el cliente podía descargar un artefacto que ya no existe.
 *
 * El escritorio usa `/manifest`, que lee el fichero firmado de la release.
 */
router.get('/check', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(410).json({
    error: 'El endpoint /api/updates/check está retirado. Usa /api/updates/manifest.',
    endpoint: '/api/updates/manifest',
  });
});

/**
 * Compara versiones semánticas "1.2.3".
 *
 * Antes hacía `map(Number)` a secas: con `?version=abc` salía NaN en cada
 * comparación, todas las comparaciones dan false y la función devolvía 0, o sea
 * "no hay actualización", sin decir nada. Ahora se validan las partes.
 */
function compareVersions(v1: string, v2: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => {
        const num = Number(n);
        return Number.isFinite(num) ? num : 0;
      });
  const p1 = parse(v1);
  const p2 = parse(v2);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/** `1.0.0`, opcionalmente con prefijo v y sufijo -beta. */
const VERSION_RE = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/;

/// Manifiesto del updater nativo de Tauri.
///
/// A diferencia de /check, este endpoint NO lleva las firmas hardcodeadas: las
/// lee de un fichero generado al publicar la release. Cada artefacto updater
/// (.tar.gz en Linux, .nsis.zip en Windows) va firmado con la clave Ed25519
/// del updater, y la firma es lo que Tauri verifica antes de instalar. Por eso
/// no puede estar en el codigo: cambia en cada build.
///
/// El fichero lo produce el paso de release del CI (tauri-action genera
/// latest.json con las firmas) y se copia aqui como updater-manifest.json.
/// Si no existe, se responde 204 y el cliente simplemente no ofrece actualizaciones,
/// en vez de ofrecer una que no se puede verificar.
///
/// Origen del manifiesto: https://schema.tauri.app/updater
// El cliente del updater manda platform, arch, current_version y el prefijo
// 'target'. Se validan para no construir rutas de fichero ni claves de objeto
// a partir de lo que llegue en la query.
const manifestSchema = z.object({
  platform: z.string().max(32).optional(),
  arch: z.string().max(32).optional(),
  current_version: z.string().max(32).regex(VERSION_RE, 'current_version mal formada').optional(),
  target: z.string().max(120).optional(),
});

const TARGET_RE = /^(linux|windows|darwin)-(x86_64|aarch64|i686|armv7)$/;

/** Acepta los alias que usan distintos clientes y devuelve el target de Tauri. */
function requestedTarget(data: {
  platform?: string;
  arch?: string;
  target?: string;
}): string | null {
  if (data.target && TARGET_RE.test(data.target)) {
    return data.target;
  }

  if (!data.platform) return null;

  let platform = data.platform;
  if (platform === 'win32' || platform === 'win64') platform = 'windows';
  if (platform !== 'linux' && platform !== 'windows' && platform !== 'darwin') {
    return null;
  }

  let arch = data.arch || 'x86_64';
  if (arch === 'x64' || arch === 'amd64') arch = 'x86_64';
  if (arch === 'arm64') arch = 'aarch64';
  if (arch === 'x86' || arch === 'i386') arch = 'i686';
  if (!['x86_64', 'aarch64', 'i686', 'armv7'].includes(arch)) {
    return null;
  }

  return `${platform}-${arch}`;
}

/** Ruta del manifiesto. La env var permite probar y desplegar sin tocar código. */
function manifestFilePath(): string {
  const configured = process.env.UPDATER_MANIFEST_PATH;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.join(__dirname, '..', '..', 'updater-manifest.json');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalDate(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

/**
 * Entrada de plataforma válida del formato nativo de Tauri.
 *
 * El plugin del updater pide el manifiesto sin `target` ni `current_version`
 * cuando el endpoint no lleva placeholders. En ese caso devolvemos todas las
 * plataformas para que el propio plugin elija la suya, pero solo si la entrada
 * tiene firma y URL. Una entrada incompleta no debe llegar al cliente.
 */
function validPlatformEntry(
  value: unknown,
): value is { signature: string; url: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return nonEmptyString(entry.signature) && nonEmptyString(entry.url);
}

router.get('/manifest', (req, res) => {
  // Un manifiesto cacheado puede ofrecer una versión retirada.
  res.set('Cache-Control', 'no-store');

  const parsed = manifestSchema.safeParse(req.query);
  if (!parsed.success) {
    // 400 y no 204: aquí sí hay un error del cliente que conviene que vea, al
    // contrario que una plataforma que simplemente no soportamos.
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const target = requestedTarget(parsed.data);
  const targetRequested = Boolean(
    parsed.data.target || parsed.data.platform || parsed.data.arch,
  );

  // Un target mal formado o una plataforma no soportada es un error del
  // cliente: 204. Si no viene ningún dato de plataforma, el plugin nativo está
  // pidiendo el manifiesto completo y elegirá su entrada él mismo.
  if (targetRequested && !target) {
    res.status(204).end();
    return;
  }

  const current = parsed.data.current_version ?? '0.0.0';
  const file = manifestFilePath();
  if (!fs.existsSync(file)) {
    res.status(204).end();
    return;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('[updates] updater-manifest.json no es JSON válido:', error);
    res.status(204).end();
    return;
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    console.error('[updates] updater-manifest.json no es un objeto.');
    res.status(204).end();
    return;
  }

  const root = manifest as Record<string, any>;
  const platforms = root.platforms;

  // Formato nativo de Tauri (latest.json): version/notes/pub_date arriba y
  // platforms[target] = { signature, url }.
  if (platforms && typeof platforms === 'object' && !Array.isArray(platforms)) {
    const version = nonEmptyString(root.version) ? root.version : '';
    if (!version || compareVersions(version, current) <= 0) {
      res.status(204).end();
      return;
    }

    const selected: Record<string, { signature: string; url: string }> = {};
    if (target) {
      const entry = (platforms as Record<string, unknown>)[target];
      if (!validPlatformEntry(entry)) {
        res.status(204).end();
        return;
      }
      selected[target] = { signature: entry.signature, url: entry.url };
    } else {
      // Sin target: manifiesto completo. El plugin de Tauri busca después
      // `linux-x86_64`/`windows-x86_64` (o el target con bundle) dentro de
      // `platforms`, así que aquí no hay que adivinar la plataforma.
      for (const [key, entry] of Object.entries(platforms)) {
        if (TARGET_RE.test(key) && validPlatformEntry(entry)) {
          selected[key] = { signature: entry.signature, url: entry.url };
        }
      }
      if (Object.keys(selected).length === 0) {
        res.status(204).end();
        return;
      }
    }

    const payload: Record<string, any> = {
      version,
      notes: typeof root.notes === 'string' ? root.notes : '',
      platforms: selected,
    };
    const pubDate = optionalDate(root.pub_date);
    if (pubDate) payload.pub_date = pubDate;

    res.json(payload);
    return;
  }

  // El formato antiguo normalizado no tiene una versión común en la raíz. Sin
  // target no se puede elegir una entrada sin ambigüedad.
  if (!target) {
    res.status(204).end();
    return;
  }

  // Formato antiguo normalizado: cada target lleva su propia versión.
  const legacy = root[target];
  if (
    !legacy ||
    typeof legacy !== 'object' ||
    !nonEmptyString(legacy.version) ||
    !nonEmptyString(legacy.signature) ||
    !nonEmptyString(legacy.url) ||
    compareVersions(legacy.version, current) <= 0
  ) {
    res.status(204).end();
    return;
  }

  const payload: Record<string, any> = {
    version: legacy.version,
    notes: typeof legacy.notes === 'string' ? legacy.notes : '',
    platforms: {
      [target]: { signature: legacy.signature, url: legacy.url },
    },
  };
  const pubDate = optionalDate(legacy.pub_date);
  if (pubDate) payload.pub_date = pubDate;

  res.json(payload);
});

export default router;

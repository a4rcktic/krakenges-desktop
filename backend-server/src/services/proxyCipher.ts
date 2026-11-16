import crypto from 'crypto';

/**
 * Cifrado en reposo del campo `proxy` de los perfiles.
 *
 * Objetivo: una fuga del VPS (DB dump, backup, admin comprometido) NO debe
 * exponer las credenciales de proxy user:password en texto plano.
 *
 * - AES-256-GCM. El token persistido tiene el formato `krakenges:v1:iv:tag:data`
 *   (base64) y se puede distinguir de los registros legacy en texto plano.
 * - La clave sale de `KRAKENGES_PROXY_ENCRYPTION_KEY`. Si no está, se deriva por
 *   SHA-256 de `SESSION_SECRET`/`JWT_SECRET` para no forzar una variable nueva
 *   en despliegues existentes (aun así, recomiendo definirla).
 * - `decryptProxy` devuelve registros legacy tal cual (migración tolerante);
 *   cada guardado posterior los recifra. Si no puede descifrar (clave cambió),
 *   devuelve undefined para no volver a enviar basura al cliente.
 */

const PREFIX = 'krakenges:v1:';

function readKey(): Buffer {
  const env = process.env.KRAKENGES_PROXY_ENCRYPTION_KEY;
  if (env) {
    if (env.startsWith('b64:')) {
      try {
        const bin = Buffer.from(env.slice(4), 'base64');
        if (bin.length === 32) return bin;
      } catch {
        /* se ignora y se deriva */
      }
    }
    return crypto.createHash('sha256').update(env).digest();
  }
  // Sin env var NO hay clave de cifrado válida. Antes caía en la constante
  // pública 'krakenges-proxy-dev-secret', que cualquiera con el repo podía usar
  // para descifrar los proxies.
  const fallback = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!fallback) {
    throw new Error(
      'Falta la clave de cifrado de proxy: define KRAKENGES_PROXY_ENCRYPTION_KEY (o SESSION_SECRET/JWT_SECRET).'
    );
  }
  return crypto.createHash('sha256').update(fallback).digest();
}

export function encryptProxy(plain: string | null | undefined): string | null | undefined {
  if (plain === undefined || plain === null) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', readKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decryptProxy(stored: string | null | undefined): string | null | undefined {
  if (stored === undefined || stored === null) return stored;
  if (!stored.startsWith(PREFIX)) return stored; // registro legacy en texto plano
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !dataB64) return undefined;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', readKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** ¿Está este proxy almacenado ya cifrado? */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}
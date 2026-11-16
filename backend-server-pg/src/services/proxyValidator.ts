import dns from 'dns';
import https from 'https';
import net from 'net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { URL } from 'url';

export interface ProxyValidationResult {
  valid: boolean;
  ip?: string;
  latencyMs?: number;
  error?: string;
}

const PROXY_TEST_HOST = 'api.ipify.org';
const PROXY_TEST_PATH = '/?format=json';

/**
 * Bloquea destinos internos en la validación de proxies.
 *
 * Sin esto, cualquier usuario autenticado podía hacer que el VPS abriera
 * conexiones TCP contra 127.0.0.1, la red privada o el endpoint de metadatos
 * del proveedor (169.254.169.254). El checker no debe ser un escáner interno.
 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice('::ffff:'.length);
      return net.isIPv4(mapped) ? isPrivateAddress(mapped) : true;
    }
    return (
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb') ||
      value.startsWith('ff') ||
      value.startsWith('2001:db8') ||
      value.startsWith('2002:')
    );
  }

  // Si no se puede clasificar, se bloquea.
  return true;
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

async function assertPublicProxyHost(hostname: string): Promise<void> {
  const host = stripBrackets(hostname);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error('El proxy apunta a una dirección privada o reservada.');
    }
    return;
  }

  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('El proxy resuelve a una dirección privada o reservada.');
  }
}

/**
 * `lookup` personalizado para el agente: vuelve a comprobar la IP en el
 * momento de conectar, cerrando la ventana de DNS rebinding entre la
 * validación y la conexión real.
 */
function safeLookup(
  hostname: string,
  options: unknown,
  callback: (...args: any[]) => void,
): void {
  const opts = typeof options === 'object' && options !== null ? options : {};
  dns.lookup(hostname, { ...(opts as dns.LookupOptions), all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const safe = addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (safe.length === 0) {
      callback(new Error('El proxy resuelve a una dirección privada o reservada.'));
      return;
    }
    if ((opts as dns.LookupOptions).all) {
      callback(null, safe);
    } else {
      callback(null, safe[0].address, safe[0].family);
    }
  });
}

interface EgressResult {
  ip?: string;
  latencyMs?: number;
  error?: string;
}

/**
 * Pide la IP de salida a través del proxy.
 *
 * Antes, cuando el proxy llevaba usuario y contraseña, se creaba un
 * HttpsProxyAgent y se descartaba: la petición salía directa y se devolvía
 * `valid: true` con la IP del host. Eso no validaba nada. Ahora toda petición
 * pasa por el agente y sólo se acepta una respuesta con una IP real.
 */
function fetchEgressIp(proxyUrl: string, timeoutMs: number): Promise<EgressResult> {
  return new Promise((resolve) => {
    const start = Date.now();

    let agent: HttpsProxyAgent<string>;
    try {
      agent = new HttpsProxyAgent(proxyUrl, {
        timeout: timeoutMs,
        lookup: safeLookup as any,
      });
    } catch (error) {
      resolve({ error: error instanceof Error ? error.message : 'Proxy inválido' });
      return;
    }

    const req = https.get(
      `https://${PROXY_TEST_HOST}${PROXY_TEST_PATH}`,
      { timeout: timeoutMs, agent },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const latencyMs = Date.now() - start;

          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            resolve({ error: `El proxy respondió HTTP ${res.statusCode}`, latencyMs });
            return;
          }

          try {
            const body = JSON.parse(data) as { ip?: unknown };
            if (typeof body.ip !== 'string' || body.ip.length === 0) {
              resolve({ error: 'El servicio de verificación no devolvió una IP', latencyMs });
              return;
            }
            resolve({ ip: body.ip, latencyMs });
          } catch {
            resolve({ error: 'Respuesta no válida del servicio de verificación', latencyMs });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Timeout' });
    });

    req.on('error', (err) => {
      resolve({ error: err.message });
    });
  });
}

export async function validateProxy(
  proxyUrl: string,
  timeoutMs: number = 10000,
): Promise<ProxyValidationResult> {
  try {
    const url = new URL(proxyUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, error: 'El proxy debe usar http:// o https://' };
    }

    await assertPublicProxyHost(url.hostname);

    const result = await fetchEgressIp(proxyUrl, timeoutMs);
    if (result.error || !result.ip) {
      return { valid: false, error: result.error ?? 'No se pudo obtener la IP de salida' };
    }

    return { valid: true, ip: result.ip, latencyMs: result.latencyMs };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid proxy URL',
    };
  }
}

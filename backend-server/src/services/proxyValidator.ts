import https from 'https';
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
      agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
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

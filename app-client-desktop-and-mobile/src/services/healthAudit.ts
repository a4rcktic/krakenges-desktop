/**
 * Salud del perfil: proxy y boveda de cookies.
 *
 * QUE MIDE Y QUE NO
 *
 * Este panel solo puede comprobar dos cosas desde el cliente:
 *   1. si el proxy responde,
 *   2. si la boveda local tiene cookies.
 *
 * Antes tambien "aprobaba" Web Workers, geometria de pantalla y WebRTC sin
 * ejecutar ninguna comprobacion, y comparaba el User-Agent del perfil con
 * `navigator.userAgent`, que es el del WebView de la app. Como el perfil no
 * guarda User-Agent, el resultado era el de la app, no el del perfil: podia
 * decir "Chrome/154 anomalo" (la regla marcaba >=140 como falso) o "OS
 * congruente" sin haber mirado la huella.
 *
 * La huella real se genera en el servidor y se aplica al lanzar. Hasta que
 * exista una medicion dentro de una sesion real, aqui se dice que no se ha
 * medido. No se inventa un 100 %.
 *
 * El score es, por tanto, un score de proxy + cookies, no un "anti-ban trust
 * score". La interfaz lo etiqueta asi.
 */

import { tauriService, type ProxyTestResult } from './tauri';
import { getProfileCookiesFromVault } from './mobileBrowser';

export interface AuditCheckItem {
  id: string;
  category: 'proxy' | 'congruence' | 'cookies' | 'security';
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  recommendation?: string;
}

export interface ProfileHealthReport {
  score: number; // 0 to 100, solo proxy + cookies
  rating: 'EXCELLENT' | 'FAIR' | 'HIGH_RISK';
  proxyResult?: ProxyTestResult;
  checks: AuditCheckItem[];
  summary: string;
}

export async function auditProfileHealth(profile: {
  id: string;
  name: string;
  proxy?: string;
  os?: string;
  userAgent?: string;
  timezone?: string;
}): Promise<ProfileHealthReport> {
  const checks: AuditCheckItem[] = [];
  let score = 100;

  // 1. PROXY
  let proxyResult: ProxyTestResult | undefined;
  if (!profile.proxy || !profile.proxy.trim()) {
    checks.push({
      id: 'proxy-missing',
      category: 'proxy',
      label: 'Sin Proxy Asignado',
      status: 'warn',
      detail: 'El perfil usara la IP publica de tu conexion actual.',
      recommendation: 'Asigna un proxy si necesitas separar la IP del perfil de la tuya.',
    });
    score -= 15;
  } else {
    try {
      proxyResult = await tauriService.testProxy(profile.proxy.trim());
      if (proxyResult && proxyResult.success) {
        // Sin `|| 120`: si el test no reporta latencia, se dice, no se inventa.
        const latency = proxyResult.latency_ms;
        const slow = typeof latency === 'number' && latency >= 400;
        checks.push({
          id: 'proxy-status',
          category: 'proxy',
          label: 'Conectividad de Proxy',
          status: slow ? 'warn' : 'pass',
          detail: [
            `Proxy online (${proxyResult.ip || 'IP no reportada'})`,
            typeof latency === 'number' ? `Latencia: ${latency}ms` : 'Latencia no reportada',
            `Pais: ${proxyResult.country || 'no reportado'}`,
          ].join(' · '),
          recommendation: slow ? 'La latencia es alta (>=400ms). Un proxy mas cercano reduce timeouts.' : undefined,
        });
        if (slow) score -= 5;
      } else {
        checks.push({
          id: 'proxy-failed',
          category: 'proxy',
          label: 'Proxy Fuera de Linea / Inaccesible',
          status: 'fail',
          detail: `Fallo de conexion: ${proxyResult?.error || 'sin respuesta'}`,
          recommendation: 'Verifica credenciales, host y puerto antes de iniciar el perfil.',
        });
        score -= 40;
      }
    } catch (e: any) {
      checks.push({
        id: 'proxy-error',
        category: 'proxy',
        label: 'Error al Probar Proxy',
        status: 'warn',
        detail: e?.message || 'No se pudo verificar el proxy.',
      });
      score -= 10;
    }
  }

  // 2. COOKIES
  const cookies = getProfileCookiesFromVault(profile.id);
  if (cookies.length === 0) {
    checks.push({
      id: 'cookies-empty',
      category: 'cookies',
      label: 'Boveda de Cookies Vacia',
      status: 'warn',
      detail: 'El perfil no tiene cookies guardadas. Empezara como navegador nuevo.',
      recommendation: 'Si el sitio exige sesion, inicia el perfil y deja que genere cookies antes de usarlo en produccion.',
    });
    score -= 10;
  } else {
    checks.push({
      id: 'cookies-seeded',
      category: 'cookies',
      label: `Boveda con ${cookies.length} Cookies`,
      status: 'pass',
      detail: 'Hay cookies almacenadas para este perfil.',
    });
  }

  // 3. LO QUE NO SE MIDE
  checks.push({
    id: 'fingerprint-unmeasured',
    category: 'security',
    label: 'Huella del Navegador No Medida',
    status: 'warn',
    detail: 'User-Agent, pantalla, WebGL, WebRTC y zona horaria se aplican al lanzar desde la receta del servidor; este panel no los inspecciona dentro de la sesion.',
    recommendation: 'No interpretes este score como garantia de indetectabilidad. Solo cubre proxy y cookies.',
  });

  score = Math.max(0, Math.min(100, score));
  let rating: ProfileHealthReport['rating'] = 'EXCELLENT';
  let summary = 'Proxy y cookies correctos. La huella del navegador no se ha medido.';

  if (score < 60) {
    rating = 'HIGH_RISK';
    summary = 'Proxy o cookies con problemas. El perfil puede fallar al iniciar.';
  } else if (score < 85) {
    rating = 'FAIR';
    summary = 'Hay advertencias de proxy o cookies. Revisalas antes de iniciar.';
  }

  return {
    score,
    rating,
    proxyResult,
    checks,
    summary,
  };
}

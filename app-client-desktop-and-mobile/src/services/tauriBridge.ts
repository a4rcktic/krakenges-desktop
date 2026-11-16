/**
 * Kraken Ges Tauri Bridge & Web Fallback Layer
 * 
 * Provides a unified, crash-proof abstraction over Tauri's IPC commands.
 * - In Desktop Tauri mode: executes native Rust commands via @tauri-apps/api/core.
 * - In Web Browser mode: transparently maps server commands to the REST API
 *   and provides graceful simulation stubs for hardware/browser automation.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  isMobileNative,
  launchMobileProfileTab,
  closeMobileProfileTab,
  getActiveMobileProfileId,
  getProfileCookiesFromVault,
  saveProfileCookiesToVault,
  clearProfileCookiesFromVault,
  getLiveCookiesForActiveProfile,
  KrakenGesSession,
  purgeAndSanitizeMobileSession,
  deleteMobileProfile,
  openMobileAirplaneSettings,
} from './mobileBrowser';
import { isTauri, coreInvoke } from './tauriCore';
import { secureStore } from './secureStore';
import { API_BASE_URL, BRAND } from '../config/brand.generated';

export { isTauri } from './tauriCore';

interface TokenStorage {
  accessToken: string | null;
  refreshToken: string | null;
}

async function getTokens(): Promise<TokenStorage> {
  if (typeof window === 'undefined') return { accessToken: null, refreshToken: null };
  const [accessToken, refreshToken] = await Promise.all([
    secureStore.get('krakenges_access_token'),
    secureStore.get('krakenges_refresh_token'),
  ]);
  return { accessToken, refreshToken };
}

async function setTokens(access?: string | null, refresh?: string | null): Promise<void> {
  if (typeof window === 'undefined') return;
  if (access !== undefined) {
    if (access) await secureStore.set('krakenges_access_token', access);
    else await secureStore.remove('krakenges_access_token');
  }
  if (refresh !== undefined) {
    if (refresh) await secureStore.set('krakenges_refresh_token', refresh);
    else await secureStore.remove('krakenges_refresh_token');
  }
}

function getProductionEndpoint(): string {
  // La marca y la URL viven en brand.config.json. VITE_API_BASE permite
  // apuntar a otro backend en un build concreto sin tocar código.
  return API_BASE_URL;
}

async function apiRequest(method: string, path: string, body?: any, retryOnAuth = true): Promise<any> {
  const { accessToken, refreshToken } = await getTokens();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  // Use Vite's local dev proxy (/api) only if running on desktop dev port 1420 (not in mobile Capacitor)
  const isLocalDev = !isMobileNative && typeof window !== 'undefined' && window.location.port === '1420';
  const baseUrl = isLocalDev ? '/api' : getProductionEndpoint();
  const fullUrl = `${baseUrl}${path}`;

  // Native Android/iOS: execute through native CapacitorHttp (bypasses Chromium CORS & localhost origin restrictions)
  if (isMobileNative) {
    try {
      const nativeRes = await CapacitorHttp.request({
        method,
        url: fullUrl,
        headers,
        data: body,
      });

      let data = nativeRes.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          data = { message: data };
        }
      }

      // Handle token refresh on 401
      if (nativeRes.status === 401 && retryOnAuth && refreshToken && !path.includes('/auth/login') && !path.includes('/auth/register') && !path.includes('/auth/refresh')) {
        try {
          const refreshRes = await CapacitorHttp.request({
            method: 'POST',
            url: `${baseUrl}/auth/refresh`,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            data: { refreshToken },
          });
          let refData = refreshRes.data;
          if (typeof refData === 'string') {
            try { refData = JSON.parse(refData); } catch {}
          }
          if (refreshRes.status >= 200 && refreshRes.status < 300 && refData?.accessToken) {
            await setTokens(refData.accessToken, refData.refreshToken);
            return await apiRequest(method, path, body, false);
          } else {
            await setTokens(null, null);
          }
        } catch {
          await setTokens(null, null);
        }
      }

      if (nativeRes.status >= 400) {
        let errorMsg = data?.error || data?.message || `Error HTTP ${nativeRes.status}`;
        if (errorMsg === 'Invalid credentials') {
          errorMsg = 'Usuario o contraseña incorrectos.';
        }
        throw new Error(errorMsg);
      }

      if (typeof window !== 'undefined') {
        localStorage.setItem('krakenges_last_active_time', String(Date.now()));
      }
      return data;
    } catch (err: any) {
      if (err?.message && !err.message.startsWith('Error de conexión') && !err.message.includes('Network') && !err.message.includes('Failed to fetch')) {
        throw err;
      }
      throw new Error(`Error de conexión con el servidor: ${err?.message || 'Servidor inaccesible'}`);
    }
  }

  // Web Browser / Dev fallback (standard fetch)
  let res: Response;
  try {
    res = await fetch(fullUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    throw new Error(`Error de conexión con el servidor: ${err?.message || 'Servidor inaccesible'}`);
  }

  // Handle Token Refresh on 401
  if (res.status === 401 && retryOnAuth && refreshToken && !path.includes('/auth/login') && !path.includes('/auth/register') && !path.includes('/auth/refresh')) {
    try {
      const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        await setTokens(refreshData.accessToken, refreshData.refreshToken);
        // Retry original request with renewed access token
        return await apiRequest(method, path, body, false);
      } else {
        await setTokens(null, null);
      }
    } catch {
      await setTokens(null, null);
    }
  }

  let data: any = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    let errorMsg = data?.error || data?.message || text || `Error HTTP ${res.status}`;
    if (errorMsg === 'Invalid credentials') {
      errorMsg = 'Usuario o contraseña incorrectos.';
    }
    throw new Error(errorMsg);
  }

  if (typeof window !== 'undefined') {
    localStorage.setItem('krakenges_last_active_time', String(Date.now()));
  }
  return data;
}

/**
 * Web emulation for commands when running outside Tauri runtime.
 */
async function webInvoke<T = any>(command: string, args: Record<string, any> = {}): Promise<T> {
  switch (command) {
    case 'server_login': {
      const res = await apiRequest('POST', '/auth/login', {
        username: args.username,
        password: args.password,
      });
      await setTokens(res.accessToken, res.refreshToken);
      if (res.user) {
        localStorage.setItem('krakenges_user', JSON.stringify(res.user));
        localStorage.setItem('krakenges_last_active_time', String(Date.now()));
      }
      return res.user as T;
    }

    case 'server_register': {
      const res = await apiRequest('POST', '/auth/register', {
        name: args.name,
        username: args.username,
        email: args.email || '',
        password: args.password,
        key: args.key,
      });
      await setTokens(res.accessToken, res.refreshToken);
      if (res.user) {
        localStorage.setItem('krakenges_user', JSON.stringify(res.user));
        localStorage.setItem('krakenges_last_active_time', String(Date.now()));
      }
      return res.user as T;
    }

    case 'server_get_current_user': {
      const cached = localStorage.getItem('krakenges_user');
      const { accessToken, refreshToken } = await getTokens();
      const lastActiveStr = localStorage.getItem('krakenges_last_active_time');
      const now = Date.now();
      const MAX_INACTIVITY_MS = 24 * 60 * 60 * 1000; // 24 horas máximo de inactividad

      // Expiración estricta por inactividad (> 24 horas)
      if (lastActiveStr) {
        const lastActive = parseInt(lastActiveStr, 10);
        if (!isNaN(lastActive) && now - lastActive > MAX_INACTIVITY_MS) {
          await setTokens(null, null);
          localStorage.removeItem('krakenges_user');
          localStorage.removeItem('krakenges_last_active_time');
          throw new Error('Sesión expirada por inactividad. Por favor inicia sesión de nuevo.');
        }
      }

      if (!accessToken && !refreshToken && !cached) {
        localStorage.removeItem('krakenges_user');
        localStorage.removeItem('krakenges_last_active_time');
        throw new Error('No hay sesión activa.');
      }

      try {
        const res = await apiRequest('GET', '/auth/ticket');
        if (res?.user) {
          localStorage.setItem('krakenges_user', JSON.stringify(res.user));
          localStorage.setItem('krakenges_last_active_time', String(now));
          return res.user as T;
        }
      } catch (err: any) {
        const errMsg = String(err?.message || '');
        // Si el servidor rechazó el token (401, 403, suspendido, credenciales inválidas, etc.):
        if (
          errMsg.includes('401') ||
          errMsg.includes('403') ||
          errMsg.includes('Invalid credentials') ||
          errMsg.includes('expir') ||
          errMsg.includes('suspend') ||
          errMsg.includes('Token') ||
          errMsg.includes('Sesión')
        ) {
          await setTokens(null, null);
          localStorage.removeItem('krakenges_user');
          localStorage.removeItem('krakenges_last_active_time');
          throw new Error('Sesión expirada o inválida. Por favor inicia sesión nuevamente.');
        }

        // Si fue una desconexión offline y la última actividad fue dentro de las 24 horas:
        if (cached && lastActiveStr) {
          const lastActive = parseInt(lastActiveStr, 10);
          if (!isNaN(lastActive) && now - lastActive <= MAX_INACTIVITY_MS) {
            return JSON.parse(cached) as T;
          }
        }

        await setTokens(null, null);
        localStorage.removeItem('krakenges_user');
        localStorage.removeItem('krakenges_last_active_time');
        throw new Error('No se pudo verificar la sesión. Inicia sesión de nuevo.');
      }

      if (cached && lastActiveStr) {
        const lastActive = parseInt(lastActiveStr, 10);
        if (!isNaN(lastActive) && now - lastActive <= MAX_INACTIVITY_MS) {
          return JSON.parse(cached) as T;
        }
      }

      await setTokens(null, null);
      localStorage.removeItem('krakenges_user');
      localStorage.removeItem('krakenges_last_active_time');
      throw new Error('Sesión expirada.');
    }

    case 'server_refresh_ticket': {
      try {
        const res = await apiRequest('GET', '/auth/ticket');
        if (res?.user) {
          localStorage.setItem('krakenges_user', JSON.stringify(res.user));
          localStorage.setItem('krakenges_last_active_time', String(Date.now()));
          return res.user as T;
        }
        return res as T;
      } catch (err: any) {
        const errMsg = String(err?.message || '');
        if (
          errMsg.includes('401') ||
          errMsg.includes('403') ||
          errMsg.includes('Invalid credentials') ||
          errMsg.includes('expir') ||
          errMsg.includes('suspend')
        ) {
          await setTokens(null, null);
          localStorage.removeItem('krakenges_user');
          localStorage.removeItem('krakenges_last_active_time');
        }
        throw err;
      }
    }

    case 'server_logout': {
      const { refreshToken } = await getTokens();
      if (refreshToken) {
        await apiRequest('POST', '/auth/logout', { refreshToken }).catch(() => {});
      }
      await setTokens(null, null);
      localStorage.removeItem('krakenges_user');
      localStorage.removeItem('krakenges_last_active_time');
      return null as T;
    }

    case 'server_get_dashboard': {
      return await apiRequest('GET', '/dashboard');
    }

    case 'server_get_public_content': {
      return await apiRequest('GET', '/content');
    }

    case 'server_content_admin_get': {
      return await apiRequest('GET', '/content/admin');
    }

    case 'server_content_preview': {
      return await apiRequest('POST', '/content/preview', args.content);
    }

    case 'server_content_publish': {
      return await apiRequest('PUT', '/content', args.content);
    }

    case 'server_content_history': {
      return await apiRequest('GET', '/content/history');
    }

    case 'server_content_revert': {
      return await apiRequest('POST', '/content/revert', { id: args.id });
    }

    case 'server_profiles_list': {
      return await apiRequest('GET', '/profiles');
    }

    case 'server_profiles_tags': {
      return await apiRequest('GET', '/profiles/tags');
    }

    case 'server_create_profile': {
      return await apiRequest('POST', '/profiles', {
        name: args.name,
        startUrl: args.startUrl || args.start_url,
        tags: args.tags,
        notes: args.notes,
        os: args.os,
      });
    }

    case 'server_update_profile_by_id': {
      const id = args.profileId || args.profile_id;
      return await apiRequest('PATCH', `/profiles/${id}`, {
        name: args.name,
        startUrl: args.startUrl || args.start_url,
        tags: args.tags,
        notes: args.notes,
        os: args.os,
      });
    }

    case 'server_delete_profile': {
      const id = args.profileId || args.profile_id;
      if (id) {
        await deleteMobileProfile(String(id));
      }
      return await apiRequest('DELETE', `/profiles/${id}`);
    }

    case 'server_fingerprint': {
      return await apiRequest('POST', '/fingerprint', { profileId: args.profileId || args.profile_id });
    }

    case 'server_sessions_list': {
      const query = args.status ? `?status=${args.status}` : '';
      return await apiRequest('GET', `/sessions${query}`);
    }

    case 'server_create_session':
    case 'server_start_session': {
      return await apiRequest('POST', '/sessions/start', { profileId: args.profileId || args.profile_id });
    }

    case 'server_stop_session': {
      const id = args.sessionId || args.session_id;
      return await apiRequest('POST', `/sessions/${id}/stop`);
    }

    case 'server_reactivate_session': {
      const id = args.sessionId || args.session_id;
      return await apiRequest('POST', `/sessions/${id}/reactivate`);
    }

    case 'server_delete_session': {
      const id = args.sessionId || args.session_id;
      return await apiRequest('DELETE', `/sessions/${id}`);
    }

    case 'server_redeem_key': {
      return await apiRequest('POST', '/membership/redeem', { key: args.key });
    }

    case 'server_membership_usage': {
      // Uso y vigencia reales de la cuenta. El panel de planes pintaba un
      // historial de activaciones inventado ("MSK-...-ACTIVE", "1 Licencia
      // Vigente") porque no consultaba nada; este endpoint ya existia en el
      // backend y solo faltaba exponerlo.
      return await apiRequest('GET', '/membership/usage');
    }

    case 'server_keys_list': {
      return await apiRequest('GET', '/keys');
    }

    case 'server_mint_keys': {
      return await apiRequest('POST', '/keys', {
        plan: args.plan,
        durationDays: args.durationDays ?? args.duration_days,
        count: args.count,
        tag: args.tag,
        role: args.role,
      });
    }

    case 'server_revoke_key': {
      const id = args.keyId || args.key_id;
      return await apiRequest('PATCH', `/keys/${id}`, { status: 'revoked' });
    }

    case 'server_delete_key': {
      const id = args.keyId || args.key_id;
      return await apiRequest('DELETE', `/keys/${id}`);
    }

    case 'server_users_list': {
      return await apiRequest('GET', '/users');
    }

    /* Funciones de administracion que la vista pedia pero el bridge no
       implementaba. La ruta existe en el backend (users.ts: /admin/backup y
       /admin/purge-sessions); faltaba el puente, de modo que "Purgar sesiones"
       y "Exportar datos" fallaban en silencio con un catch que devolvia null.

       El 404 de /cache se explica en la nota de mas abajo: no hay ruta de
       cache en el backend, asi que ese comando devuelve un error explicito en
       vez de fingir que se limpio algo. */
    case 'server_export_backup': {
      return await apiRequest('GET', '/users/admin/backup');
    }

    case 'server_purge_sessions': {
      return await apiRequest('POST', '/users/admin/purge-sessions');
    }

    case 'server_purge_cache': {
      // No existe ruta de purga de cache en el backend. Se devuelve un error
      // explicito en lugar de un exito falso: si algum dia se anade la ruta,
      // solo hay que cambiar esta linea.
      throw new Error('El backend no expone una ruta de purga de cache todavia.');
    }

    case 'server_ban_user': {
      const id = args.userId || args.user_id;
      return await apiRequest('PATCH', `/users/${id}/ban`, { banned: args.banned });
    }

    case 'server_delete_user': {
      const id = args.userId || args.user_id;
      return await apiRequest('DELETE', `/users/${id}`);
    }

    case 'server_assign_role': {
      const id = args.userId || args.user_id;
      return await apiRequest('PATCH', `/users/${id}/role`, {
        role: args.role,
        sellerCredits: args.sellerCredits ?? args.seller_credits,
      });
    }

    case 'server_change_plan': {
      const id = args.userId || args.user_id;
      return await apiRequest('PATCH', `/users/${id}/plan`, {
        plan: args.plan,
        durationDays: args.durationDays ?? args.duration_days,
        isLifetime: args.isLifetime ?? args.is_lifetime,
      });
    }

    case 'server_reset_password': {
      const id = args.userId || args.user_id;
      return await apiRequest('POST', `/users/${id}/reset-password`, { password: args.password });
    }

    case 'server_reset_hwid': {
      const id = args.userId || args.user_id;
      return await apiRequest('POST', `/users/${id}/reset-hwid`);
    }

    case 'server_get_analytics': {
      return await apiRequest('GET', '/users/admin/analytics');
    }

    case 'server_get_activity': {
      return await apiRequest('GET', '/activity');
    }

    case 'server_update_profile': {
      return await apiRequest('PATCH', '/users/me', { name: args.name });
    }

    case 'server_change_password': {
      return await apiRequest('POST', '/users/me/change-password', {
        currentPassword: args.currentPassword ?? args.current_password,
        newPassword: args.newPassword ?? args.new_password,
      });
    }

    case 'get_hwid': {
      if (isMobileNative) {
        try {
          const sys = await KrakenGesSession.getSystemInfo();
          return {
            hwid: `ANDROID-${sys.manufacturer}-${sys.model}`.toUpperCase().replace(/\s+/g, '-'),
            os_name: `Android ${sys.androidRelease} (${sys.model})`,
            kernel: `SDK ${sys.sdkInt} · ${sys.cpuCores} Cores`,
            cpu_count: sys.cpuCores,
          } as T;
        } catch {}
      }
      return {
        hwid: `${BRAND.slug.toUpperCase()}-HOST-RUNTIME`,
        os_name: typeof navigator !== 'undefined' ? navigator.platform : 'Linux',
        kernel: 'Capacitor/Chromium Host',
        cpu_count: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8,
      } as T;
    }

    case 'test_proxy_connection': {
      const proxyStr = String(args.proxy || '').trim();
      if (!proxyStr) {
        return {
          success: false,
          error: 'No se proporcionó proxy',
        } as T;
      }
      try {
        const res = await apiRequest('POST', '/profiles/validate-proxy', { proxy: proxyStr });
        return {
          success: Boolean(res.valid),
          latency_ms: res.latencyMs || 0,
          ip: res.ip || '',
          country: res.country || 'Verificado',
          country_code: res.countryCode || '',
          city: res.city || '',
          isp: res.isp || '',
          error: res.error,
          timezone: res.timezone,
          tz_offset_minutes: res.tzOffsetMinutes,
          latitude: res.latitude,
          longitude: res.longitude,
          suggested_language: res.suggestedLanguage || (res.countryCode ? `${res.countryCode.toLowerCase()}-${res.countryCode.toUpperCase()}` : undefined),
        } as T;
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Error al validar proxy',
        } as T;
      }
    }

    case 'parse_proxy_string': {
      const str = String(args.proxy || '');
      const parts = str.split(':');
      return {
        protocol: 'http',
        host: parts[0] || '127.0.0.1',
        port: parseInt(parts[1], 10) || 8080,
        username: parts[2] || undefined,
        password: parts[3] || undefined,
      } as T;
    }

    case 'launch_isolated_profile': {
      if (isMobileNative) {
        const config = (args && args.config) || {};
        return (await launchMobileProfileTab(config)) as T;
      }
      console.log('[Web Dev Mode] Simulated launch of isolated profile:', args);
      return (Math.floor(Math.random() * 9000) + 1000) as T;
    }

    case 'close_profile': {
      if (isMobileNative) {
        return (await closeMobileProfileTab()) as T;
      }
      return true as T;
    }

    case 'is_profile_running': {
      const profileId = String((args && args.profileId) || '');
      if (isMobileNative) {
        return (getActiveMobileProfileId() === profileId) as T;
      }
      return false as T;
    }

    case 'browser_get_cookies': {
      const profileId = String((args && args.profileId) || '');
      let cookies = getProfileCookiesFromVault(profileId);
      if (isMobileNative && getActiveMobileProfileId() === profileId) {
        try {
          const live = await getLiveCookiesForActiveProfile();
          if (live && live.length > 0) {
            cookies = live;
          }
        } catch {}
      }
      return {
        success: true,
        cookies,
        count: cookies.length,
      } as T;
    }

    case 'browser_set_cookies': {
      const profileId = String((args && args.profileId) || '');
      const cookies = Array.isArray(args && args.cookies) ? args.cookies : [];
      saveProfileCookiesToVault(profileId, cookies);
      if (isMobileNative && getActiveMobileProfileId() === profileId) {
        // El navegador aislado inyecta la bóveda al abrir. Inyectar en caliente
        // requeriría hablar con el proceso :browser; se aplica al reabrir.
        console.warn('[TauriBridge] Las cookies se aplicarán al reabrir el perfil activo.');
      }
      return {
        success: true,
        count: cookies.length,
      } as T;
    }

    case 'browser_clear_cookies': {
      const profileId = String((args && args.profileId) || '');
      if (isMobileNative && profileId) {
        // Si el perfil está abierto, primero se cierra para que el proceso
        // :browser suelte el sandbox. El cierre persiste las cookies finales,
        // así que la bóveda se limpia después, no antes.
        if (getActiveMobileProfileId() === profileId) {
          await closeMobileProfileTab();
        }
        clearProfileCookiesFromVault(profileId);
        // Solo se vacían las cookies/almacenamiento del perfil. No se llama a
        // deleteMobileProfile(): la identidad del perfil no se toca.
        await purgeAndSanitizeMobileSession(profileId);
      } else {
        clearProfileCookiesFromVault(profileId);
      }
      return { success: true } as T;
    }

    case 'get_hardware_info': {
      // En navegador no se puede leer la GPU real del sistema. Se devuelven
      // solo datos que el propio navegador expone; la GPU queda vacía y la
      // vista muestra "—" en vez de inventar un modelo.
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const platform = /Android/i.test(ua)
        ? 'android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'ios'
          : /Windows/i.test(ua)
            ? 'windows'
            : /Macintosh|Mac OS X/i.test(ua)
              ? 'macos'
              : /Linux/i.test(ua)
                ? 'linux'
                : 'unknown';
      return {
        cpu: null,
        cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || null : null,
        gpu: null,
        platform,
        distro: null,
      } as T;
    }

    case 'get_guard_status': {
      return { active: true, mode: 'strict' } as T;
    }

    case 'open_mobile_airplane_settings': {
      return (await openMobileAirplaneSettings()) as T;
    }

    case 'check_engine_status': {
      return {
        is_dedicated: isMobileNative,
        path: isMobileNative ? 'Android System WebView (Isolated ProfileStore)' : null,
        installed: isMobileNative,
        version: isMobileNative ? 'Android WebView Stealth Core' : 'Navegador Web',
        platform: isMobileNative ? 'android' : 'web',
      } as T;
    }

    case 'install_dedicated_engine': {
      return (isMobileNative ? 'Motor Android WebView integrado' : 'Motor listo') as T;
    }

    case 'check_app_update': {
      // En navegador no hay updater nativo. No se inventa una versión nueva.
      return { available: false, version: '', notes: '', date: '' } as T;
    }

    case 'install_app_update': {
      throw new Error(
        'La instalación de actualizaciones solo está disponible en la app de escritorio.',
      );
    }

    case 'create_embedded_browser':
    case 'resize_embedded_browser':
    case 'close_embedded_browser': {
      return { success: true } as T;
    }

    default: {
      console.warn(`[Tauri Bridge] Comando no emulado en web: "${command}"`, args);
      return {} as T;
    }
  }
}

/**
 * Universal invoke dispatcher.
 * Automatically delegates to Tauri IPC if running inside desktop,
 * or to REST API / local stubs if running in browser.
 */
export async function invoke<T = any>(command: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    try {
      return await coreInvoke<T>(command, args ?? {});
    } catch (err) {
      console.error(`[Tauri IPC Error] Command "${command}" failed:`, err);
      throw err;
    }
  }

  return await webInvoke<T>(command, args ?? {});
}

/**
 * Escucha un evento emitido por el backend Rust.
 *
 * En web no hay bus de eventos de Tauri, así que la función se registra pero no
 * hace nada: el llamante debe comprobar `isTauri` antes de depender de ella.
 * Devuelve la función de baja, para limpiar el listener al desmontar.
 */
export async function listen<T = any>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (!isTauri) {
    return () => {};
  }
  try {
    const { listen: coreListen } = await import('@tauri-apps/api/event');
    const unlisten = await coreListen<T>(event, (e) => handler(e.payload));
    return unlisten;
  } catch (err) {
    console.error(`[Tauri Event Error] No se pudo escuchar "${event}":`, err);
    return () => {};
  }
}

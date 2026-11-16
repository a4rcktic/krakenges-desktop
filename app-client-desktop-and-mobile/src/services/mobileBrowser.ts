import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { LaunchConfig } from './tauri';
import { invoke } from './tauriBridge';
import { getBranding } from '../config/branding';


export const isMobileNative = typeof window !== 'undefined' && Capacitor.isNativePlatform();

export interface MobileSystemInfo {
  webViewVersion: string;
  webViewPackage: string;
  manufacturer: string;
  model: string;
  brand: string;
  device: string;
  androidRelease: string;
  sdkInt: number;
  sandboxReady: boolean;
  freeStorageMb: number;
  cpuCores: number;
  maxMemoryMb: number;
  multiProfileSupported: boolean;
}

export interface KrakenGesSessionPluginInterface {
  clearAllSessionData(options?: { profileId?: string }): Promise<void>;
  deleteProfile(options: { profileId: string }): Promise<{ success: boolean; reason?: string }>;
  injectCookies(options: { profileId?: string; cookies: any[] }): Promise<void>;
  getCookiesForDomains(options: { profileId?: string; domains: string[] }): Promise<{ cookies: any[]; count?: number; discoveredHosts?: string[] }>;
  getAllCookies(options?: { profileId?: string; domains?: string[] }): Promise<{ cookies: any[]; count: number; discoveredHosts: string[] }>;
  getSystemInfo(): Promise<MobileSystemInfo>;
  openAirplaneSettings(): Promise<void>;
  flushSession(options?: { profileId?: string }): Promise<{ success: boolean }>;
}

export const KrakenGesSession = registerPlugin<KrakenGesSessionPluginInterface>('KrakenGesSession');

export interface ProfileBrowserPluginInterface {
  isAvailable(): Promise<{
    available: boolean;
    sdkInt: number;
    webViewPackage?: string;
    webViewVersion?: string;
  }>;
  open(options: {
    profileId: string;
    url: string;
    title?: string;
    proxy?: string;
    userAgent?: string;
    cookies?: any[];
    domains?: string[];
  }): Promise<{ success: boolean; profileId: string }>;
  close(): Promise<{ success: boolean }>;
  getSessionResult(options: {
    profileId: string;
    consume?: boolean;
  }): Promise<{ cookies: any[]; count: number; finalUrl?: string | null; pageLoaded?: boolean; updatedAt?: number }>;
  clearProfileData(options: { profileId: string }): Promise<{ success: boolean }>;
  addListener(
    eventName: 'browserClose',
    listenerFunc: (event: { profileId: string; resultPath?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'browserUrlChange',
    listenerFunc: (event: { profileId: string; url: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'browserError',
    listenerFunc: (event: { profileId: string; message: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const ProfileBrowser = registerPlugin<ProfileBrowserPluginInterface>('ProfileBrowser');

const VAULT_COOKIES_PREFIX = 'krakenges_isolated_cookies_';
const VAULT_DOMAINS_PREFIX = 'krakenges_visited_domains_';

let activeMobileProfileId: string | null = null;
let activeMobileSessionId: string | null = null;
let activeProfileDomains: Set<string> = new Set();
let closeListenerHandle: PluginListenerHandle | null = null;
let urlChangeListenerHandle: PluginListenerHandle | null = null;
let errorListenerHandle: PluginListenerHandle | null = null;

export function getActiveMobileProfileId(): string | null {
  return activeMobileProfileId;
}

export async function getMobileSystemInfo(): Promise<MobileSystemInfo> {
  if (!isMobileNative) {
    // No se inventan datos de un WebView Android que no existe. El panel de
    // escritorio debe mostrar "no aplica", no un motor falso.
    return {
      webViewVersion: 'No aplica (escritorio)',
      webViewPackage: 'No aplica',
      manufacturer: 'Desktop',
      model: typeof navigator !== 'undefined' ? navigator.platform : 'Unknown',
      brand: getBranding().appName,
      device: 'Host',
      androidRelease: 'No aplica',
      sdkInt: 0,
      sandboxReady: false,
      freeStorageMb: 0,
      cpuCores: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 0) : 0,
      maxMemoryMb: 0,
      multiProfileSupported: false,
    };
  }
  try {
    return await KrakenGesSession.getSystemInfo();
  } catch (err) {
    console.warn('[Session System Info] No se pudo leer la información real:', err);
    // Fallback honesto: no hay datos, no se simulan.
    return {
      webViewVersion: 'No disponible',
      webViewPackage: 'No disponible',
      manufacturer: 'Desconocido',
      model: 'Desconocido',
      brand: 'Desconocido',
      device: 'Desconocido',
      androidRelease: 'Desconocido',
      sdkInt: 0,
      sandboxReady: false,
      freeStorageMb: 0,
      cpuCores: 0,
      maxMemoryMb: 0,
      multiProfileSupported: false,
    };
  }
}

/**
 * Reads persisted cookies from the profile's local isolated storage vault.
 */
export function getProfileCookiesFromVault(profileId: string): any[] {
  if (!profileId) return [];
  try {
    const raw = localStorage.getItem(VAULT_COOKIES_PREFIX + profileId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[Session Vault] Error loading cookies for profile:', profileId, err);
    return [];
  }
}

/**
 * Saves cookies into the profile's local isolated storage vault.
 */
export function saveProfileCookiesToVault(profileId: string, cookies: any[]): void {
  if (!profileId || !Array.isArray(cookies)) return;
  try {
    localStorage.setItem(VAULT_COOKIES_PREFIX + profileId, JSON.stringify(cookies));
    console.log(`[Session Vault] Saved ${cookies.length} cookies for profile:`, profileId);
  } catch (err) {
    console.error('[Session Vault] Error saving cookies for profile:', profileId, err);
  }
}

/**
 * Clears a profile's isolated cookies and visited domains vault.
 */
export function clearProfileCookiesFromVault(profileId: string): void {
  if (!profileId) return;
  try {
    localStorage.removeItem(VAULT_COOKIES_PREFIX + profileId);
    localStorage.removeItem(VAULT_DOMAINS_PREFIX + profileId);
    console.log('[Session Vault] Cleared vault for profile:', profileId);
  } catch (err) {
    console.error('[Session Vault] Error clearing vault for profile:', profileId, err);
  }
}

/**
 * Reads tracked domains for a given profile.
 */
export function getProfileDomainsFromVault(profileId: string): string[] {
  if (!profileId) return [];
  try {
    const raw = localStorage.getItem(VAULT_DOMAINS_PREFIX + profileId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Saves tracked domains for a given profile.
 */
export function saveProfileDomainsToVault(profileId: string, domains: string[]): void {
  if (!profileId || !Array.isArray(domains)) return;
  try {
    localStorage.setItem(VAULT_DOMAINS_PREFIX + profileId, JSON.stringify(Array.from(new Set(domains))));
  } catch {}
}

/**
 * Complete hardware and web storage sanitization.
 * Synchronously purges isolated profile sandbox and global WebView state.
 */
export async function purgeAndSanitizeMobileSession(profileId: string): Promise<void> {
  if (!isMobileNative || !profileId) return;
  console.log('[Session Isolation] Purging isolated browser sandbox for profile:', profileId);
  // El navegador nativo guarda todo su estado (cookies, localStorage, IndexedDB,
  // caché HTTP, service workers) bajo un directorio propio por perfil. Borrar
  // ese directorio es la purga completa; no se toca el WebView de otros perfiles.
  try {
    await ProfileBrowser.clearProfileData({ profileId });
  } catch (e) {
    console.warn('[Session Isolation] ProfileBrowser.clearProfileData warning:', e);
    throw e;
  }
}

/**
 * Completely wipes an isolated profile sandbox from disk and removes vault data.
 */
export async function deleteMobileProfile(profileId: string): Promise<void> {
  if (!profileId) return;
  if (isMobileNative && activeMobileProfileId === profileId) {
    try {
      await closeMobileProfileTab();
    } catch {
      // Aunque el cierre falle, la bóveda y el sandbox se borran igualmente.
    }
  }
  clearProfileCookiesFromVault(profileId);
  if (isMobileNative) {
    try {
      await ProfileBrowser.clearProfileData({ profileId });
      // El plugin antiguo (ProfileStore) puede tener restos. Se intenta borrar
      // sin que un fallo de MULTI_PROFILE impida limpiar el sandbox nuevo.
      await KrakenGesSession.deleteProfile({ profileId }).catch(() => {});
      console.log('[Session Isolation] Deleted isolated profile sandbox:', profileId);
    } catch (e) {
      console.warn('[Session Isolation] Error deleting profile sandbox:', e);
    }
  }
}

/**
 * Harvests active cookies across ALL domains from the running session (via SQLite + Profile CookieManager),
 * flushes them to disk SQLite database, and saves them to the profile vault.
 */
export async function persistSessionAndPurge(profileId: string, domainsToHarvest?: Set<string>): Promise<void> {
  if (!profileId) return;
  console.log('[Session Isolation] Persisting session cookies for profile:', profileId);

  const domains = domainsToHarvest || activeProfileDomains;

  try {
    if (isMobileNative) {
      // El navegador nativo escribe un snapshot de cookies (y la URL final) en
      // un archivo propio del perfil. Al consumirlo se borra ese archivo, pero
      // el sandbox WebView lo purga la propia actividad al cerrarse.
      const res = await ProfileBrowser.getSessionResult({ profileId, consume: true });
      const liveCookies = res.cookies || [];
      // Solo se reemplaza la bóveda si el snapshot corresponde a una página
      // que llegó a cargar. Si la carga falló, se conserva lo que ya había.
      const hasFinalUrl = Boolean(res.finalUrl) && res.pageLoaded !== false;

      if (hasFinalUrl) {
        // Snapshot válido: la bóveda refleja el sandbox, no una unión con
        // cookies viejas. Así un logout borra de verdad la cookie.
        saveProfileCookiesToVault(profileId, liveCookies);
      } else if (liveCookies.length > 0) {
        // Sin URL final (snapshot incompleto): se conserva lo que ya había.
        const existing = getProfileCookiesFromVault(profileId);
        const cookieMap = new Map<string, any>();
        for (const c of existing) {
          const key = `${(c.domain || '').toLowerCase()}|${c.name}`;
          cookieMap.set(key, c);
        }
        for (const c of liveCookies) {
          const key = `${(c.domain || '').toLowerCase()}|${c.name}`;
          cookieMap.set(key, c);
        }
        saveProfileCookiesToVault(profileId, Array.from(cookieMap.values()));
      }

      if (res.finalUrl) {
        try {
          const finalUrl = new URL(res.finalUrl);
          if (finalUrl.hostname) {
            domains.add(finalUrl.hostname);
            domains.add(finalUrl.hostname.replace(/^www\./, ''));
          }
        } catch {
          // URL final no parseable; los dominios ya rastreados siguen valiendo.
        }
      }
      // No sobrescribir los dominios con un set vacío si el listener de cierre
      // ya persistió esta sesión y dejó activeProfileDomains limpio.
      if (domains.size > 0 || hasFinalUrl) {
        saveProfileDomainsToVault(profileId, Array.from(domains));
      }
    }
  } finally {
    // El estado local se limpia aunque falle la lectura del snapshot: la
    // actividad nativa ya se cerró y dejar activeMobileProfileId puesto
    // bloquearía la siguiente apertura.
    if (activeMobileProfileId === profileId) {
      activeMobileProfileId = null;
      activeProfileDomains.clear();
    }
    if (closeListenerHandle) {
      closeListenerHandle.remove();
      closeListenerHandle = null;
    }
    if (urlChangeListenerHandle) {
      urlChangeListenerHandle.remove();
      urlChangeListenerHandle = null;
    }
    if (errorListenerHandle) {
      errorListenerHandle.remove();
      errorListenerHandle = null;
    }
  }
}

/**
 * Retrieves live cookies for the currently active profile in the Android browser.
 */
export async function getLiveCookiesForActiveProfile(): Promise<any[]> {
  if (!isMobileNative || !activeMobileProfileId) {
    return activeMobileProfileId ? getProfileCookiesFromVault(activeMobileProfileId) : [];
  }
  try {
    const res = await ProfileBrowser.getSessionResult({
      profileId: activeMobileProfileId,
      consume: false,
    });
    return res.cookies || [];
  } catch {
    return getProfileCookiesFromVault(activeMobileProfileId);
  }
}

/**
 * Zona horaria de la IP con la que sale el dispositivo, como resolve_egress_geo
 * en proxy.rs. Solo proveedores HTTPS: el manifiesto tiene
 * usesCleartextTraffic=false y ip-api (HTTP) fallaría siempre en Android.
 * CapacitorHttp va por la red nativa, sin CORS. null si ninguno responde.
 */
async function resolveDeviceEgressGeo(): Promise<{ timezone: string; countryCode?: string } | null> {
  const providers: Array<{ url: string; pick: (d: any) => { timezone?: string; countryCode?: string } }> = [
    {
      url: 'https://get.geojs.io/v1/ip/geo.json',
      pick: (d) => ({ timezone: d?.timezone, countryCode: d?.country_code }),
    },
    {
      url: 'https://ipapi.co/json/',
      pick: (d) => ({ timezone: d?.timezone, countryCode: d?.country_code }),
    },
  ];
  for (const p of providers) {
    try {
      const res = await CapacitorHttp.get({ url: p.url, connectTimeout: 8000, readTimeout: 8000 });
      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      const { timezone, countryCode } = p.pick(data);
      if (res.status === 200 && typeof timezone === 'string' && timezone.includes('/')) {
        return { timezone, countryCode };
      }
    } catch {
      /* siguiente proveedor */
    }
  }
  return null;
}

/**
 * Mobile In-App Browser Tab Launcher for Kraken Ges
 * 100% Isolated Session:
 * 1. Deep-scrubs previous WebView state (ProfileStore + WebStorage).
 * 2. Injects ONLY the targeted profile's stored cookies into the profile sandbox.
 * 3. Tracks visited domains dynamically.
 * 4. Automatically commits updated cookies on exit and purges memory.
 */
export async function launchMobileProfileTab(config: LaunchConfig): Promise<number> {
  const profileId = String(config.profile_id);

  // Fail closed: el navegador nativo aislado necesita Android 9+ para usar
  // WebView.setDataDirectorySuffix(). Si no está disponible, no se abre nada:
  // abrir el WebView global daría una falsa sensación de aislamiento.
  if (isMobileNative) {
    const availability = await ProfileBrowser.isAvailable();
    if (!availability.available) {
      throw new Error(
        'Este dispositivo no soporta el navegador aislado (requiere Android 9 / API 28 o superior). ' +
          'Actualiza Android System WebView para abrir perfiles sin compartir cookies.'
      );
    }
  }

  // Si el mismo perfil ya está abierto, no se relanza ni se pierde el estado
  // (pulsar dos veces el perfil no debe cerrar la sesión en curso).
  if (isMobileNative && activeMobileProfileId === profileId) {
    return 2000 + Math.floor(Math.random() * 1000);
  }

  const targetUrl = config.start_url 
    || (config.startup_urls && config.startup_urls.length > 0 ? config.startup_urls[0] : null)
    || 'https://google.com';

  console.log('[Mobile In-App Browser] Launching isolated profile tab:', profileId, 'URL:', targetUrl);

  // ── Huella: la del teléfono real, sin shim ───────────────────────────────
  // El perfil corre en el WebView de ESTE teléfono. Antes se inyectaban dos
  // shims (realismEngine + stealthInjector) que fingían otro móvil (GPU,
  // pantalla, núcleos, memoria) y un Chrome en vez de un WebView; el hardware
  // real y las cabeceras Sec-CH-UA ("Android WebView"), que JS no puede cambiar,
  // los contradecían. Ahora se anuncia lo que hay: SO Android, la UA propia del
  // WebView y el hardware real. Los perfiles siguen aislados en cookies y
  // almacenamiento, pero comparten la huella de hardware del teléfono.
  config.os = 'android';
  config.user_agent = undefined;

  // ── Zona horaria = la de la IP de salida real ─────────────────────────────
  // En Android la zona no se puede cambiar de verdad desde JS (solo
  // Intl.resolvedOptions, no Date), así que no se falsea: si la del teléfono no
  // coincide con la de su IP, el perfil no se abre. La consulta va por la red
  // del dispositivo, así que solo vale sin proxy.
  if (!config.proxy) {
    const geo = await resolveDeviceEgressGeo();
    if (!geo) {
      throw new Error(
        'No se pudo verificar la ubicación de la IP de salida, así que el perfil no se abrió: ' +
          'no se puede comprobar que la zona horaria corresponda a la IP.',
      );
    }
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (deviceTz !== geo.timezone) {
      throw new Error(
        `La zona horaria del teléfono (${deviceTz}) no coincide con la de tu IP (${geo.timezone}). ` +
          'Activa "Zona horaria automática" en los ajustes de fecha y hora del teléfono y vuelve a abrir el perfil.',
      );
    }
  }

  // If another profile was active, close it first so the native side writes
  // its final cookie snapshot, then persist that snapshot to the vault.
  if (activeMobileProfileId && activeMobileProfileId !== profileId) {
    const previousProfileId = activeMobileProfileId;
    // La sesión anterior se detiene explícitamente: si se dejara en la
    // variable global, el listener de cierre podría detener la sesión nueva.
    const previousSessionId = activeMobileSessionId;
    activeMobileSessionId = null;
    console.log('[Mobile In-App Browser] Switching profiles from active:', previousProfileId);
    try {
      await ProfileBrowser.close();
    } catch (err) {
      console.warn('[Mobile In-App Browser] Could not close previous profile:', err);
    }
    try {
      await persistSessionAndPurge(previousProfileId);
    } catch (err) {
      console.warn('[Mobile In-App Browser] Could not persist previous profile:', err);
    }
    if (previousSessionId) {
      try {
        await invoke('server_stop_session', { sessionId: previousSessionId });
      } catch (err) {
        console.warn('[Mobile In-App Browser] Could not stop previous session:', err);
      }
    }
  }

  // Track session ID for automatic stopping on close
  activeMobileSessionId = config.session_id ? String(config.session_id) : null;

  activeProfileDomains = new Set<string>();
  try {
    const parsed = new URL(targetUrl);
    if (parsed.hostname) {
      activeProfileDomains.add(parsed.hostname);
      activeProfileDomains.add(parsed.hostname.replace(/^www\./, ''));
    }
  } catch {}

  const historicalDomains = getProfileDomainsFromVault(profileId);
  for (const d of historicalDomains) {
    if (d) activeProfileDomains.add(d);
  }

  const savedCookies = getProfileCookiesFromVault(profileId);
  for (const c of savedCookies) {
    if (c.domain) {
      const clean = c.domain.replace(/^\./, '').replace(/^www\./, '');
      if (clean) activeProfileDomains.add(clean);
    }
  }

  // Las cookies se pasan a ProfileBrowser.open(); la actividad nativa las
  // inyecta en el CookieManager de su propio proceso antes de navegar.

  activeMobileProfileId = profileId;

  try {
    if (closeListenerHandle) closeListenerHandle.remove();
    closeListenerHandle = await ProfileBrowser.addListener('browserClose', async (event) => {
      console.log('[Mobile In-App Browser] Close event triggered by user');
      const closedProfileId = event.profileId || activeMobileProfileId;
      if (closedProfileId) {
        try {
          await persistSessionAndPurge(closedProfileId);
        } catch (e) {
          console.warn('[Mobile In-App Browser] Could not persist closed profile:', e);
        }
      }
      if (activeMobileSessionId) {
        const sid = activeMobileSessionId;
        activeMobileSessionId = null;
        try {
          await invoke('server_stop_session', { sessionId: sid });
        } catch (e) {
          console.warn('[Mobile In-App Browser] Could not stop session:', e);
        }
      }
    });
  } catch (err) {
    console.warn('[Mobile In-App Browser] Could not attach browserClose listener:', err);
  }

  try {
    if (urlChangeListenerHandle) urlChangeListenerHandle.remove();
    urlChangeListenerHandle = await ProfileBrowser.addListener('browserUrlChange', (event) => {
      try {
        if (event && event.url) {
          const u = new URL(event.url);
          if (u.hostname && !activeProfileDomains.has(u.hostname)) {
            activeProfileDomains.add(u.hostname);
            activeProfileDomains.add(u.hostname.replace(/^www\./, ''));
            if (activeMobileProfileId) {
              saveProfileDomainsToVault(activeMobileProfileId, Array.from(activeProfileDomains));
            }
          }
        }
      } catch {}
    });
  } catch (err) {
    console.warn('[Mobile In-App Browser] Could not attach browserUrlChange listener:', err);
  }

  try {
    if (errorListenerHandle) errorListenerHandle.remove();
    errorListenerHandle = await ProfileBrowser.addListener('browserError', async (event) => {
      const failedProfileId = event.profileId || activeMobileProfileId;
      console.warn('[Mobile In-App Browser] Native browser error:', event.message);
      if (failedProfileId && activeMobileProfileId === failedProfileId) {
        activeMobileProfileId = null;
        activeProfileDomains.clear();
      }
      if (activeMobileSessionId) {
        const sid = activeMobileSessionId;
        activeMobileSessionId = null;
        try {
          await invoke('server_stop_session', { sessionId: sid });
        } catch (e) {
          console.warn('[Mobile In-App Browser] Could not stop failed session:', e);
        }
      }
      if (closeListenerHandle) {
        closeListenerHandle.remove();
        closeListenerHandle = null;
      }
      if (urlChangeListenerHandle) {
        urlChangeListenerHandle.remove();
        urlChangeListenerHandle = null;
      }
      if (errorListenerHandle) {
        errorListenerHandle.remove();
        errorListenerHandle = null;
      }
    });
  } catch (err) {
    console.warn('[Mobile In-App Browser] Could not attach browserError listener:', err);
  }

  try {
    await ProfileBrowser.open({
      profileId,
      url: targetUrl,
      title: config.profile_name || `${getBranding().shortName} Browser`,
      proxy: config.proxy || undefined,
      userAgent: config.user_agent || undefined,
      cookies: savedCookies,
      domains: Array.from(activeProfileDomains),
      // Sin customUserAgent ni preShowScript: el WebView se presenta tal cual
      // es (ver launchMobileProfileTab). La UA propia del WebView es la única que
      // coincide con sus cabeceras Sec-CH-UA.
    });

    return 2000 + Math.floor(Math.random() * 1000);
  } catch (err) {
    console.error('[Mobile In-App Browser] Error launching tab:', err);
    if (activeMobileProfileId === profileId) {
      activeMobileProfileId = null;
      activeProfileDomains.clear();
    }
    if (closeListenerHandle) {
      closeListenerHandle.remove();
      closeListenerHandle = null;
    }
    if (urlChangeListenerHandle) {
      urlChangeListenerHandle.remove();
      urlChangeListenerHandle = null;
    }
    if (errorListenerHandle) {
      errorListenerHandle.remove();
      errorListenerHandle = null;
    }
    if (activeMobileSessionId) {
      const sid = activeMobileSessionId;
      activeMobileSessionId = null;
      try {
        await invoke('server_stop_session', { sessionId: sid });
      } catch (stopErr) {
        console.warn('[Mobile In-App Browser] Could not stop failed session:', stopErr);
      }
    }
    throw err;
  }
}

/**
 * Closes the currently active mobile in-app browser tab, persists cookies to vault,
 * and clears the Android WebView.
 */
export async function closeMobileProfileTab(): Promise<boolean> {
  try {
    const profileId = activeMobileProfileId;
    // ProfileBrowser.close() resuelve cuando la actividad nativa ya exportó
    // las cookies y está cerrando. Así el snapshot final no se pierde.
    await ProfileBrowser.close();
    if (profileId && activeMobileProfileId === profileId) {
      await persistSessionAndPurge(profileId);
    }
    if (activeMobileSessionId) {
      const sid = activeMobileSessionId;
      activeMobileSessionId = null;
      try {
        await invoke('server_stop_session', { sessionId: sid });
      } catch {}
    }
    return true;
  } catch (err) {
    console.warn('[Mobile In-App Browser] Error closing tab:', err);
    return false;
  }
}

/**
 * Opens the native Android Airplane/Wireless settings for fast 4G/5G IP rotation.
 */
export async function openMobileAirplaneSettings(): Promise<boolean> {
  if (!isMobileNative) return false;
  try {
    await KrakenGesSession.openAirplaneSettings();
    return true;
  } catch (err) {
    console.warn('[Mobile IP Refresh] Error opening settings:', err);
    return false;
  }
}

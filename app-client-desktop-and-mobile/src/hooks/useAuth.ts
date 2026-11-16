import { useState, useEffect, useCallback } from 'react';
import { invoke } from '../services/tauriBridge';
import { secureStore } from '../services/secureStore';

export interface User {
  id: string;
  name: string;
  email: string;
  username?: string;
  isAdmin: boolean;
  plan?: string;
  /** Nombre real del plan, incluidos los personalizados que emite el servidor. */
  planName?: string;
  /** Límites efectivos del servidor (-1 = ilimitado). */
  limits?: {
    maxProfiles: number;
    maxSessions: number;
    maxApiKeys: number;
  };
  /** Plan base normalizado (ghost/shadow/specter/phantom). */
  normalizedPlan?: string;
  daysRemaining?: number | null;
  role?: string;
  sellerCredits?: number;
  ticket?: string;
  isLifetime?: boolean;
  planExpiresAt?: string | null;
}

export interface DashboardData {
  profilesCount: number;
  sessionsCount: number;
  activeSessionsCount: number;
  totalMinutes: number;
  latestSessions: any[];
  latestProfiles?: any[];
  apiKeysCount?: number;
}

export interface UserData {
  id: string;
  name: string;
  username: string;
  email: string;
  isAdmin: boolean;
  banned: boolean;
  plan: string;
  /** Nombre real del plan, incluidos los personalizados. */
  planName?: string;
  createdAt: string;
  lastLoginAt?: string;
  stats: {
    profiles: { current: number; max: number };
    activeSessions: { current: number; max: number };
    apiKeys: { current: number; max: number };
  };
}

/**
 * AVISO IMPORTANTE SOBRE LOS NOMBRES DE LOS COMANDOS
 *
 * invoke() NO llama a estas funciones. invoke() va al bridge de
 * services/tauriBridge.ts, y los comandos que existen ahi son los que empiezan
 * por "server_":
 *
 *   server_profiles_list      NO apiGetProfiles, NO get_profiles
 *   server_sessions_list      NO apiGetSessions, NO get_sessions
 *   server_get_dashboard
 *   server_create_profile
 *   server_fingerprint
 *
 * La declaracion de electronAPI de abajo es una reliquia: nadie la implementa.
 * Es la que induce a escribir los nombres equivocados, y ya ha pasado dos
 * veces: al llamar a apiGetProfiles el bridge devolvia error, el catch lo
 * convertia en lista vacia, y la pantalla de perfiles mostraba cero sin
 * explicar por que.
 *
 * Si buscas un comando nuevo, mira el switch de tauriBridge.ts, que es la unica
 * fuente de verdad.
 */
declare global {
  interface Window {
    electronAPI: {
      apiGetCurrentUser: () => Promise<User | null>;
      apiLogout: () => Promise<boolean>;
      apiLogin: (username: string, password: string) => Promise<User>;
      apiRegister: (name: string, username: string, email: string, password: string, key: string) => Promise<User>;
      apiGetProfiles: () => Promise<any[]>;
      apiGetFingerprint: (profileId: string) => Promise<any>;
      apiGetSessions: () => Promise<any[]>;
      apiGetDashboard: () => Promise<any>;
      apiGetUsers: () => Promise<any[]>;
      apiStartSession: (profileId: string) => Promise<any>;
      apiStopSession: (sessionId: string) => Promise<any>;
      apiReactivateSession: (sessionId: string) => Promise<any>;
      apiDeleteSession: (sessionId: string) => Promise<any>;
      apiDeleteProfile: (profileId: string) => Promise<any>;
      apiCreateProfile: (data: { name: string; proxy?: string; startUrl?: string; tags?: string[]; notes?: string }) => Promise<any>;
      apiUpdateProfileById: (profileId: string, data: { name?: string; proxy?: string; startUrl?: string; tags?: string[]; notes?: string }) => Promise<any>;
      apiUpdateProfile: (name: string) => Promise<any>;
      apiChangePassword: (currentPassword: string, newPassword: string) => Promise<any>;
      apiBanUser: (userId: string, banned: boolean) => Promise<any>;
      apiChangePlan: (userId: string, plan: string) => Promise<any>;
      apiResetPassword: (userId: string, password: string) => Promise<any>;
      apiGetKeys: () => Promise<any[]>;
      apiCreateKey: (data: any) => Promise<any>;
      apiRevokeKey: (keyId: string) => Promise<any>;
      apiAssignRole: (userId: string, data: any) => Promise<any>;
      apiGetAnalytics: () => Promise<any>;
      apiGetActivity: () => Promise<any[]>;
      apiResetHwid: (userId: string) => Promise<any>;
      apiExportBackup: () => Promise<any>;
      apiPurgeSessions: () => Promise<any>;
      browserCreate: (config: { profileId: string; url?: string; locale?: string; timezone?: string; os?: string; proxy?: string | null; sessionId?: string | null }) => Promise<{ success: boolean; error?: string; viewId?: number }>;
      browserClose: (profileId: string) => Promise<{ success: boolean }>;
      browserGet: (profileId: string) => Promise<{ exists: boolean; viewId?: number; url?: string }>;
      browserFocus: (profileId: string) => Promise<{ success: boolean }>;
      browserResize: (profileId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }>;
      browserNavigate: (profileId: string, url: string) => Promise<{ success: boolean }>;
      browserHistory: (profileId: string, action: 'back' | 'forward' | 'reload') => Promise<{ success: boolean }>;
      browserGetCookies: (profileId: string) => Promise<{ success: boolean; cookies?: any[]; error?: string }>;
      browserSetCookies: (profileId: string, cookies: any[]) => Promise<{ success: boolean; count?: number; error?: string }>;
      browserClearCookies: (profileId: string) => Promise<{ success: boolean; error?: string }>;
      onBrowserClosed: (callback: (profileId: string) => void) => () => void;
      onBrowserNavigated: (callback: (state: { profileId: string; url: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }) => void) => () => void;
      getAppVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>;
      quitAndInstallUpdate: () => Promise<void>;
      onUpdateAvailable: (callback: (info: any) => void) => () => void;
      onUpdateProgress: (callback: (progress: any) => void) => () => void;
      onUpdateDownloaded: (callback: (info: any) => void) => () => void;
    };
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const started = Date.now();
    const MIN_SPLASH = 150;

    const initAuth = async () => {
      try {
        // Comprobar inactividad prolongada (> 24 horas)
        const lastActiveStr = localStorage.getItem('krakenges_last_active_time');
        const now = Date.now();
        const MAX_INACTIVITY_MS = 24 * 60 * 60 * 1000;
        if (lastActiveStr) {
          const lastActive = parseInt(lastActiveStr, 10);
          if (!isNaN(lastActive) && now - lastActive > MAX_INACTIVITY_MS) {
            await invoke<void>('server_logout').catch(() => {});
            await secureStore.remove('krakenges_user');
            localStorage.removeItem('krakenges_user');
            localStorage.removeItem('krakenges_last_active_time');
            setUser(null);
            return;
          }
        }

        let currentUser: User | null = null;
        try {
          currentUser = await invoke<User>('server_get_current_user');
        } catch {
          try {
            currentUser = await invoke<User>('server_refresh_ticket');
          } catch {
            currentUser = null;
          }
        }
        if (currentUser) {
          setUser(currentUser);
          await secureStore.set('krakenges_user', JSON.stringify(currentUser));
          localStorage.setItem('krakenges_last_active_time', String(Date.now()));
        } else {
          // Si el servidor no confirma la sesion, se cierra. No hay usuario
          // de reserva: antes, si server_refresh_ticket fallaba, caia al
          // "Operador Ghost" del modo demo, que era admin, root y tenia 9999
          // creditos. Eso convertia un fallo de red en un acceso de
          // administrador.
          setUser(null);
          await secureStore.remove('krakenges_user');
          localStorage.removeItem('krakenges_user');
          localStorage.removeItem('krakenges_last_active_time');
        }
      } catch {
        // Mismo criterio: si falla la comprobacion, se cierra la sesion.
        setUser(null);
        await secureStore.remove('krakenges_user');
        localStorage.removeItem('krakenges_user');
        localStorage.removeItem('krakenges_last_active_time');
      } finally {
        const elapsed = Date.now() - started;
        setTimeout(() => setLoading(false), Math.max(0, MIN_SPLASH - elapsed));
      }
    };

    // El splash tiene que apagarse SIEMPRE. Antes, quitando el modo demo, se
    // quedaba en loading=true para siempre si server_get_current_user y
    // server_refresh_ticket fallaban, y el splash (position: fixed, inset: 0)
    // tapaba la app entera en negro. Ahora hay tres salidas garantizadas:
    // exito, error, y el corte por inactividad.
    let cancelado = false;

    (async () => {
      try {
        // El timeout evita que un invoke colgado (sin red, backend parado)
        // deje la app en el splash indefinidamente. Si el backend no responde
        // en 12 segundos, se entra al login.
        await Promise.race([
          initAuth(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout al comprobar la sesion')), 12000)
          ),
        ]);
      } catch (err) {
        // Si la comprobacion de sesion revienta del todo, se cierra la sesion
        // en vez de dejar la app en el splash para siempre.
        setUser(null);
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();

    return () => { cancelado = true; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const u = await invoke<User>('server_login', { username, password });
    await secureStore.set('krakenges_user', JSON.stringify(u));
    localStorage.setItem('krakenges_last_active_time', String(Date.now()));
    setUser(u);
    return u;
  }, []);

  const register = useCallback(async (data: { name: string; username: string; password: string; key: string }) => {
    const u = await invoke<User>('server_register', {
      name: data.name,
      username: data.username,
      email: '',
      password: data.password,
      key: data.key ? data.key.trim().toUpperCase() : '',
    });
    await secureStore.set('krakenges_user', JSON.stringify(u));
    localStorage.setItem('krakenges_last_active_time', String(Date.now()));
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await invoke<void>('server_logout').catch(() => {});
    await secureStore.remove('krakenges_user');
    localStorage.removeItem('krakenges_user');
    localStorage.removeItem('krakenges_last_active_time');
    setUser(null);
  }, []);

  const updateUser = useCallback(async (u: User) => {
    setUser(u);
    await secureStore.set('krakenges_user', JSON.stringify(u));
    // Antes se guardaba ademas en localStorage bajo la llave del modo demo.
    // Eso significaba que hasta un usuario real de pago quedaba guardado como
    // "demo", y una reinstall o un fallo de red lo podia revalidar desde ahi.
  }, []);

  return { user, loading, login, register, logout, updateUser };
}

export { invoke } from '../services/tauriBridge';
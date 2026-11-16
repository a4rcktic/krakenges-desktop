import { invoke as tauriInvoke } from './tauriBridge';

export interface LaunchConfig {
  profile_id: string;
  profile_name?: string;
  start_url?: string;
  proxy?: string;
  user_agent?: string;
  os?: string;
  screen_width?: number;
  screen_height?: number;
  device_pixel_ratio?: number;
  timezone?: string;
  locale?: string;
  webrtc_disabled?: boolean;
  custom_flags?: string[];
  session_id?: string;
  startup_urls?: string[];
  fingerprint_json?: string;
  // Geo-Coherence Engine (Lat/Lon & Auto alignment)
  latitude?: number;
  longitude?: number;
  auto_geo_coherence?: boolean;
}

export interface HwidInfo {
  hwid: string;
  os_name: string;
  kernel: string;
  cpu_count: number;
}

export interface ParsedProxy {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyTestResult {
  success: boolean;
  latency_ms?: number;
  ip?: string;
  country?: string;
  country_code?: string;
  city?: string;
  isp?: string;
  error?: string;
  protocol?: string;
  host?: string;
  port?: number;
  has_auth?: boolean;
  canonical?: string;
  // Coherencia Geográfica
  timezone?: string;
  tz_offset_minutes?: number;
  latitude?: number;
  longitude?: number;
  suggested_language?: string;
}

export const tauriService = {
  // Lanzamiento de perfil 100% aislado y stealth
  launchProfile: async (config: LaunchConfig): Promise<number> => {
    return await tauriInvoke<number>('launch_isolated_profile', { config });
  },

  // Cerrar perfil
  closeProfile: async (profileId: string): Promise<boolean> => {
    return await tauriInvoke<boolean>('close_profile', { profileId });
  },

  // Chequear estado del proceso
  isProfileRunning: async (profileId: string): Promise<boolean> => {
    return await tauriInvoke<boolean>('is_profile_running', { profileId });
  },

  // Obtener HWID blindado
  getHwid: async (): Promise<HwidInfo> => {
    return await tauriInvoke<HwidInfo>('get_hwid');
  },

  // Test de proxy en tiempo real
  testProxy: async (proxy: string): Promise<ProxyTestResult> => {
    return await tauriInvoke<ProxyTestResult>('test_proxy_connection', { proxy });
  },

  // Parsear formato de proxy instantáneamente
  parseProxy: async (proxy: string): Promise<ParsedProxy> => {
    return await tauriInvoke<ParsedProxy>('parse_proxy_string', { proxy });
  },
};

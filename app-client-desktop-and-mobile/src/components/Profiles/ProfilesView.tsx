import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '../../hooks/useAuth';
import { 
  Plus, 
  Play, 
  Square,
  Edit2, 
  Trash2, 
  Loader2, 
  X, 
  Globe, 
  Shield, 
  ShieldCheck,
  Wifi, 
  Cookie, 
  Download, 
  Upload, 
  Copy, 
  Check, 
  Layers, 
  Search, 
  Filter, 
  Flame, 
  Laptop, 
  Cpu, 
  Clock, 
  Link as LinkIcon, 
  MapPin, 
  AlertTriangle, 
  CheckCircle2, 
  Boxes, 
  Save, 
  ShoppingBag, 
  ShoppingCart, 
  Zap, 
  BookOpen, 
  Video, 
  Newspaper, 
  Gift, 
  Package, 
  Gamepad2, 
  Tag as TagIcon, 
  MessageSquare,
  Share2,
  Bookmark, 
  FileText, 
  Coins, 
  BarChart2, 
  TrendingUp, 
  UserPlus, 
  Compass,
  Volume2,
  Image as ImageIcon,
  Activity,
  RotateCw,
  Key,
  Smartphone,
  Shuffle,
  Sparkles
} from 'lucide-react';
import { WindowsIcon, AppleIcon, LinuxIcon } from '../Common/OsIcons';
import { tauriService, ProxyTestResult } from '../../services/tauri';
import { parseProxyClient } from '../../services/proxyParser';
import { generateTOTP, isValidTOTPSecret } from '../../services/totp';
import { auditProfileHealth, type ProfileHealthReport } from '../../services/healthAudit';
import { generateBurnerConfig } from '../../services/burnerProfile';
import { isMobileNative, openMobileAirplaneSettings } from '../../services/mobileBrowser';
import {
  BROWSER_TYPES,
  buildIdentity,
  listAvailableKits,
  type GeneratedIdentity,
} from '../../services/fingerprintPools';
import { usePlatform } from '../../context/PlatformContext';
import { BRAND } from '../../config/brand.generated';
import './ProfilesView.css';

// SO real del equipo. En escritorio todos los perfiles anuncian este SO: el
// motor lo impone al lanzar (launcher.rs / cdp::host_os_key), porque el render
// de la GPU, las fuentes y los workers siguen siendo del host. Antes la UI
// ponía 'windows' fijo y un Linux salía como Windows.
const HOST_OS: 'windows' | 'macos' | 'linux' = /Windows/i.test(navigator.userAgent)
  ? 'windows'
  : /Macintosh|Mac OS X/i.test(navigator.userAgent)
    ? 'macos'
    : 'linux';
const DEFAULT_OS = isMobileNative ? 'android' : HOST_OS;

interface Profile {
  id: string;
  _id?: string;
  name: string;
  proxy?: string;
  start_url?: string;
  startUrl?: string;
  tags?: string[];
  notes?: string;
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  userAgent?: string;
  user_agent?: string;
  browser?: string;
}

export async function launchProfileBrowser(
  profile: any,
  customStartupUrls?: string[],
) {
  const profileId = String(profile.id || profile._id);
  const startUrl = profile.startUrl || profile.start_url || null;

  const isRunning = await tauriService.isProfileRunning(profileId).catch(() => false);
  if (isRunning) {
    throw new Error('Este perfil ya tiene una ventana activa en ejecución.');
  }

  let activeProxy = profile.proxy || undefined;
  const backupProxy = profile.backupProxy || undefined;
  const killswitch = profile.killswitch !== false;

  // Killswitch Pre-Flight Protection
  if (activeProxy) {
    try {
      const pingRes = await tauriService.testProxy(activeProxy);
      if (!pingRes.success) {
        console.warn('[Killswitch] Primary proxy failed:', activeProxy, pingRes.error);
        if (backupProxy) {
          console.log('[Killswitch] Failover: attempting backup proxy:', backupProxy);
          const backupRes = await tauriService.testProxy(backupProxy);
          if (backupRes.success) {
            activeProxy = backupProxy;
            console.log('[Killswitch] Successfully failed over to backup proxy');
          } else if (killswitch) {
            throw new Error(`🛑 Killswitch Anti-Fugas: El proxy principal y el de respaldo no responden (${pingRes.error || 'Timeout'}). Inicio cancelado para proteger tu IP real.`);
          }
        } else if (killswitch) {
          throw new Error(`🛑 Killswitch Anti-Fugas: El proxy configurado no responde (${pingRes.error || 'Timeout'}). Inicio cancelado para proteger tu IP real.`);
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('Killswitch')) throw err;
      console.warn('[Killswitch] Pre-flight check warning:', err);
    }
  }

  let sessionId: string | undefined;
  try {
    const s = await invoke<{ id?: string; _id?: string }>('server_start_session', {
      profileId,
      profile_id: profileId,
      proxy: activeProxy || undefined,
    });
    sessionId = s?.id || s?._id;
  } catch (err) {
    console.warn('[ProfilesView] server_start_session fallback:', err);
  }

  const localOsMap = JSON.parse(localStorage.getItem('krakenges_local_os') || '{}');
  const localUaMap = JSON.parse(localStorage.getItem('krakenges_local_ua') || '{}');
  const effectiveOs = isMobileNative ? (localOsMap[profileId] || profile.os || DEFAULT_OS) : HOST_OS;
  const effectiveUa = localUaMap[profileId] || profile.userAgent || profile.user_agent || undefined;

  const pid = await tauriService.launchProfile({
    profile_id: profileId,
    profile_name: profile.name,
    start_url: startUrl || undefined,
    proxy: activeProxy || undefined,
    os: effectiveOs,
    user_agent: effectiveUa,
    session_id: sessionId,
    startup_urls: customStartupUrls,
    // Geo-Coherence Engine (IP ⟷ Timezone ⟷ Idioma ⟷ Coordenadas)
    timezone: profile.timezone || undefined,
    locale: profile.locale || undefined,
    latitude: profile.latitude || undefined,
    longitude: profile.longitude || undefined,
    auto_geo_coherence: true,
  });

  return pid;
}

interface FormState {
  name: string;
  proxy: string;
  backupProxy?: string;
  killswitch?: boolean;
  totpSecret?: string;
  rotationUrl?: string;
  startUrl: string;
  tags: string;
  notes: string;
  os: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  browser: 'chrome' | 'samsung' | 'edge' | 'opera' | 'firefox' | 'safari';
  kitId?: string;
  userAgent?: string;
  // Geo-Coherence
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
}

const EMPTY_FORM: FormState = {
  name: '',
  proxy: '',
  backupProxy: '',
  killswitch: true,
  totpSecret: '',
  rotationUrl: '',
  startUrl: '',
  tags: '',
  notes: '',
  os: DEFAULT_OS,
  browser: isMobileNative ? 'samsung' : 'chrome',
  kitId: '',
  userAgent: '',
};

// SIN PERFILES DE EJEMPLO.
//
// Antes este array era el estado inicial de la pantalla, con cuatro perfiles
// inventados: proxies con password de ejemplo, IPs reservadas por la RFC para
// documentacion (198.51.100.x, 185.220.101.x) y notas como "Residencial NYC".
// La pantalla NUNCA llamaba al backend, asi que siempre se veian estos.
//
// Ahora la lista arranca vacia y se llena con apiGetProfiles(). Si el servidor
// no responde se muestra un aviso de error, no un perfil inventado. En una app
// que se vende, un perfil de ejemplo es indistinguible de uno real.
export const DEFAULT_FLEET_PROFILES: Profile[] = [];

// Lo mismo con las pruebas de proxy: sin peticion real no hay latencia, ni
// pais, ni ciudad. Se pinta "—" hasta que el backend responda.
export const DEFAULT_PROXY_RESULTS: Record<string, ProxyTestResult> = {};


export function ProfilesView() {
  const { platform } = usePlatform();
  const isMobile = platform === 'mobile' || isMobileNative;
  const [profiles, setProfiles] = useState<Profile[]>(DEFAULT_FLEET_PROFILES);
  const [loading, setLoading] = useState(false);
  const [startingIds, setStartingIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Estado de carga del backend. Antes no existia porque la pantalla no
  // consultaba al servidor: se pintaba directamente una lista inventada.
  const [cargandoPerfiles, setCargandoPerfiles] = useState(true);
  const [errorPerfiles, setErrorPerfiles] = useState<string | null>(null);

  // Normaliza lo que devuelve el backend al tipo que la vista espera. El
  // servidor manda snake_case y la vista usa camelCase; si no se traduce,
  // campos como proxy, startUrl o tags salen undefined y las tarjetas salen
  // vacias sin avisar.
  const normalizarPerfil = (p: any): Profile => ({
    id: String(p.id ?? p._id ?? ''),
    name: p.name ?? 'Sin nombre',
    proxy: p.proxy ?? '',
    tags: Array.isArray(p.tags) ? p.tags : (p.tags ? String(p.tags).split(',').map((t: string) => t.trim()).filter(Boolean) : []),
    os: isMobileNative ? (p.os ?? 'android') : HOST_OS,
    notes: p.notes ?? '',
    startUrl: p.startUrl ?? p.start_url ?? '',
    userAgent: p.userAgent ?? p.user_agent ?? '',
    browser: p.browser ?? 'chrome',
  });

  useEffect(() => {
    let cancelado = false;
    (async () => {
      setCargandoPerfiles(true);
      setErrorPerfiles(null);
      try {
        const datos = await invoke<any[]>('server_profiles_list');
        if (cancelado) return;
        // Si el backend devuelve algo que no es una lista, se considera un
        // fallo en vez de aceptarlo: antes una respuesta vacia o malformada
        // terminaba mostrando datos de ejemplo.
        const lista = Array.isArray(datos) ? datos.map(normalizarPerfil) : [];
        setProfiles(lista);
      } catch (err: any) {
        if (cancelado) return;
        setProfiles([]);
        setErrorPerfiles(
          err?.message
            ? `No se pudieron cargar los perfiles: ${err.message}`
            : 'No se pudieron cargar los perfiles desde el servidor.'
        );
      } finally {
        if (!cancelado) setCargandoPerfiles(false);
      }
    })();
    return () => { cancelado = true; };
  }, []);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const [localProxies, setLocalProxies] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_proxies') || '{}');
    } catch {
      return {};
    }
  });

  const persistLocalProxies = (next: Record<string, string>) => {
    setLocalProxies(next);
    try {
      localStorage.setItem('krakenges_local_proxies', JSON.stringify(next));
    } catch {
    }
  };

  const saveLocalProxy = (profileId: string, proxy: string) => {
    const next = { ...localProxies };
    const t = (proxy || '').trim();
    if (t) next[profileId] = t;
    else delete next[profileId];
    persistLocalProxies(next);
  };

  const [localBackups, setLocalBackups] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_backup_proxies') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalBackup = (profileId: string, proxy: string) => {
    const next = { ...localBackups };
    const t = (proxy || '').trim();
    if (t) next[profileId] = t;
    else delete next[profileId];
    setLocalBackups(next);
    try {
      localStorage.setItem('krakenges_local_backup_proxies', JSON.stringify(next));
    } catch {}
  };

  const [localKillswitch, setLocalKillswitch] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_killswitch') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalKillswitch = (profileId: string, enabled: boolean) => {
    const next = { ...localKillswitch };
    next[profileId] = enabled;
    setLocalKillswitch(next);
    try {
      localStorage.setItem('krakenges_local_killswitch', JSON.stringify(next));
    } catch {}
  };

  const [localTotp, setLocalTotp] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_totp') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalTotp = (profileId: string, secret: string) => {
    const next = { ...localTotp };
    const t = (secret || '').trim();
    if (t) next[profileId] = t;
    else delete next[profileId];
    setLocalTotp(next);
    try {
      localStorage.setItem('krakenges_local_totp', JSON.stringify(next));
    } catch {}
  };

  const [localRotationLinks, setLocalRotationLinks] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_rotation_links') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalRotationLink = (profileId: string, url: string) => {
    const next = { ...localRotationLinks };
    const t = (url || '').trim();
    if (t) next[profileId] = t;
    else delete next[profileId];
    setLocalRotationLinks(next);
    try {
      localStorage.setItem('krakenges_local_rotation_links', JSON.stringify(next));
    } catch {}
  };

  const [localOs, setLocalOs] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_os') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalOs = (profileId: string, osVal: string) => {
    const next = { ...localOs };
    if (osVal) next[profileId] = osVal;
    else delete next[profileId];
    setLocalOs(next);
    try {
      localStorage.setItem('krakenges_local_os', JSON.stringify(next));
    } catch {}
  };

  const [localBrowsers, setLocalBrowsers] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_browser') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalBrowser = (profileId: string, bVal: string) => {
    const next = { ...localBrowsers };
    if (bVal) next[profileId] = bVal;
    else delete next[profileId];
    setLocalBrowsers(next);
    try {
      localStorage.setItem('krakenges_local_browser', JSON.stringify(next));
    } catch {}
  };

  const [localUas, setLocalUas] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('krakenges_local_ua') || '{}');
    } catch {
      return {};
    }
  });

  const saveLocalUa = (profileId: string, uaVal: string) => {
    const next = { ...localUas };
    if (uaVal) next[profileId] = uaVal;
    else delete next[profileId];
    setLocalUas(next);
    try {
      localStorage.setItem('krakenges_local_ua', JSON.stringify(next));
    } catch {}
  };

  const [liveTotpCodes, setLiveTotpCodes] = useState<Record<string, { code: string; remaining: number }>>({});
  const [copiedTotpId, setCopiedTotpId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const entries = Object.entries(localTotp).filter(([, sec]) => sec && sec.trim());

    // Sin secretos TOTP no hay nada que actualizar. Antes se llamaba a
    // setLiveTotpCodes({}) cada segundo, creando un objeto nuevo y forzando un
    // re-render completo de la vista de perfiles aunque no hubiera códigos.
    if (entries.length === 0) {
      setLiveTotpCodes((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return () => {
        mounted = false;
      };
    }

    const updateCodes = async () => {
      const nextCodes: Record<string, { code: string; remaining: number }> = {};
      for (const [pid, sec] of entries) {
        const res = await generateTOTP(sec);
        if (res.valid) {
          nextCodes[pid] = { code: res.code, remaining: res.remainingSeconds };
        }
      }
      if (!mounted) return;
      setLiveTotpCodes((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(nextCodes);
        const unchanged =
          prevKeys.length === nextKeys.length &&
          nextKeys.every(
            (key) =>
              prev[key]?.code === nextCodes[key].code &&
              prev[key]?.remaining === nextCodes[key].remaining
          );
        return unchanged ? prev : nextCodes;
      });
    };

    updateCodes();
    const interval = setInterval(updateCodes, 1000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [localTotp]);

  const handleCopyTotp = (profileId: string, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedTotpId(profileId);
    setTimeout(() => setCopiedTotpId(null), 2500);
  };

  const [healthModalTarget, setHealthModalTarget] = useState<Profile | null>(null);
  const [healthReport, setHealthReport] = useState<ProfileHealthReport | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const openHealthModal = async (p: Profile) => {
    setHealthModalTarget(p);
    setHealthLoading(true);
    setHealthReport(null);
    try {
      const pid = String(p.id || p._id);
      const rep = await auditProfileHealth({
        id: pid,
        name: p.name,
        proxy: localProxies[pid] || p.proxy,
        os: p.os,
        userAgent: (p as any).userAgent,
      });
      setHealthReport(rep);
    } catch (err) {
      console.error('Error auditing health:', err);
    } finally {
      setHealthLoading(false);
    }
  };

  const [burnerLoading, setBurnerLoading] = useState(false);
  const [burnerModalConfig, setBurnerModalConfig] = useState<any | null>(null);

  const handleLaunchBurner = () => {
    const burnerConf = generateBurnerConfig();
    setBurnerModalConfig(burnerConf);
  };

  const handleConfirmLaunchBurner = async () => {
    if (!burnerModalConfig) return;
    setBurnerLoading(true);
    try {
      await tauriService.launchProfile(burnerModalConfig);
      const code = burnerModalConfig.profile_id.slice(-4).toUpperCase();
      setBurnerModalConfig(null);
      showToast(`🔥 Perfil Fantasma #${code} iniciado exitosamente`);
    } catch (err: any) {
      alert(`Error al lanzar perfil fantasma: ${err?.message || err}`);
    } finally {
      setBurnerLoading(false);
    }
  };

  const [mobileRotationOpen, setMobileRotationOpen] = useState(false);
  const [detectedIp, setDetectedIp] = useState<string>('Detectando...');
  const [rotatingIp, setRotatingIp] = useState(false);

  const fetchPublicIp = async () => {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      setDetectedIp(data.ip || 'No disponible');
    } catch {
      setDetectedIp('IP protegida / Sin conexión directa');
    }
  };

  const handleOpenAirplaneSettings = async () => {
    await openMobileAirplaneSettings();
    setRotatingIp(true);
    setTimeout(async () => {
      await fetchPublicIp();
      setRotatingIp(false);
    }, 4500);
  };

  const handleTriggerRotationUrl = async (profileId: string, url: string) => {
    try {
      await fetch(url, { mode: 'no-cors' });
      alert('Se envió la señal de rotación de IP a tu proveedor de proxy móvil. Espera unos segundos.');
    } catch (e: any) {
      alert('Se envió la señal de rotación: ' + (e?.message || 'OK'));
    }
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'running'>('all');

  const [cookieModalTarget, setCookieModalTarget] = useState<Profile | null>(null);
  const [cookiesJson, setCookiesJson] = useState('');
  const [cookieLoading, setCookieLoading] = useState(false);
  const [cookieMsg, setCookieMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [cookieCount, setCookieCount] = useState<number>(0);
  const [copiedCookies, setCopiedCookies] = useState(false);
  const [detectedPlatform, setDetectedPlatform] = useState<{ name: string; url: string; tag: string } | null>(null);

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkCount, setBulkCount] = useState(5);
  const [bulkPrefix, setBulkPrefix] = useState('Perfil');
  const [bulkProxy, setBulkProxy] = useState('');
  const [bulkTags, setBulkTags] = useState('');
  const [bulkCreating, setBulkCreating] = useState(false);

  const [testingProxyIds, setTestingProxyIds] = useState<Set<string>>(new Set());
  const [proxyResults, setProxyResults] = useState<Record<string, ProxyTestResult>>(DEFAULT_PROXY_RESULTS);
  const [formProxyTesting, setFormProxyTesting] = useState(false);
  const [formProxyResult, setFormProxyResult] = useState<ProxyTestResult | null>(null);

  const [proxyCheckerOpen, setProxyCheckerOpen] = useState(false);
  const [proxyCheckerInput, setProxyCheckerInput] = useState('');
  const [proxyCheckerRunning, setProxyCheckerRunning] = useState(false);
  const [proxyCheckerItems, setProxyCheckerItems] = useState<Array<{
    raw: string;
    status: 'idle' | 'testing' | 'success' | 'error';
    latency_ms?: number;
    ip?: string;
    country?: string;
    error?: string;
  }>>([]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [inspectedProfile, setInspectedProfile] = useState<Profile | null>(null);

  /**
   * Detecta si la fila de acciones de la cabecera se sale de la pantalla.
   *
   * Hay cinco acciones y en un movil estrecho solo caben tres y media. Antes,
   * la quinta ("Rotar IP") se veia cortada por el borde derecho sin ningun
   * aviso, asi que era un boton que simplemente no existia para el usuario.
   *
   * Se mide el desbordamiento de verdad en vez de poner el degradado siempre:
   * en un movil ancho, donde todo cabe, un borde difuminado sobre el ultimo
   * boton seria un defecto. Se vuelve a medir al redimensionar y al rotar, que
   * es cuando cambia el ancho util.
   */
  const refCarruselAcciones = useRef<HTMLDivElement | null>(null);
  const [carruselDesborda, setCarruselDesborda] = useState(false);

  useEffect(() => {
    const medir = () => {
      const el = refCarruselAcciones.current;
      if (!el) return;
      setCarruselDesborda(el.scrollWidth > el.clientWidth + 1);
    };
    medir();
    window.addEventListener('resize', medir);
    window.addEventListener('orientationchange', medir);
    // Los botones cambian de texto segun el estado (Iniciar / Detener), asi que
    // el ancho tambien cambia sin que cambie la ventana.
    const obs = new ResizeObserver(medir);
    if (refCarruselAcciones.current) obs.observe(refCarruselAcciones.current);
    return () => {
      window.removeEventListener('resize', medir);
      window.removeEventListener('orientationchange', medir);
      obs.disconnect();
    };
  }, []);
  /**
   * Datos de hardware del perfil que se esta inspeccionando.
   *
   * Vienen del backend, que es quien decide la receta. Antes el panel de
   * inspeccion pintaba constantes (1920x1080, 8 nucleos, RTX 4070) para todos
   * los perfiles, y en un perfil Android eso daba un movil con GPU de
   * escritorio. Ahora, si el backend no manda el dato, se muestra "—".
   */
  const [datosInspeccion, setDatosInspeccion] = useState<{
    screen?: { width?: number; height?: number; dpr?: number };
    cores?: number;
    gpu?: string;
  }>({});
  // Sesiones activas por perfil. Arranca vacio: los ids de sesion vienen del
  // servidor. Antes se sembraban dos ("prof-01" -> "sess-101"), lo que hacia que
  // los perfiles de ejemplo aparecieran como "En Marcha" sin haber ninguna
  // sesion corriendo.
  const [activeSessionsMap, setActiveSessionsMap] = useState<Record<string, string>>({});

  /**
   * Pide al backend la receta del perfil que se esta inspeccionando.
   *
   * server_fingerprint es el mismo comando que usa el navegador al abrir una
   * sesion, o sea que lo que se ve aqui es exactamente lo que se va a inyectar.
   * Si falla, el panel sale con "—" en los campos sin dato, que es preferible a
   * inventar una GPU de escritorio para un movil.
   */
  const cargarDatosInspeccion = async (profile: Profile) => {
    const id = String(profile.id || profile._id || '');
    setDatosInspeccion({});
    if (!id) return;
    try {
      const receta: any = await invoke('server_fingerprint', {
        profileId: id,
        os: (profile.os || 'android').toLowerCase(),
      });
      if (!receta) return;
      const fp = receta.fingerprint || receta;
      setDatosInspeccion({
        screen: fp.screen,
        cores: fp.cores ?? fp.hardwareConcurrency,
        gpu: fp.webgl?.renderer ?? fp.gpu ?? fp.webglRenderer,
      });
    } catch {
      // Sin receta: se queda vacio y se muestra "—". No es un fallo que haya que
      // enseñarle al usuario; el panel simplemente no tiene dato que mostrar.
    }
  };

  useEffect(() => {
    loadProfiles();
    const interval = setInterval(() => {
      loadProfiles();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModalOpen(false);
        setBulkModalOpen(false);
        setDeleteTarget(null);
        setCookieModalTarget(null);
        setInspectedProfile(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadProfiles = async () => {
    try {
      // server_profiles_list es el comando real del bridge. Antes se llamaba a
      // "get_profiles", que no existe: fallaba, el catch lo convertia en lista
      // vacia, y la pantalla mostraba "no tienes perfiles" sin decir nada. Un
      // fallo de red quedaba indistinguible de una cuenta sin perfiles.
      const profilesData = await invoke<Profile[]>('server_profiles_list');
      const [sessionsData] = await Promise.all([
        invoke<any[]>('server_sessions_list').catch(() => [] as any[]),
      ]);
      const localOsMap = JSON.parse(localStorage.getItem('krakenges_local_os') || '{}');
      const normalized = (profilesData || []).map((p) => {
        const pid = String(p.id || (p as any)._id);
        return {
          ...p,
          id: pid,
          proxy: localProxies[pid] !== undefined ? localProxies[pid] : (p.proxy ?? ''),
          os: (localOsMap[pid] as any) || p.os || DEFAULT_OS,
        };
      });
      const actMap: Record<string, string> = {};
      (sessionsData || []).forEach((s) => {
        if (s.status === 'active') {
          const pid = typeof s.profileId === 'object' && s.profileId !== null
            ? String(s.profileId.id || s.profileId._id)
            : String(s.profileId || s.profile_id || '');
          if (pid) actMap[pid] = String(s.id || s._id);
        }
      });

      // Si el servidor no devuelve perfiles, la lista queda vacia. Antes, cuando
      // llegaba vacía, se rellenaba con cuatro perfiles de ejemplo ("Amazon Prime
      // Seller US", "TikTok Ads Media Buyer UK"...). En una pantalla de venta,
      // un perfil que parece real y no lo es, es el peor fallo posible: el
      // usuario no tiene forma de saber que no son suyos.
      setProfiles(normalized);
      setActiveSessionsMap(actMap);
    } catch (err) {
      console.error('Error loading profiles:', err);
    } finally {
      setLoading(false);
    }
  };

  const allTags = Array.from(
    new Set(profiles.flatMap((p) => (p.tags || []).map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)))
  );

  const filteredProfiles = profiles.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.proxy && p.proxy.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (p.notes && p.notes.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesTag = selectedTag ? (p.tags || []).includes(selectedTag) : true;
    const isRunning = Boolean(activeSessionsMap[String(p.id || p._id)]);
    const matchesStatus = statusFilter === 'all' ? true : isRunning;

    return matchesSearch && matchesTag && matchesStatus;
  });

  const activeCount = profiles.filter((p) => Boolean(activeSessionsMap[String(p.id || p._id)])).length;

  const openCreate = () => {
    setEditing(null);
    const defOs = DEFAULT_OS;
    const defBrowser = isMobileNative ? 'samsung' : 'chrome';
    const fp = buildIdentity({ os: defOs, browser: defBrowser });
    setForm({
      ...EMPTY_FORM,
      os: defOs,
      browser: defBrowser,
      kitId: fp.kitId,
      userAgent: fp.ua,
    });
    setFormError('');
    setFormProxyResult(null);
    setModalOpen(true);
  };

  const openEdit = (p: Profile) => {
    setEditing(p);
    const pid = String(p.id || p._id);
    const curOs = isMobileNative ? ((localOs[pid] as any) || (p.os as any) || DEFAULT_OS) : HOST_OS;
    const curBrowser = (localBrowsers[pid] as any) || (isMobileNative ? 'samsung' : 'chrome');
    const curUa = localUas[pid] || p.userAgent || p.user_agent || '';
    setForm({
      name: p.name,
      proxy: localProxies[pid] || p.proxy || '',
      backupProxy: localBackups[pid] || '',
      killswitch: localKillswitch[pid] !== false,
      totpSecret: localTotp[pid] || '',
      rotationUrl: localRotationLinks[pid] || '',
      startUrl: p.startUrl || p.start_url || '',
      tags: (p.tags || []).join(', '),
      notes: p.notes || '',
      os: curOs,
      browser: curBrowser,
      // NO SE DEJA VACIO.
      //
      // buildIdentity() usa Math.random() cuando no recibe seed, asi que con
      // kitId a '' generaba una identidad nueva y distinta cada vez que se
      // abria el perfil de un perfil. De ahi que el SO, la GPU y la pantalla
      // parecieran cambiar solos: no era el backend, era una tirada de dados
      // nueva en cada apertura.
      //
      // Ahora se reutiliza el kit que ya tiene el perfil. Si no tiene ninguno
      // (perfil viejo), se deja vacio y sera el backend quien asigne uno al
      // guardar, que es el unico sitio donde debe decidirse.
      kitId: (p as any).kitId || (p as any).kit_id || '',
      userAgent: curUa,
    });
    setFormError('');
    setFormProxyResult(null);
    setModalOpen(true);
  };

  const handleGenerateRandomFp = () => {
    const gen = buildIdentity({
      os: form.os,
      browser: form.browser,
      kitId: form.kitId || undefined,
    });
    setForm((prev) => ({
      ...prev,
      kitId: gen.kitId,
      userAgent: gen.ua,
    }));
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name?.trim()) {
      setFormError('El nombre del perfil es obligatorio');
      return;
    }
    setSaving(true);
    setFormError('');

    try {
      const payload = {
        name: form.name.trim(),
        startUrl: form.startUrl?.trim() || undefined,
        tags: (form.tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes: form.notes?.trim() || undefined,
        os: form.os,
      };

      if (editing) {
        const id = editing.id || editing._id;
        const sid = String(id);
        await invoke('server_update_profile_by_id', {
          profileId: id,
          name: payload.name,
          startUrl: payload.startUrl,
          tags: payload.tags,
          notes: payload.notes,
          os: payload.os === 'android' ? 'linux' : payload.os,
        });
        saveLocalProxy(sid, form.proxy);
        saveLocalBackup(sid, form.backupProxy || '');
        saveLocalKillswitch(sid, form.killswitch ?? true);
        saveLocalTotp(sid, form.totpSecret || '');
        saveLocalRotationLink(sid, form.rotationUrl || '');
        saveLocalOs(sid, form.os);
        if (form.browser) saveLocalBrowser(sid, form.browser);
        if (form.userAgent) saveLocalUa(sid, form.userAgent);
      } else {
        const created = await invoke('server_create_profile', {
          name: payload.name,
          startUrl: payload.startUrl,
          tags: payload.tags,
          notes: payload.notes,
          os: payload.os === 'android' ? 'linux' : payload.os,
        });
        const cid = (created as any)?.id || (created as any)?._id;
        if (cid) {
          const scid = String(cid);
          saveLocalProxy(scid, form.proxy);
          saveLocalBackup(scid, form.backupProxy || '');
          saveLocalKillswitch(scid, form.killswitch ?? true);
          saveLocalTotp(scid, form.totpSecret || '');
          saveLocalRotationLink(scid, form.rotationUrl || '');
          saveLocalOs(scid, form.os);
          if (form.browser) saveLocalBrowser(scid, form.browser);
          if (form.userAgent) saveLocalUa(scid, form.userAgent);
        }
      }

      setModalOpen(false);
      await loadProfiles();
    } catch (err: any) {
      setFormError(err?.message || 'Error al guardar perfil');
    } finally {
      setSaving(false);
    }
  };

  const handleBulkCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBulkCreating(true);

    try {
      const tagsArray = (bulkTags || '')
        .split(',')
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean);

      const proxies = (bulkProxy || '')
        .split('\n')
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter(Boolean);

      for (let i = 1; i <= bulkCount; i++) {
        const profileName = `${bulkPrefix} #${String(i).padStart(2, '0')}`;
        const proxyForProfile = proxies.length > 0 ? proxies[(i - 1) % proxies.length] : undefined;

        const created = await invoke('server_create_profile', {
          name: profileName,
          tags: tagsArray,
        });
        const cid = (created as any)?.id || (created as any)?._id;
        if (cid && proxyForProfile) saveLocalProxy(String(cid), proxyForProfile);
      }

      setBulkModalOpen(false);
      await loadProfiles();
    } catch (err: any) {
      alert(err?.message || 'Error al generar lote de perfiles');
    } finally {
      setBulkCreating(false);
    }
  };

  const handleDeleteProfile = async (p: Profile) => {
    const id = p.id || p._id;
    setDeleting(true);
    setDeleteError('');
    try {
      await invoke('server_delete_profile', { profileId: id });
      if (localProxies[String(id)] !== undefined) {
        const next = { ...localProxies };
        delete next[String(id)];
        persistLocalProxies(next);
      }
      saveLocalBackup(String(id), '');
      saveLocalTotp(String(id), '');
      saveLocalRotationLink(String(id), '');
      setDeleteTarget(null);
      if (inspectedProfile && String(inspectedProfile.id || inspectedProfile._id) === String(id)) {
        setInspectedProfile(null);
      }
      await loadProfiles();
    } catch (err: any) {
      setDeleteError(err?.message || 'Error al eliminar perfil');
    } finally {
      setDeleting(false);
    }
  };

  const handleDuplicateProfile = async (profile: Profile) => {
    try {
      const created = await invoke('server_create_profile', {
        name: `${profile.name} (Copia)`,
        startUrl: profile.startUrl || profile.start_url,
        tags: profile.tags,
        notes: profile.notes,
        os: profile.os || DEFAULT_OS,
      });
      const cid = (created as any)?.id || (created as any)?._id;
      if (cid && profile.proxy) {
        saveLocalProxy(String(cid), profile.proxy);
      }
      await loadProfiles();
    } catch (err: any) {
      alert(err?.message || 'Error al duplicar perfil');
    }
  };

  const handleBatchExport = () => {
    const targets = profiles.filter((p) => selectedIds.has(String(p.id || p._id)));
    if (targets.length === 0) return;
    const exportData = targets.map((p) => ({
      name: p.name,
      os: p.os || DEFAULT_OS,
      proxy: p.proxy || undefined,
      startUrl: p.startUrl || p.start_url || undefined,
      tags: p.tags || [],
      notes: p.notes || undefined,
    }));
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${BRAND.slug}_perfiles_export_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStartSession = async (profile: Profile) => {
    const id = String(profile.id || profile._id || '');
    if (!id) return;
    setStartingIds((prev) => new Set(prev).add(id));

    try {
      const fullProfile = {
        ...profile,
        proxy: localProxies[id] || profile.proxy,
        backupProxy: localBackups[id],
        killswitch: localKillswitch[id] !== false,
      };
      await launchProfileBrowser(fullProfile);
      await loadProfiles();
    } catch (err: any) {
      alert(err?.message || 'Error al lanzar navegador');
    } finally {
      setStartingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleStopProfileSession = async (profileId: string) => {
    const id = String(profileId);
    setStartingIds((prev) => new Set(prev).add(id));
    try {
      const sessionId = activeSessionsMap[id];
      if (sessionId) {
        await invoke('server_stop_session', { sessionId }).catch(() => {});
      }
      await tauriService.closeProfile(id).catch(() => {});
      await loadProfiles();
    } catch (err: any) {
      console.error('Error deteniendo sesión:', err);
    } finally {
      setStartingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleTestProfileProxy = async (profile: Profile) => {
    const id = String(profile.id || profile._id || '');
    if (!profile.proxy || !id) return;

    setTestingProxyIds((prev) => new Set(prev).add(id));
    try {
      const result = await tauriService.testProxy(profile.proxy);
      setProxyResults((prev) => ({ ...prev, [id]: result }));
    } catch (err: any) {
      setProxyResults((prev) => ({
        ...prev,
        [id]: {
          success: false,
          error: err?.message || 'Error de conexión con el proxy',
        },
      }));
    } finally {
      setTestingProxyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleTestFormProxy = async () => {
    if (!form.proxy?.trim()) return;
    setFormProxyTesting(true);
    setFormProxyResult(null);
    try {
      const result = await tauriService.testProxy(form.proxy.trim());
      setFormProxyResult(result);
      if (result.success && result.timezone) {
        setForm((prev) => ({
          ...prev,
          timezone: result.timezone,
          locale: result.suggested_language || prev.locale,
          latitude: result.latitude,
          longitude: result.longitude,
        }));
      }
    } catch (err: any) {
      setFormProxyResult({
        success: false,
        error: err?.message || 'Error de verificación de proxy',
      });
    } finally {
      setFormProxyTesting(false);
    }
  };

  const handleOpenProxyChecker = () => {
    if (!proxyCheckerInput?.trim()) {
      const existing = profiles.map((p) => p.proxy).filter((p): p is string => !!p && typeof p === 'string' && p.trim().length > 0);
      if (existing.length > 0) {
        setProxyCheckerInput(Array.from(new Set(existing)).join('\n'));
      }
    }
    setProxyCheckerOpen(true);
  };

  const handleStartProxyCheck = async () => {
    const lines = proxyCheckerInput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    setProxyCheckerRunning(true);
    const initialItems = lines.map((raw) => ({ raw, status: 'idle' as const }));
    setProxyCheckerItems(initialItems);

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      setProxyCheckerItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: 'testing' } : item)));
      try {
        const res = await tauriService.testProxy(raw);
        setProxyCheckerItems((prev) =>
          prev.map((item, idx) => {
            if (idx !== i) return item;
            if (res.success) {
              return {
                ...item,
                status: 'success',
                latency_ms: res.latency_ms,
                ip: res.ip,
                country: res.country || res.country_code,
              };
            } else {
              return {
                ...item,
                status: 'error',
                error: res.error || 'Fallo de conexión',
              };
            }
          })
        );
      } catch (err: any) {
        setProxyCheckerItems((prev) =>
          prev.map((item, idx) => {
            if (idx !== i) return item;
            return {
              ...item,
              status: 'error',
              error: err?.message || 'Error de red',
            };
          })
        );
      }
    }
    setProxyCheckerRunning(false);
  };

  const handleCopyWorkingProxies = () => {
    const working = proxyCheckerItems.filter((item) => item.status === 'success').map((item) => item.raw);
    if (working.length === 0) {
      alert('No hay proxies activos verificados para copiar.');
      return;
    }
    navigator.clipboard.writeText(working.join('\n'));
    alert(`${working.length} proxies activos copiados al portapapeles.`);
  };

  const detectPlatformFromCookies = (cookies: any[]): { name: string; url: string; tag: string } => {
    const domains = cookies.map((c) => (c.domain || c.url || '').toLowerCase()).join(' ');

    if (domains.includes('facebook.com') || domains.includes('fb.com') || domains.includes('meta.com')) {
      return { name: 'Facebook Ads / Meta', url: 'https://adsmanager.facebook.com/', tag: 'meta' };
    }
    if (domains.includes('google.com') || domains.includes('youtube.com') || domains.includes('gmail.com')) {
      return { name: 'Google Workspace', url: 'https://myaccount.google.com/', tag: 'google' };
    }
    if (domains.includes('tiktok.com') || domains.includes('byteoversea.com')) {
      return { name: 'TikTok Ads', url: 'https://ads.tiktok.com/', tag: 'tiktok' };
    }
    if (domains.includes('amazon.') || domains.includes('aws.amazon.com')) {
      return { name: 'Amazon Seller', url: 'https://sellercentral.amazon.com/', tag: 'amazon' };
    }
    if (domains.includes('twitter.com') || domains.includes('x.com')) {
      return { name: 'X / Twitter Ads', url: 'https://ads.x.com/', tag: 'twitter' };
    }
    if (domains.includes('shein.com')) {
      return { name: 'Shein Marketplace', url: 'https://www.shein.com/user/index', tag: 'shein' };
    }
    if (domains.includes('binance.com') || domains.includes('coinbase.com')) {
      return { name: 'Crypto Exchange', url: 'https://www.binance.com/', tag: 'crypto' };
    }

    const firstDomain = (cookies.find((c) => c.domain)?.domain || '').replace(/^\./, '');
    if (firstDomain) {
      return { name: firstDomain.toUpperCase(), url: `https://${firstDomain}/`, tag: firstDomain.split('.')[0] };
    }

    return { name: 'Web General', url: 'https://google.com', tag: 'web' };
  };

  const openCookieManager = async (profile: Profile) => {
    const id = String(profile.id || profile._id || '');
    if (!id) return;
    setCookieModalTarget(profile);
    setCookiesJson('');
    setCookieMsg(null);
    setDetectedPlatform(null);
    setCookieLoading(true);

    try {
      const res = await invoke<{ success: boolean; cookies?: any[]; error?: string }>('browser_get_cookies', { profileId: id });
      if (res.success && res.cookies) {
        setCookieCount(res.cookies.length);
        setCookiesJson(JSON.stringify(res.cookies, null, 2));
        if (res.cookies.length > 0) {
          setDetectedPlatform(detectPlatformFromCookies(res.cookies));
        }
      } else {
        setCookieCount(0);
        setCookiesJson('[]');
      }
    } catch (err: any) {
      // Antes se ponía '[]' y el error solo vivía en un aviso temporal: el
      // usuario veía un apartado vacío sin ninguna pista de por qué. Ahora el
      // textarea conserva el motivo.
      const motivo = err?.message || 'No se pudieron leer las cookies.';
      setCookiesJson('');
      setCookieCount(0);
      setCookieMsg({
        type: 'error',
        text: `${motivo} — abre el perfil desde la lista y vuelve a intentarlo.`,
      });
    } finally {
      setCookieLoading(false);
    }
  };

  const handleImportCookies = async (autoLaunchAfter = false) => {
    if (!cookieModalTarget) return;
    setCookieLoading(true);
    setCookieMsg(null);

    try {
      let parsedCookies: any[] = [];
      const trimmed = cookiesJson.trim();

      if (trimmed.startsWith('[')) {
        parsedCookies = JSON.parse(trimmed);
      } else if (trimmed.includes('\t')) {
        const lines = trimmed.split('\n');
        for (const line of lines) {
          if (line.startsWith('#') || !line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            parsedCookies.push({
              domain: parts[0],
              path: parts[2],
              secure: parts[3].toLowerCase() === 'true',
              expirationDate: parseInt(parts[4]) || undefined,
              name: parts[5],
              value: parts[6].replace(/\r$/, ''),
            });
          }
        }
      } else {
        throw new Error('Formato no reconocido. Pega un JSON válido o texto Netscape de cookies.');
      }

      if (!Array.isArray(parsedCookies) || parsedCookies.length === 0) {
        throw new Error('No se encontraron cookies válidas para importar.');
      }

      const id = String(cookieModalTarget.id || cookieModalTarget._id || '');
      if (!id) return;

      const res = await invoke<{ success: boolean; count?: number; error?: string }>('browser_set_cookies', {
        profileId: id,
        cookies: parsedCookies,
      });
      if (!res.success) {
        throw new Error(res.error || 'Fallo al guardar cookies');
      }

      const platform = detectPlatformFromCookies(parsedCookies);
      setDetectedPlatform(platform);
      setCookieCount(res.count || parsedCookies.length);

      try {
        const currentTags = cookieModalTarget.tags || [];
        const newTags = Array.from(new Set([...currentTags, platform.tag]));
        await invoke('server_update_profile_by_id', {
          profileId: id,
          startUrl: platform.url,
          tags: newTags,
        });
        await loadProfiles();
      } catch {}

      setCookieMsg({
        type: 'success',
        text: `Plataforma detectada: ${platform.name}. Se inyectaron ${res.count || parsedCookies.length} cookies.`,
      });

      if (autoLaunchAfter) {
        setTimeout(async () => {
          setCookieModalTarget(null);
          await launchProfileBrowser({ ...cookieModalTarget, startUrl: platform.url });
        }, 600);
      }
    } catch (err: any) {
      setCookieMsg({ type: 'error', text: err?.message || 'Error al procesar cookies' });
    } finally {
      setCookieLoading(false);
    }
  };

  const handleDownloadCookiesFile = () => {
    if (!cookieModalTarget || !cookiesJson) return;
    const blob = new Blob([cookiesJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cookies_${cookieModalTarget.name.toLowerCase().replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyCookiesToClipboard = () => {
    if (!cookiesJson) return;
    navigator.clipboard.writeText(cookiesJson);
    setCopiedCookies(true);
    setTimeout(() => setCopiedCookies(false), 2000);
  };

  const handleClearCookies = async () => {
    if (!cookieModalTarget) return;
    if (!confirm(`¿Borrar todas las cookies y datos de almacenamiento de "${cookieModalTarget.name}"?`)) return;

    const id = String(cookieModalTarget.id || cookieModalTarget._id || '');
    if (!id) return;
    setCookieLoading(true);
    try {
      await invoke('browser_clear_cookies', { profileId: id });
      setCookiesJson('[]');
      setCookieCount(0);
      setCookieMsg({ type: 'success', text: 'Cookies y almacenamiento borrados exitosamente.' });
    } catch (err: any) {
      setCookieMsg({ type: 'error', text: err?.message || 'Error al limpiar' });
    } finally {
      setCookieLoading(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredProfiles.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProfiles.map((p) => String(p.id || p._id))));
    }
  };

  const toggleSelectOne = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchStart = async () => {
    const targets = profiles.filter((p) => selectedIds.has(String(p.id || p._id)));
    for (const p of targets) {
      handleStartSession(p);
    }
  };

  const handleBatchTestProxy = async () => {
    const targets = profiles.filter((p) => selectedIds.has(String(p.id || p._id)) && p.proxy);
    for (const p of targets) {
      handleTestProfileProxy(p);
    }
  };

  const handleBatchDelete = async () => {
    if (!confirm(`¿Eliminar definitivamente los ${selectedIds.size} perfiles seleccionados?`)) return;
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      try {
        await invoke('server_delete_profile', { profileId: id });
      } catch {}
    }
    setSelectedIds(new Set());
    if (inspectedProfile && ids.includes(String(inspectedProfile.id || inspectedProfile._id))) {
      setInspectedProfile(null);
    }
    await loadProfiles();
  };

  const renderOsIcon = (os?: string) => {
    if (os === 'android') return <Smartphone size={14} />;
    if (os === 'macos') return <AppleIcon size={14} />;
    if (os === 'linux') return <LinuxIcon size={14} />;
    return <WindowsIcon size={14} />;
  };

  const renderLatencyBars = (latency?: number, success?: boolean) => {
    if (!success || latency === undefined) {
      return (
        <div className="flex items-end gap-0.5 h-3 ml-1" title="Sin probar o desconectado">
          <span className="signal-bar h-1 bg-neutral-700"></span>
          <span className="signal-bar h-2 bg-neutral-700"></span>
          <span className="signal-bar h-3 bg-neutral-700"></span>
        </div>
      );
    }
    if (latency < 70) {
      return (
        <div className="flex items-end gap-0.5 h-3 ml-1" title={`Latencia excelente: ${latency}ms`}>
          <span className="signal-bar h-1.5 bg-emerald-400"></span>
          <span className="signal-bar h-2 bg-emerald-400"></span>
          <span className="signal-bar h-3 bg-emerald-400"></span>
        </div>
      );
    }
    if (latency < 200) {
      return (
        <div className="flex items-end gap-0.5 h-3 ml-1" title={`Latencia media: ${latency}ms`}>
          <span className="signal-bar h-1.5 bg-amber-400"></span>
          <span className="signal-bar h-2 bg-amber-400"></span>
          <span className="signal-bar h-3 bg-neutral-700"></span>
        </div>
      );
    }
    return (
      <div className="flex items-end gap-0.5 h-3 ml-1" title={`Latencia alta: ${latency}ms`}>
        <span className="signal-bar h-1.5 bg-rose-400"></span>
        <span className="signal-bar h-2 bg-neutral-700"></span>
        <span className="signal-bar h-3 bg-neutral-700"></span>
      </div>
    );
  };

  return (
    <div className={`fleet-profiles-view fleet-scroll ${isMobile ? 'is-mobile-view' : 'is-desktop-view'}`}>
      
      {/* ── TOP TOOLBAR ── */}
      <header className="fleet-toolbar">
        <div className="fleet-search-wrap">
          <Search size={14} className="fleet-search-icon" />
          <input 
            type="text" 
            placeholder="Buscar por ID, tienda, proxy o etiqueta..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="fleet-search-input"
          />
        </div>

        {/* Desktop Actions */}
        <div className="fleet-toolbar-actions desktop-actions-only">
          <button 
            type="button"
            onClick={handleOpenProxyChecker}
            className="btn-fleet-secondary btn-fleet-tactile"
            title="Diagnóstico masivo de latencia y estado de proxies"
          >
            <Wifi size={14} className="text-white" />
            <span>Test Proxies</span>
          </button>

          <button 
            type="button"
            onClick={() => {
              const target = profiles[0] || null;
              if (target) openCookieManager(target);
              else alert('Crea al menos un perfil para gestionar cookies.');
            }}
            className="btn-fleet-secondary btn-fleet-tactile"
            title="Gestionar cookies de sesión"
          >
            <Cookie size={14} className="text-white" />
            <span>Cookies</span>
          </button>

          <button 
            type="button"
            onClick={() => setBulkModalOpen(true)}
            className="btn-fleet-secondary btn-fleet-tactile"
            title="Generar múltiples perfiles con rotación automática"
          >
            <Boxes size={14} className="text-white" />
            <span>Crear Lote</span>
          </button>

          <button 
            type="button"
            onClick={handleLaunchBurner}
            disabled={burnerLoading}
            className="btn-fleet-secondary btn-fleet-tactile border-amber-500/30 hover:border-amber-400 text-amber-300"
            title="Genera y lanza un perfil efímero 100% desechable que se autodestruye al cerrar"
          >
            {burnerLoading ? <Loader2 size={14} className="spin text-amber-400" /> : <Flame size={14} className="text-amber-400" />}
            <span>Fantasma</span>
          </button>

          <button 
            type="button"
            onClick={() => {
              fetchPublicIp();
              setMobileRotationOpen(true);
            }}
            className="btn-fleet-secondary btn-fleet-tactile border-sky-500/30 hover:border-sky-400 text-sky-300"
            title="Rotación de IP Móvil Residencial (Modo Avión 4G/5G)"
          >
            <Smartphone size={14} className="text-sky-400" />
            <span>Rotar IP</span>
          </button>

          <button 
            type="button"
            onClick={openCreate}
            className="btn-fleet-primary btn-fleet-tactile"
          >
            <Plus size={15} strokeWidth={2.5} />
            <span>Crear Perfil</span>
          </button>
        </div>

        {/* Mobile Horizontal Quick-Action Pill Strip */}
        <div
          ref={refCarruselAcciones}
          className={`mobile-actions-carousel mobile-actions-only${carruselDesborda ? ' has-overflow' : ''}`}
        >
          <button 
            type="button"
            onClick={openCreate}
            className="btn-mob-primary"
          >
            <Plus size={14} strokeWidth={2.5} />
            <span>Nuevo</span>
          </button>

          <button 
            type="button"
            onClick={handleLaunchBurner}
            disabled={burnerLoading}
            className="btn-mob-chip text-amber-300 border-amber-500/30"
          >
            <Flame size={12} className="text-amber-400" />
            <span>Fantasma</span>
          </button>

          <button 
            type="button"
            onClick={handleOpenProxyChecker}
            className="btn-mob-chip"
          >
            <Wifi size={12} className="text-emerald-400" />
            <span>Test Red</span>
          </button>

          <button 
            type="button"
            onClick={() => {
              fetchPublicIp();
              setMobileRotationOpen(true);
            }}
            className="btn-mob-chip text-sky-300 border-sky-500/30"
          >
            <Smartphone size={12} className="text-sky-400" />
            <span>Rotar 4G</span>
          </button>

          <button 
            type="button"
            onClick={() => setBulkModalOpen(true)}
            className="btn-mob-chip"
          >
            <Boxes size={12} className="text-purple-400" />
            <span>Lote</span>
          </button>

          <button 
            type="button"
            onClick={() => {
              const target = profiles[0] || null;
              if (target) openCookieManager(target);
              else alert('Crea al menos un perfil para gestionar cookies.');
            }}
            className="btn-mob-chip"
          >
            <Cookie size={12} className="text-yellow-400" />
            <span>Cookies</span>
          </button>
        </div>
      </header>

      {/* ── FLEET METRIC CARDS ── */}
      <div className="fleet-metrics-grid">
        <div className="fleet-metric-card">
          <div className="fleet-metric-header">
            <span>Perfiles en Flota</span>
            <Layers size={14} className="text-neutral-500" />
          </div>
          <div className="fleet-metric-val">{profiles.length}</div>
          <div className="fleet-metric-sub">Identidades registradas</div>
        </div>

        <div className="fleet-metric-card">
          <div className="fleet-metric-header">
            <span>Sesiones Activas</span>
            <span className="w-2 h-2 rounded-full bg-white"></span>
          </div>
          <div className="fleet-metric-val">
            <span className="text-white">{activeCount}</span>
          </div>
          <div className="fleet-metric-sub">Instancias en ejecución</div>
        </div>

        <div className="fleet-metric-card">
          <div className="fleet-metric-header">
            <span>Perfiles con Proxy</span>
            <Wifi size={14} className="text-neutral-400" />
          </div>
          <div className="fleet-metric-val">
            <span>{profiles.filter(p => !!p.proxy && typeof p.proxy === 'string' && p.proxy.trim().length > 0).length}</span>
          </div>
          <div className="fleet-metric-sub">Túneles de red configurados</div>
        </div>

        <div className="fleet-metric-card">
          <div className="fleet-metric-header">
            <span>Etiquetas Activas</span>
            <TagIcon size={14} className="text-neutral-400" />
          </div>
          <div className="fleet-metric-val">{allTags.length}</div>
          <div className="fleet-metric-sub">Categorías organizadas</div>
        </div>
      </div>

      {/* ── MAIN DATA TABLE ── */}
      <div className="fleet-table-card">
        
        {/* Sub-header Filter Tabs */}
        <div className="fleet-sub-header">
          <div className="fleet-filter-pills">
            <button 
              type="button"
              onClick={() => { setSelectedTag(null); setStatusFilter('all'); }}
              className={`fleet-filter-pill ${selectedTag === null && statusFilter === 'all' ? 'active' : ''}`}
            >
              <Filter size={12} />
              <span>Todos ({profiles.length})</span>
            </button>

            <button 
              type="button"
              onClick={() => { setSelectedTag(null); setStatusFilter('running'); }}
              className={`fleet-filter-pill ${statusFilter === 'running' ? 'active' : ''}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
              <span>En Marcha ({activeCount})</span>
            </button>

            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => {
                  setSelectedTag(tag === selectedTag ? null : tag);
                  setStatusFilter('all');
                }}
                className={`fleet-filter-pill ${selectedTag === tag ? 'active' : ''}`}
              >
                <span>#{tag}</span>
              </button>
            ))}
          </div>

          <div className="text-xs font-mono text-neutral-500 whitespace-nowrap">
            <span>Mostrando <strong className="text-white">{filteredProfiles.length}</strong> de {profiles.length}</span>
          </div>
        </div>

        {/* Scrollable Table Viewport */}
        {loading ? (
          <div className="flex items-center justify-center py-24 text-neutral-400 font-semibold gap-2">
            <Loader2 size={20} className="spin text-white" />
            <span>Cargando flota de identidades...</span>
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-neutral-900 border border-white/10 flex items-center justify-center text-neutral-400 mb-3">
              <Globe size={22} />
            </div>
            <h4 className="text-sm font-extrabold text-white">
              {profiles.length === 0 ? 'No hay perfiles en la flota' : 'No se encontraron perfiles coincidentes'}
            </h4>
            <p className="text-xs text-neutral-500 max-w-sm mt-1 mb-4">
              {profiles.length === 0 
                ? 'Crea tu primera identidad stealth para iniciar sesiones con aislamiento de huella.'
                : 'Intenta modificar el término de búsqueda o seleccionar otra etiqueta.'}
            </p>
            {profiles.length === 0 && (
              <button type="button" onClick={openCreate} className="btn-fleet-primary btn-fleet-tactile">
                <Plus size={14} strokeWidth={2.5} />
                <span>Crear Primer Perfil</span>
              </button>
            )}
          </div>
        ) : (
          <>
          <div className="fleet-table-wrapper fleet-scroll desktop-table-only">
            <table className="fleet-table">
              <thead className="fleet-thead">
                <tr>
                  <th className="fleet-th" style={{ width: '42px', textAlign: 'center' }}>
                    <input 
                      type="checkbox"
                      checked={selectedIds.size === filteredProfiles.length && filteredProfiles.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded bg-black border-neutral-700 text-white cursor-pointer"
                      aria-label="Seleccionar todos"
                    />
                  </th>
                  <th className="fleet-th">Nombre & Perfil</th>
                  <th className="fleet-th">Ruta IP (Proxy)</th>
                  <th className="fleet-th">Huella Digital</th>
                  <th className="fleet-th">Estado</th>
                  <th className="fleet-th" style={{ width: '220px', textAlign: 'right' }}>Comandos</th>
                </tr>
              </thead>
              <tbody>
                {filteredProfiles.map((profile) => {
                  const id = String(profile.id || profile._id || '');
                  const isSelected = selectedIds.has(id);
                  const isRunning = Boolean(activeSessionsMap[id]);
                  const isStarting = startingIds.has(id);
                  const isTestingProxy = testingProxyIds.has(id);
                  const proxyRes = proxyResults[id];
                  const hasProxy = Boolean(profile.proxy);
                  const countryCode = proxyRes?.country_code || (hasProxy ? 'PRX' : 'HOST');

                  return (
                    <tr 
                      key={id}
                      onClick={() => { setInspectedProfile(profile); cargarDatosInspeccion(profile); }}
                      className={`fleet-row ${isRunning ? 'running' : ''} ${isSelected ? 'selected' : ''}`}
                    >
                      <td className="fleet-td" style={{ textAlign: 'center' }} onClick={(e) => toggleSelectOne(id, e)}>
                        <input 
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded bg-black border-neutral-700 text-white cursor-pointer"
                          aria-label={`Seleccionar ${profile.name}`}
                        />
                      </td>

                      {/* Name & OS Icon */}
                      <td className="fleet-td">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-neutral-300 shadow-inner shrink-0">
                            {renderOsIcon(profile.os)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-extrabold text-white text-xs tracking-tight truncate flex items-center gap-2">
                              <span>{profile.name}</span>
                              {profile.tags && profile.tags[0] && (
                                <span className="text-[10px] font-mono text-neutral-400 font-normal">
                                  #{profile.tags[0]}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-neutral-500 mt-0.5 flex items-center gap-2">
                              <span 
                                className="hover:text-white transition flex items-center gap-1 cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(id);
                                }}
                                title="Clic para copiar ID"
                              >
                                <Copy size={11} className="text-neutral-500" />
                                <span>{id.slice(0, 12)}...</span>
                              </span>
                              {profile.startUrl && (
                                <>
                                  <span>·</span>
                                  <span className="text-emerald-400 font-semibold flex items-center gap-1 truncate max-w-[130px]">
                                    <LinkIcon size={10} />
                                    <span>{profile.startUrl.replace(/^https?:\/\//, '')}</span>
                                  </span>
                                </>
                              )}
                            </div>

                            {/* Live 2FA TOTP Badge */}
                            {liveTotpCodes[id] && (
                              <div className="mt-1 flex items-center">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyTotp(id, liveTotpCodes[id].code);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold cursor-pointer hover:bg-emerald-900/80 transition"
                                  title="Clic para copiar código 2FA"
                                >
                                  <Key size={10} className="text-emerald-400" />
                                  <span>2FA: {liveTotpCodes[id].code} ({liveTotpCodes[id].remaining}s)</span>
                                  {copiedTotpId === id ? <Check size={10} className="text-emerald-300" /> : <Copy size={10} className="text-emerald-500" />}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Proxy Route & Latency */}
                      <td className="fleet-td">
                        <div className="flex items-center gap-2.5">
                          {hasProxy ? (
                            <div className="fleet-country-badge">
                              {countryCode.slice(0, 2).toUpperCase()}
                            </div>
                          ) : (
                            <div className="fleet-country-badge">
                              <Laptop size={11} className="text-neutral-400" />
                            </div>
                          )}

                          <div>
                            <div className="font-mono text-white text-xs font-semibold flex items-center gap-1.5">
                              <span className="truncate max-w-[150px]">
                                {hasProxy ? profile.proxy?.replace(/.*@/, '') : 'Conexión Directa'}
                              </span>
                              {hasProxy && renderLatencyBars(proxyRes?.latency_ms, proxyRes?.success)}
                            </div>
                            <div className="text-[10px] text-neutral-500 flex items-center gap-1 mt-0.5 font-mono">
                              <MapPin size={10} className="text-neutral-500" />
                              <span>
                                {hasProxy 
                                  ? (proxyRes?.city ? `${proxyRes.city}, ${proxyRes.country || ''}` : 'Proxy Asignado')
                                  : 'Host Match · Local IP'}
                                {proxyRes?.latency_ms && (
                                  <> · <strong className="text-emerald-400">{proxyRes.latency_ms}ms</strong></>
                                )}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Fingerprint Specs */}
                      <td className="fleet-td font-mono text-[11px]">
                        <div className="flex items-center gap-1.5 text-neutral-300">
                          <Cpu size={12} className="text-neutral-500" />
                          <span className={profile.os ? 'capitalize' : ''}>{profile.os || 'SO sin asignar'}</span>
                        </div>
                        <div className="text-neutral-500 text-[10px] mt-0.5 flex items-center gap-1">
                          <Shield size={11} className="text-emerald-400" />
                          {/* El hardware no se guarda en el perfil: la receta se
                              genera en el servidor al lanzar. Antes se pintaba
                              "8 Cores · 1920x1080 · Canvas Noise OK" fijo para
                              todos, aunque no se hubiera medido nada. */}
                          <span>Huella del servidor · se aplica al iniciar</span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="fleet-td">
                        {isRunning ? (
                          <span className="fleet-status-pill running">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-beacon"></span>
                            <span>En Marcha</span>
                          </span>
                        ) : (
                          <span className="fleet-status-pill stopped">
                            <span className="w-1.5 h-1.5 rounded-full bg-neutral-600"></span>
                            <span>Detenido</span>
                          </span>
                        )}
                      </td>

                      {/* Commands */}
                      <td className="fleet-td" style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <div className="fleet-row-actions">
                          {isRunning ? (
                            <button
                              type="button"
                              onClick={() => handleStopProfileSession(id)}
                              disabled={isStarting}
                              className="fleet-btn-stop btn-fleet-tactile"
                              title="Detener sesión activa y sincronizar cookies"
                            >
                              {isStarting ? <Loader2 size={12} className="spin" /> : <Square size={12} className="fill-current" />}
                              <span>Detener</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleStartSession(profile)}
                              disabled={isStarting}
                              className="fleet-btn-start btn-fleet-tactile"
                              title="Iniciar sesión aislada"
                            >
                              {isStarting ? <Loader2 size={12} className="spin" /> : <Play size={12} className="fill-current" />}
                              <span>Iniciar</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => openCookieManager(profile)}
                            className="fleet-btn-icon"
                            title="Gestionar Cookies"
                          >
                            <Cookie size={13} className="text-amber-400" />
                          </button>


                          <button
                            type="button"
                            onClick={() => handleDuplicateProfile(profile)}
                            className="fleet-btn-icon"
                            title="Duplicar Perfil"
                          >
                            <Copy size={13} />
                          </button>

                          <button
                            type="button"
                            onClick={() => openHealthModal(profile)}
                            className="fleet-btn-icon text-emerald-400 hover:text-emerald-300"
                            title="Auditoría de Salud & Trust Score Anti-Ban"
                          >
                            <Activity size={13} />
                          </button>

                          {localRotationLinks[id] && (
                            <button
                              type="button"
                              onClick={() => handleTriggerRotationUrl(id, localRotationLinks[id])}
                              className="fleet-btn-icon text-sky-400 hover:text-sky-300"
                              title="Rotar IP de este proxy móvil"
                            >
                              <RotateCw size={13} />
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => openEdit(profile)}
                            className="fleet-btn-icon"
                            title="Editar Perfil"
                          >
                            <Edit2 size={13} />
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError('');
                              setDeleteTarget(profile);
                            }}
                            className="fleet-btn-icon danger"
                            title="Eliminar Perfil"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Estados de carga, error y vacio.
              Antes, en los tres casos, se veian perfiles de ejemplo, asi que no
              habia forma de saber si lo que se veia era real. Ahora se dice lo
              que esta pasando. */}
          {(cargandoPerfiles || errorPerfiles) && (
            <div className="fleet-list-status">
              {cargandoPerfiles && <span className="fleet-list-status-txt">Cargando perfiles del servidor…</span>}
              {!cargandoPerfiles && errorPerfiles && (
                <>
                  <span className="fleet-list-status-err">{errorPerfiles}</span>
                  <button type="button" className="fleet-list-retry" onClick={() => window.location.reload()}>
                    Reintentar
                  </button>
                </>
              )}
            </div>
          )}

          {!cargandoPerfiles && !errorPerfiles && filteredProfiles.length === 0 && (
            <div className="fleet-list-status">
              <span className="fleet-list-status-txt">
                {searchQuery || selectedTag
                  ? 'Ningún perfil coincide con el filtro.'
                  : 'Todavía no tienes perfiles. Crea uno con «Nuevo Perfil Stealth».'}
              </span>
            </div>
          )}

          {/* Mobile Card List for Responsive Phone View */}
          <div className="fleet-mobile-cards mobile-cards-only">
            {filteredProfiles.map((profile) => {
              const id = String(profile.id || profile._id || '');
              const isSelected = selectedIds.has(id);
              const isRunning = Boolean(activeSessionsMap[id]);
              const isStarting = startingIds.has(id);
              const proxyRes = proxyResults[id];
              const hasProxy = Boolean(profile.proxy);

              return (
                <div 
                  key={`m-${id}`} 
                  className={`fleet-mobile-card ${isRunning ? 'running' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={() => { setInspectedProfile(profile); cargarDatosInspeccion(profile); }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input 
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        onClick={(e) => { e.stopPropagation(); toggleSelectOne(id, e); }}
                        className="rounded bg-black border-neutral-700 text-white cursor-pointer"
                        aria-label={`Seleccionar ${profile.name}`}
                      />
                      <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-neutral-300 shrink-0">
                        {renderOsIcon(profile.os)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-extrabold text-white text-xs tracking-tight truncate flex items-center gap-1.5">
                          <span className="truncate">{profile.name}</span>
                          {profile.tags && profile.tags[0] && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-neutral-300 font-normal shrink-0">
                              #{profile.tags[0]}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] font-mono text-neutral-500 mt-0.5">
                          {id.slice(0, 10)}... · {profile.os || 'SO sin asignar'}
                        </div>
                      </div>
                    </div>
                    <div>
                      {isRunning ? (
                        <span className="fleet-status-pill running text-[10px] px-2 py-0.5 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-beacon"></span>
                          <span>En Marcha</span>
                        </span>
                      ) : (
                        <span className="fleet-status-pill stopped text-[10px] px-2 py-0.5 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-neutral-600"></span>
                          <span>Detenido</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 text-[11px] font-mono text-neutral-400 bg-white/[0.02] p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-neutral-300 min-w-0">
                        {hasProxy && (
                          <span className="px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-bold text-white shrink-0">
                            {(proxyRes?.country_code || 'US').toUpperCase()}
                          </span>
                        )}
                        <MapPin size={11} className="text-neutral-500 shrink-0" />
                        <span className="truncate max-w-[170px]">{hasProxy ? profile.proxy?.replace(/.*@/, '') : 'Conexión Directa (Host)'}</span>
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {proxyRes?.latency_ms && (
                          <span className="text-emerald-400 font-bold text-[10px]">{proxyRes.latency_ms}ms</span>
                        )}
                        {hasProxy && renderLatencyBars(proxyRes?.latency_ms, proxyRes?.success)}
                      </div>
                    </div>

                    {liveTotpCodes[id] && (
                      <div className="mt-0.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyTotp(id, liveTotpCodes[id].code);
                          }}
                          className="w-full inline-flex items-center justify-between px-2 py-1 rounded bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold cursor-pointer"
                        >
                          <span className="flex items-center gap-1">
                            <Key size={10} className="text-emerald-400" />
                            <span>2FA: {liveTotpCodes[id].code}</span>
                          </span>
                          <span className="text-emerald-400/80">{liveTotpCodes[id].remaining}s</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                    {isRunning ? (
                      <button
                        type="button"
                        onClick={() => handleStopProfileSession(id)}
                        disabled={isStarting}
                        className="flex-1 h-9 rounded-lg bg-red-500/20 border border-red-500/40 hover:bg-red-500/30 text-red-400 font-bold text-xs flex items-center justify-center gap-1.5 transition"
                      >
                        {isStarting ? <Loader2 size={13} className="spin" /> : <Square size={13} className="fill-current" />}
                        <span>Detener</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleStartSession(profile)}
                        disabled={isStarting}
                        className="flex-1 h-9 rounded-lg bg-white hover:bg-neutral-200 text-black font-extrabold text-xs flex items-center justify-center gap-1.5 transition shadow-sm"
                      >
                        {isStarting ? <Loader2 size={13} className="spin" /> : <Play size={13} className="fill-current" />}
                        <span>Iniciar</span>
                      </button>
                    )}

                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => openCookieManager(profile)} className="fleet-btn-icon text-amber-400 hover:bg-amber-950/40" title="Cookies">
                        <Cookie size={14} />
                      </button>
                      <button type="button" onClick={() => openHealthModal(profile)} className="fleet-btn-icon text-emerald-400 hover:bg-emerald-950/40" title="Auditoría">
                        <Activity size={14} />
                      </button>
                      <button type="button" onClick={() => openEdit(profile)} className="fleet-btn-icon text-neutral-300 hover:text-white" title="Editar">
                        <Edit2 size={14} />
                      </button>
                      <button type="button" onClick={() => { setDeleteError(''); setDeleteTarget(profile); }} className="fleet-btn-icon text-red-400 hover:bg-red-950/40" title="Eliminar">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}

      </div>

      {/* ── SLIDE-OVER HARDWARE INSPECTOR DRAWER ── */}
      <aside className={`fleet-drawer ${inspectedProfile ? 'open' : ''}`}>
        {inspectedProfile && (
          <>
            <div className="fleet-drawer-content fleet-scroll">
              {isMobile && <div className="modal-drag-handle" style={{ margin: '0.2rem auto 0.75rem auto' }} />}
              <div className="flex items-center justify-between pb-3 border-b border-white/10">
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">{inspectedProfile.name}</h3>
                  <span className="text-[10px] font-mono text-neutral-500">
                    ID: {String(inspectedProfile.id || inspectedProfile._id).slice(0, 16)}...
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setInspectedProfile(null)}
                  className="w-7 h-7 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white flex items-center justify-center transition"
                >
                  <X size={15} />
                </button>
              </div>

              {/* Hardware & Environment Specs */}
              <div className="space-y-1.5 font-mono text-xs">
                <div className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Entorno Emulado</div>
                <div className="p-4 rounded-xl bg-black/60 border border-white/10 space-y-2.5 text-[11.5px]">
                  {/* ESTOS DATOS ESTABAN HARDCODEADOS.
                      Resolucion 1920x1080, 8 nucleos y "RTX 4070 / Direct3D 11"
                      se pintaban igual para todos los perfiles. En un perfil
                      Android significaba un movil con una GPU NVIDIA de
                      escritorio, que no existe: es incoherente y lo detecta
                      cualquiera que compare el SO con el renderer.
                      Ahora sale de la receta del perfil, y si no hay dato, "—". */}
                  <div className="flex justify-between">
                    <span className="text-neutral-400 font-sans">Sistema Operativo:</span>
                    <span className="text-white font-semibold capitalize">{inspectedProfile.os || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400 font-sans">Resolución:</span>
                    <span className="text-white font-semibold">
                      {datosInspeccion.screen
                        ? `${datosInspeccion.screen.width} × ${datosInspeccion.screen.height} (${datosInspeccion.screen.dpr ?? '—'}x)`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400 font-sans">CPU Cores:</span>
                    <span className="text-white font-semibold">
                      {datosInspeccion.cores ? `${datosInspeccion.cores} núcleos` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400 font-sans">GPU Renderer:</span>
                    <span className="text-white font-semibold break-all text-right max-w-[180px]">
                      {datosInspeccion.gpu || '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400 font-sans">URL de Inicio:</span>
                    <span className="text-white font-mono truncate max-w-[140px]">
                      {inspectedProfile.startUrl || inspectedProfile.start_url || 'https://google.com'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Network & Proxy Configuration */}
              <div className="space-y-1.5 font-mono text-xs">
                <div className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Red & Conexión</div>
                <div className="p-4 rounded-xl bg-black/60 border border-white/10 space-y-2 text-[11.5px]">
                  <div className="flex justify-between items-center">
                    <span className="text-neutral-400 font-sans">Enrutamiento:</span>
                    <span className="text-white font-semibold">
                      {inspectedProfile.proxy ? 'Túnel Proxy Dedicado' : 'Conexión Directa'}
                    </span>
                  </div>
                  {inspectedProfile.proxy && (
                    <div className="flex justify-between items-center">
                      <span className="text-neutral-400 font-sans">Proxy Configurado:</span>
                      <span className="text-white font-mono text-[10.5px] truncate max-w-[150px]">
                        {inspectedProfile.proxy}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-center pt-1 border-t border-white/5">
                    <span className="text-neutral-400 font-sans">Alineación GeoIP:</span>
                    <span className="text-white font-semibold">Automática (IP de salida)</span>
                  </div>
                </div>
              </div>

              {/* Automatic Antidetect Protection Badge (No user toggles) */}
              <div className="p-3.5 rounded-xl bg-black/60 border border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck size={18} className="text-white shrink-0" />
                  <div>
                    <div className="text-white font-semibold text-xs">Protección de Huella Digital</div>
                    <div className="text-[10px] text-neutral-400 font-mono">Calibrada automáticamente por el motor</div>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded bg-white text-black text-[10px] font-mono font-extrabold uppercase tracking-wider">
                  Activa
                </span>
              </div>
            </div>

            <div className="fleet-drawer-footer">
              <button 
                type="button"
                onClick={() => openEdit(inspectedProfile)}
                className="btn-fleet-secondary btn-fleet-tactile flex-1 justify-center"
              >
                <Edit2 size={13} />
                <span>Editar</span>
              </button>
              {activeSessionsMap[String(inspectedProfile.id || inspectedProfile._id)] ? (
                <button 
                  type="button"
                  onClick={() => handleStopProfileSession(String(inspectedProfile.id || inspectedProfile._id))}
                  className="fleet-btn-stop btn-fleet-tactile flex-1 justify-center"
                >
                  <Square size={13} className="fill-current" />
                  <span>Detener</span>
                </button>
              ) : (
                <button 
                  type="button"
                  onClick={() => handleStartSession(inspectedProfile)}
                  className="btn-fleet-primary btn-fleet-tactile flex-1 justify-center"
                >
                  <Play size={13} className="fill-current" />
                  <span>Iniciar</span>
                </button>
              )}
            </div>
          </>
        )}
      </aside>

      {/* ── FLOATING BOTTOM MULTI-ACTION DOCK ── */}
      <div className={`fleet-batch-dock ${selectedIds.size > 0 ? 'visible' : ''}`}>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="w-2 h-2 rounded-full bg-white"></span>
          <span className="font-extrabold text-white text-sm">{selectedIds.size}</span>
          <span className="text-neutral-400">seleccionados</span>
        </div>

        <div className="h-5 w-px bg-neutral-800"></div>

        <div className="flex items-center gap-2">
          <button 
            type="button"
            onClick={handleBatchStart}
            className="btn-fleet-primary btn-fleet-tactile"
            style={{ height: '2rem', padding: '0 0.85rem' }}
          >
            <Play size={12} className="fill-current" />
            <span>Iniciar Todos</span>
          </button>


          <button 
            type="button"
            onClick={handleBatchTestProxy}
            className="btn-fleet-secondary btn-fleet-tactile"
            style={{ height: '2rem' }}
          >
            <Wifi size={12} className="text-emerald-400" />
            <span>Test Proxies</span>
          </button>

          <button 
            type="button"
            onClick={handleBatchExport}
            className="btn-fleet-secondary btn-fleet-tactile"
            style={{ height: '2rem' }}
            title="Exportar identidades seleccionadas en formato JSON"
          >
            <Download size={12} />
            <span>Exportar JSON</span>
          </button>

          <button 
            type="button"
            onClick={handleBatchDelete}
            className="fleet-btn-stop btn-fleet-tactile"
            style={{ height: '2rem' }}
          >
            <Trash2 size={12} />
            <span>Eliminar</span>
          </button>

          <button 
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="w-7 h-7 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white flex items-center justify-center transition"
            title="Deseleccionar"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── MODAL: CREAR O EDITAR PERFIL (MINIMAL ZERO-LIES) ── */}
      {modalOpen && (
        <div className="glass-modal-overlay" onClick={() => !saving && setModalOpen(false)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} onClick={(e) => e.stopPropagation()}>
            {/* Mobile drag handle */}
            {isMobile && <div className="modal-drag-handle" />}

            <div className="glass-modal-header">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-white text-black flex items-center justify-center font-extrabold shadow-sm shrink-0">
                  <Plus size={16} strokeWidth={2.8} />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">
                    {editing ? 'Editar Perfil Stealth' : 'Nuevo Perfil Stealth'}
                  </h3>
                  <p className="text-[11px] text-neutral-400 font-mono">
                    Aislamiento de huella y túnel de conexión
                  </p>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setModalOpen(false)} 
                disabled={saving} 
                className="w-8 h-8 rounded-xl flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSaveProfile}>
              <div className="glass-modal-body space-y-4">
                {formError && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
                    {formError}
                  </div>
                )}

                {/* 1. Profile Name */}
                <div>
                  <label className="modal-section-label">
                    <span>Nombre del Perfil *</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Ej: Tienda Amazon US #01"
                    className="modal-input"
                    autoFocus
                    required
                  />
                </div>

                {/* 2. Proxy with Paste & Test */}
                <div>
                  <div className="modal-section-label flex items-center justify-between">
                    <span>Proxy de Red (Opcional)</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const clip = await navigator.clipboard.readText();
                            if (clip) {
                              setForm(prev => ({ ...prev, proxy: clip.trim() }));
                            }
                          } catch {}
                        }}
                        className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 cursor-pointer bg-transparent border-none"
                        title="Pegar desde el portapapeles"
                      >
                        <Copy size={11} />
                        <span>Pegar</span>
                      </button>
                      {form.proxy?.trim() && (
                        <button
                          type="button"
                          onClick={handleTestFormProxy}
                          disabled={formProxyTesting}
                          className="text-[11px] text-emerald-400 hover:text-emerald-300 font-mono flex items-center gap-1 cursor-pointer bg-transparent border-none"
                        >
                          {formProxyTesting ? <Loader2 size={11} className="spin" /> : <Wifi size={11} />}
                          <span>Probar</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    type="text"
                    value={form.proxy}
                    onChange={(e) => {
                      setForm({ ...form, proxy: e.target.value });
                      setFormProxyResult(null);
                    }}
                    placeholder="http://usuario:contraseña@ip:puerto"
                    className="modal-input font-mono text-xs"
                  />

                  {/* Proxy Test Feedback Result */}
                  {formProxyResult && (
                    <div className={`mt-2 p-2.5 rounded-xl text-xs font-mono ${
                      formProxyResult.success 
                        ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' 
                        : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
                    }`}>
                      {formProxyResult.success ? (
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5">
                            <CheckCircle2 size={13} className="text-emerald-400" />
                            <span>Conectado: {formProxyResult.ip} ({formProxyResult.country || 'OK'})</span>
                          </span>
                          <span className="font-bold text-emerald-300">{formProxyResult.latency_ms} ms</span>
                        </div>
                      ) : (
                        <span>{formProxyResult.error || 'Fallo de conexión en el proxy'}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* 3. Auto-Assigned Zero-Lies Fingerprint Card */}
                <div className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                      <ShieldCheck size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white flex items-center gap-1.5">
                        <span>Huella Zero-Lies Asignada</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/10 text-neutral-300 font-mono font-normal uppercase">
                          {form.os}
                        </span>
                      </div>
                      <p className="text-[10px] text-neutral-400 mt-0.5 truncate">
                        Alineada a tu SO real · Ruido en Canvas, WebGL, Audio y Timezone
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleGenerateRandomFp}
                    className="h-8 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-300 text-[11px] font-mono flex items-center gap-1 cursor-pointer transition shrink-0"
                    title="Regenerar semilla aleatoria de ruido"
                  >
                    <Shuffle size={12} className="text-emerald-400" />
                    <span>Barajar</span>
                  </button>
                </div>

                {/* 4. Tags & Quick Presets */}
                <div>
                  <label className="modal-section-label">
                    <span>Etiquetas / Categoría</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {['ecommerce', 'amazon', 'marketing', 'tiktok', 'social', 'google'].map(preset => {
                      const currentTags = (form.tags || '').split(',').map(t => t.trim()).filter(Boolean);
                      const isSelected = currentTags.includes(preset);
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            let nextTags: string[];
                            if (isSelected) {
                              nextTags = currentTags.filter(t => t !== preset);
                            } else {
                              nextTags = [...currentTags, preset];
                            }
                            setForm({ ...form, tags: nextTags.join(', ') });
                          }}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-mono transition border cursor-pointer ${
                            isSelected 
                              ? 'bg-white text-black border-white font-bold' 
                              : 'bg-white/5 border-white/10 text-neutral-400 hover:text-white'
                          }`}
                        >
                          #{preset}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="text"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder="Escribe etiquetas separadas por comas..."
                    className="modal-input text-xs"
                  />
                </div>

                {/* 5. Start URL (Optional) */}
                <div>
                  <label className="modal-section-label">
                    <span>Página de Inicio (Opcional)</span>
                  </label>
                  <input
                    type="text"
                    value={form.startUrl}
                    onChange={(e) => setForm({ ...form, startUrl: e.target.value })}
                    placeholder="https://..."
                    className="modal-input font-mono text-xs"
                  />
                </div>
              </div>

              <div className="glass-modal-footer">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-neutral-400 hover:text-white transition bg-transparent border-none cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="h-10 px-6 rounded-xl bg-white text-black font-extrabold text-xs shadow-md hover:bg-neutral-200 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40"
                >
                  {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} strokeWidth={2.8} />}
                  <span>{saving ? 'Guardando...' : editing ? 'Actualizar Perfil' : 'Crear Perfil Stealth'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: GENERACIÓN MASIVA (BULK) ── */}
      {bulkModalOpen && (
        <div className="glass-modal-overlay" onClick={() => !bulkCreating && setBulkModalOpen(false)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}
            <div className="glass-modal-header">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-white text-black flex items-center justify-center font-extrabold shadow-sm">
                  <Boxes size={15} strokeWidth={2.8} />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">Generación Masiva de Perfiles</h3>
                  <p className="text-[11px] text-neutral-400 font-mono">Creación automatizada de identidades en bloque</p>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setBulkModalOpen(false)} 
                disabled={bulkCreating} 
                className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleBulkCreate}>
              <div className="glass-modal-body">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="modal-section-label"><span>Cantidad</span></label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={bulkCount}
                      onChange={(e) => setBulkCount(Math.max(1, parseInt(e.target.value) || 1))}
                      className="modal-input font-mono"
                    />
                  </div>
                  <div>
                    <label className="modal-section-label"><span>Prefijo del Nombre</span></label>
                    <input
                      type="text"
                      value={bulkPrefix}
                      onChange={(e) => setBulkPrefix(e.target.value)}
                      placeholder="Ej: Facebook Ads"
                      className="modal-input"
                    />
                  </div>
                </div>

                <div>
                  <label className="modal-section-label"><span>Etiquetas (Comas)</span></label>
                  <input
                    type="text"
                    value={bulkTags}
                    onChange={(e) => setBulkTags(e.target.value)}
                    placeholder="campaña_01, ads"
                    className="modal-input text-xs"
                  />
                </div>

                <div>
                  <label className="modal-section-label">
                    <span>Lista de Proxies (1 por línea, opcional)</span>
                  </label>
                  <textarea
                    value={bulkProxy}
                    onChange={(e) => setBulkProxy(e.target.value)}
                    placeholder="http://user:pass@host:port&#10;http://user2:pass2@host2:port2"
                    rows={4}
                    className="modal-textarea font-mono text-xs fleet-scroll"
                  />
                </div>
              </div>

              <div className="glass-modal-footer">
                <button
                  type="button"
                  onClick={() => setBulkModalOpen(false)}
                  disabled={bulkCreating}
                  className="px-4 py-2 rounded-lg text-xs font-bold text-neutral-400 hover:text-white transition bg-transparent border-none cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={bulkCreating}
                  className="h-9 px-5 rounded-lg bg-white text-black font-extrabold text-xs shadow-sm hover:bg-neutral-200 transition flex items-center gap-1.5 cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  {bulkCreating ? <Loader2 size={13} className="spin" /> : <Boxes size={13} />}
                  <span>{bulkCreating ? 'Generando...' : `Generar ${bulkCount} Perfiles`}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: GESTIÓN DE COOKIES ── */}
      {cookieModalTarget && (
        <div className="glass-modal-overlay" onClick={() => !cookieLoading && setCookieModalTarget(null)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} style={{ maxWidth: '620px' }} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}
            <div className="glass-modal-header">
              <div className="flex items-center gap-2">
                <Cookie size={16} className="text-amber-400" />
                <h3 className="text-sm font-extrabold text-white tracking-tight">
                  Cookies de {cookieModalTarget.name}
                </h3>
              </div>
              <button 
                type="button" 
                onClick={() => setCookieModalTarget(null)} 
                disabled={cookieLoading}
                className="text-neutral-400 hover:text-white transition"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body space-y-3">
              {cookieMsg && (
                <div className={`p-3 rounded-xl text-xs font-mono ${
                  cookieMsg.type === 'success' 
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' 
                    : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
                }`}>
                  {cookieMsg.text}
                </div>
              )}

              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-400">Formato JSON (EditThisCookie) o Netscape:</span>
                <span className="text-[11px] font-mono text-emerald-400 font-bold flex items-center gap-1">
                  <CheckCircle2 size={12} />
                  <span>{cookieCount} Cookies Activas</span>
                </span>
              </div>

              <textarea
                value={cookiesJson}
                onChange={(e) => setCookiesJson(e.target.value)}
                placeholder='[{"name":"session_id","value":"...","domain":".shein.com"}]'
                className="w-full h-48 p-3 rounded-xl bg-black border border-white/10 font-mono text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-white transition fleet-scroll"
              />

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={handleClearCookies}
                  disabled={cookieLoading || cookieCount === 0}
                  className="text-xs text-rose-400 hover:underline flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 size={12} />
                  <span>Limpiar Todo</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyCookiesToClipboard}
                    disabled={!cookiesJson}
                    className="btn-fleet-secondary"
                    style={{ height: '2rem', padding: '0 0.75rem' }}
                  >
                    {copiedCookies ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    <span>{copiedCookies ? 'Copiado' : 'Copiar'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleDownloadCookiesFile}
                    disabled={!cookiesJson || cookiesJson === '[]'}
                    className="btn-fleet-secondary"
                    style={{ height: '2rem', padding: '0 0.75rem' }}
                  >
                    <Download size={12} />
                    <span>Descargar .json</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="glass-modal-footer">
              <button
                type="button"
                onClick={() => setCookieModalTarget(null)}
                disabled={cookieLoading}
                className="text-xs font-bold text-neutral-400 hover:text-white transition"
              >
                Cerrar
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleImportCookies(false)}
                  disabled={cookieLoading || !cookiesJson?.trim()}
                  className="btn-fleet-secondary btn-fleet-tactile"
                  style={{ height: '2.25rem' }}
                >
                  <Save size={13} />
                  <span>Solo Guardar</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleImportCookies(true)}
                  disabled={cookieLoading || !cookiesJson?.trim()}
                  className="btn-fleet-primary btn-fleet-tactile"
                  style={{ height: '2.25rem' }}
                >
                  <Play size={13} className="fill-current" />
                  <span>Inyectar y Abrir</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: CONFIRMAR ELIMINACIÓN ── */}
      {deleteTarget && (
        <div className="glass-modal-overlay" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}
            <div className="glass-modal-header">
              <h3 className="text-sm font-extrabold text-white tracking-tight">Eliminar Perfil</h3>
              <button 
                type="button" 
                onClick={() => setDeleteTarget(null)} 
                disabled={deleting}
                className="text-neutral-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body space-y-2 text-xs">
              {deleteError && (
                <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono">
                  {deleteError}
                </div>
              )}
              <p className="text-neutral-300 leading-relaxed">
                ¿Eliminar definitivamente el perfil <strong className="text-white font-bold">{deleteTarget.name}</strong>? Se borrarán sus cookies, partición y datos guardados.
              </p>
            </div>

            <div className="glass-modal-footer">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="text-xs font-bold text-neutral-400 hover:text-white transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => handleDeleteProfile(deleteTarget)}
                disabled={deleting}
                className="fleet-btn-stop btn-fleet-tactile"
              >
                {deleting ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                <span>{deleting ? 'Eliminando...' : 'Eliminar Definitivamente'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {proxyCheckerOpen && (
        <div className="glass-modal-overlay" onClick={() => !proxyCheckerRunning && setProxyCheckerOpen(false)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}
            <div className="glass-modal-header">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-white text-black flex items-center justify-center font-extrabold shadow-sm">
                  <Wifi size={15} strokeWidth={2.8} />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">Verificador Masivo de Proxies</h3>
                  <p className="text-[11px] text-neutral-400 font-mono">Diagnóstico en tiempo real de latencia, geolocalización e IP pública</p>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setProxyCheckerOpen(false)} 
                disabled={proxyCheckerRunning} 
                className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body space-y-3">
              <div>
                <div className="modal-section-label">
                  <span>Lista de Proxies a Verificar (1 por línea)</span>
                  <span className="text-[10px] text-neutral-500 font-normal">HTTP / HTTPS / SOCKS5</span>
                </div>
                <textarea
                  value={proxyCheckerInput}
                  onChange={(e) => setProxyCheckerInput(e.target.value)}
                  placeholder={"http://usuario:contraseña@proxy1.com:8080\nsocks5://192.168.1.1:1080"}
                  rows={3}
                  className="modal-textarea font-mono text-xs fleet-scroll"
                  disabled={proxyCheckerRunning}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={handleStartProxyCheck}
                  disabled={proxyCheckerRunning || !proxyCheckerInput?.trim()}
                  className="btn-fleet-primary btn-fleet-tactile"
                  style={{ height: '2.1rem', padding: '0 1rem' }}
                >
                  {proxyCheckerRunning ? <Loader2 size={13} className="spin" /> : <Wifi size={13} />}
                  <span>{proxyCheckerRunning ? 'Comprobando Conexiones...' : 'Iniciar Verificación en Vivo'}</span>
                </button>

                {proxyCheckerItems.some((i) => i.status === 'success') && (
                  <button
                    type="button"
                    onClick={handleCopyWorkingProxies}
                    className="btn-fleet-secondary btn-fleet-tactile"
                    style={{ height: '2.1rem' }}
                  >
                    <Copy size={13} />
                    <span>Copiar Proxies Vivos ({proxyCheckerItems.filter((i) => i.status === 'success').length})</span>
                  </button>
                )}
              </div>

              {/* Table of Results */}
              {proxyCheckerItems.length > 0 && (
                <div style={{ marginTop: '0.75rem', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', overflow: 'hidden', background: '#000000' }}>
                  <div style={{ maxHeight: '200px', overflowY: 'auto' }} className="fleet-scroll">
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.6875rem', fontFamily: 'JetBrains Mono, monospace' }}>
                      <thead style={{ background: '#0c0c0e', borderBottom: '1px solid rgba(255,255,255,0.08)', position: 'sticky', top: 0 }}>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.75rem', color: '#a1a1aa' }}>Proxy</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.75rem', color: '#a1a1aa', width: '90px' }}>Estado</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.75rem', color: '#a1a1aa', width: '80px' }}>Latencia</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.75rem', color: '#a1a1aa', width: '130px' }}>IP / País</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proxyCheckerItems.map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '0.45rem 0.75rem', color: '#ffffff', wordBreak: 'break-all' }}>
                              {item.raw.replace(/(:[^:@]+@)/, ':••••@')}
                            </td>
                            <td style={{ padding: '0.45rem 0.75rem' }}>
                              {item.status === 'testing' ? (
                                <span style={{ color: '#a1a1aa', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                  <Loader2 size={10} className="spin" /> Verificando
                                </span>
                              ) : item.status === 'success' ? (
                                <span style={{ color: '#ffffff', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                  <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#ffffff' }} /> Activo
                                </span>
                              ) : item.status === 'error' ? (
                                <span style={{ color: '#f87171' }} title={item.error}>
                                  Error
                                </span>
                              ) : (
                                <span style={{ color: '#71717a' }}>En espera</span>
                              )}
                            </td>
                            <td style={{ padding: '0.45rem 0.75rem', color: item.latency_ms ? '#ffffff' : '#71717a', fontWeight: item.latency_ms ? 700 : 400 }}>
                              {item.latency_ms ? `${item.latency_ms} ms` : '—'}
                            </td>
                            <td style={{ padding: '0.45rem 0.75rem', color: '#d4d4d8' }}>
                              {item.ip ? `${item.ip} (${item.country || 'OK'})` : item.error ? <span style={{ color: '#71717a', fontSize: '0.625rem' }}>{item.error.slice(0, 20)}</span> : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="glass-modal-footer">
              <span className="text-[11px] text-neutral-500 font-mono">
                {proxyCheckerItems.length > 0 ? `${proxyCheckerItems.filter((i) => i.status === 'success').length} de ${proxyCheckerItems.length} activos` : 'Listo para probar'}
              </span>
              <button
                type="button"
                onClick={() => setProxyCheckerOpen(false)}
                disabled={proxyCheckerRunning}
                className="btn-fleet-secondary btn-fleet-tactile"
                style={{ height: '2.1rem' }}
              >
                <span>Cerrar</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {healthModalTarget && (
        <div className="glass-modal-overlay" onClick={() => setHealthModalTarget(null)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'} max-w-lg`} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}
            <div className="glass-modal-header">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center shadow-sm">
                  <Activity size={15} />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">
                    Auditoría de Salud & Trust Score Anti-Ban
                  </h3>
                  <p className="text-[11px] text-neutral-400 font-mono">
                    {healthModalTarget.name}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHealthModalTarget(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body space-y-4">
              {healthLoading ? (
                <div className="p-8 flex flex-col items-center justify-center gap-3 text-neutral-400">
                  <Loader2 size={24} className="spin text-emerald-400" />
                  <span className="text-xs font-mono">Analizando congruencia técnica y proxy...</span>
                </div>
              ) : healthReport ? (
                <>
                  {/* Score Banner */}
                  <div className="p-4 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase font-mono font-bold text-neutral-400">Salud de Proxy y Cookies</div>
                      <div className="text-xs font-semibold text-neutral-200 mt-0.5">{healthReport.summary}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`text-2xl font-black font-mono ${
                        healthReport.score >= 85 ? 'text-emerald-400' : healthReport.score >= 60 ? 'text-amber-400' : 'text-rose-400'
                      }`}>
                        {healthReport.score}%
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                        healthReport.score >= 85 ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                        healthReport.score >= 60 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                        'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      }`}>
                        {healthReport.rating === 'EXCELLENT' ? 'Correcto' : healthReport.rating === 'FAIR' ? 'Revisar' : 'Con Problemas'}
                      </span>
                    </div>
                  </div>

                  {/* Checklist */}
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase font-mono font-bold text-neutral-400">Comprobaciones</div>
                    <div className="space-y-2 max-h-64 overflow-y-auto fleet-scroll pr-1">
                      {healthReport.checks.map((c, i) => (
                        <div key={i} className="p-3 rounded-lg bg-black/60 border border-white/5 flex items-start gap-2.5">
                          {c.status === 'pass' ? (
                            <CheckCircle2 size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                          ) : c.status === 'warn' ? (
                            <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
                          ) : (
                            <X size={15} className="text-rose-400 shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-white flex items-center justify-between">
                              <span>{c.label}</span>
                              <span className="text-[9px] font-mono uppercase text-neutral-500">{c.category}</span>
                            </div>
                            <div className="text-[11px] text-neutral-400 font-mono mt-0.5">{c.detail}</div>
                            {c.recommendation && (
                              <div className="mt-1 text-[10.5px] text-amber-300/90 bg-amber-500/10 p-1.5 rounded border border-amber-500/20 font-sans">
                                💡 <strong>Consejo:</strong> {c.recommendation}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            <div className="glass-modal-footer">
              <span className="text-[10px] text-neutral-500 font-mono">
                Evaluado localmente sin transferir datos
              </span>
              <button
                type="button"
                onClick={() => setHealthModalTarget(null)}
                className="btn-fleet-secondary btn-fleet-tactile"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: ROTADOR DE IP MÓVIL 4G/5G ── */}
      {mobileRotationOpen && (
        <div className="glass-modal-overlay" onClick={() => setMobileRotationOpen(false)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'} max-w-md`} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}
            <div className="glass-modal-header">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/40 flex items-center justify-center shadow-sm">
                  <Smartphone size={15} />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">
                    Rotador de IP 4G/5G (Modo Avión)
                  </h3>
                  <p className="text-[11px] text-neutral-400 font-mono">
                    Proxy Residencial Móvil Nativo Gratuito
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileRotationOpen(false)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body space-y-4">
              {/* Current IP display */}
              <div className="p-4 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase font-mono font-bold text-neutral-400">IP Pública Detectada</div>
                  <div className="text-base font-extrabold font-mono text-white mt-0.5">{detectedIp}</div>
                </div>
                <button
                  type="button"
                  onClick={fetchPublicIp}
                  className="btn-fleet-secondary btn-fleet-tactile p-2"
                  title="Refrescar IP"
                >
                  <RotateCw size={14} className={rotatingIp ? 'spin text-sky-400' : 'text-neutral-300'} />
                </button>
              </div>

              {/* Instructions */}
              <div className="p-3.5 rounded-xl bg-sky-950/40 border border-sky-500/20 text-sky-200 text-xs space-y-2">
                <div className="font-bold flex items-center gap-1.5 text-sky-300">
                  <Zap size={14} />
                  <span>Cómo funciona la rotación móvil:</span>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-neutral-300 font-sans">
                  <li>Toca el botón <strong>"Abrir Ajustes de Red"</strong> abajo.</li>
                  <li>Activa el <strong>Modo Avión</strong> durante 3 segundos.</li>
                  <li>Desactiva el <strong>Modo Avión</strong> para conectar a una nueva torre celular.</li>
                  <li>Tu operadora te asignará una nueva IP residencial 4G/5G limpia de inmediato.</li>
                </ol>
              </div>

              {/* Action */}
              <button
                type="button"
                onClick={handleOpenAirplaneSettings}
                className="btn-fleet-primary btn-fleet-tactile w-full justify-center py-2.5"
              >
                <Smartphone size={15} />
                <span>Abrir Ajustes / Modo Avión</span>
              </button>
            </div>

            <div className="glass-modal-footer">
              <span className="text-[10px] text-neutral-500 font-mono">
                Cero costo de proxies residenciales
              </span>
              <button
                type="button"
                onClick={() => setMobileRotationOpen(false)}
                className="btn-fleet-secondary btn-fleet-tactile"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: PERFIL FANTASMA EFÍMERO (BURNER) ── */}
      {burnerModalConfig && (
        <div className="glass-modal-overlay" onClick={() => !burnerLoading && setBurnerModalConfig(null)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}

            <div className="glass-modal-header">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center shadow-sm">
                  <Flame size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold text-white tracking-tight">
                    Perfil Fantasma Efímero
                  </h3>
                  <p className="text-[11px] text-neutral-400 font-mono">
                    Identidad 100% desechable · Cero rastro en disco
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBurnerModalConfig(null)}
                disabled={burnerLoading}
                className="w-8 h-8 rounded-xl flex items-center justify-center text-neutral-400 hover:text-white bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body space-y-3 text-xs">
              <div className="p-3.5 rounded-xl bg-neutral-900 border border-neutral-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400 font-mono text-[10px] uppercase">ID Sesión Volátil</span>
                  <span className="font-mono text-amber-400 font-bold">#{burnerModalConfig.profile_id.slice(-6).toUpperCase()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400 font-mono text-[10px] uppercase">Aislamiento SO</span>
                  <span className="font-mono text-white font-semibold">Zero-Lies Host Nativo</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-400 font-mono text-[10px] uppercase">Partición Temporal</span>
                  <span className="text-emerald-400 font-mono text-[10px] font-bold">RAM Volátil (Auto-destrucción)</span>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/20 text-amber-200/90 text-[11px] leading-relaxed">
                🛡️ <strong>Garantía de privacidad:</strong> Al cerrar la ventana del navegador, todas las cookies, caché, partición de almacenamiento e historial se evaporarán sin dejar huella en tu equipo.
              </div>
            </div>

            <div className="glass-modal-footer">
              <button
                type="button"
                onClick={() => setBurnerModalConfig(null)}
                disabled={burnerLoading}
                className="px-4 py-2 rounded-xl text-xs font-bold text-neutral-400 hover:text-white bg-transparent border-none cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmLaunchBurner}
                disabled={burnerLoading}
                className="h-10 px-5 rounded-xl bg-amber-400 hover:bg-amber-300 text-black font-extrabold text-xs flex items-center justify-center gap-2 cursor-pointer shadow-md transition"
              >
                {burnerLoading ? <Loader2 size={14} className="spin" /> : <Flame size={14} className="fill-current" />}
                <span>{burnerLoading ? 'Lanzando...' : 'Lanzar Instancia Fantasma'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default ProfilesView;

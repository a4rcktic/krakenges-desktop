import React, { useState, useEffect, useMemo } from 'react';
import { invoke } from '../../hooks/useAuth';
import { usePlatform } from '../../context/PlatformContext';
import { isMobileNative } from '../../services/mobileBrowser';
import { tauriService } from '../../services/tauri';
import { 
  Radio, 
  Clock, 
  Square, 
  Play, 
  Trash2, 
  Loader2, 
  X, 
  Layers, 
  Cpu,
  Activity,
  HardDrive,
  Globe,
  RefreshCw,
  ShieldCheck,
  Zap,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import './SessionsView.css';

export interface Session {
  id: string;
  status: string;
  profile_id: string;
  profileId: any;
  profile_name?: string;
  profileName?: string;
  started_at?: string;
  startedAt?: string;
  stopped_at?: string;
  stoppedAt?: string;
  duration?: number;
  createdAt?: string;
  proxy_country?: string;
  proxy_ip?: string;
  ram_mb?: number;
  cpu_percent?: number;
}

const api = typeof window !== 'undefined' ? (window as any).electronAPI : null;

type FilterType = 'all' | 'active' | 'stopped';

// SIN SESIONES DE EJEMPLO. Antes este array era el estado inicial: cuatro
// sesiones ficticias con nombres del tipo "Amazon Seller Pro #01" e IPs de
// ejemplo, y se veian "En Marcha" sin que hubiera ninguna sesion real. La lista
// ahora arranca vacia y se llena con apiGetSessions().


export function SessionsView() {
  const { platform } = usePlatform();
  const isMobile = platform === 'mobile' || isMobileNative;

  // La lista arranca VACIA y se carga del servidor. Antes el estado inicial eran
  // sesiones de ejemplo ("Amazon Seller Pro #01", IPs de ejemplo), y la pantalla
  // no consultaba al backend: en el móvil se veían sesiones corriendo que no
  // existían.
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cargandoSesiones, setCargandoSesiones] = useState(true);
  const [errorSesiones, setErrorSesiones] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [now, setNow] = useState(Date.now());
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  // Normaliza snake_case del backend al tipo de la vista.
  const normalizarSesion = (s: any): Session => ({
    id: String(s.id ?? s._id ?? ''),
    profile_id: String(s.profile_id ?? s.profileId ?? ''),
    profileId: s.profileId ?? null,
    profile_name: s.profile_name ?? s.profileName ?? s.name ?? 'Sin nombre',
    status: (s.status ?? 'stopped') as Session['status'],
    started_at: s.started_at ?? s.startedAt ?? undefined,
    stopped_at: s.stopped_at ?? s.stoppedAt ?? undefined,
    proxy_ip: s.proxy_ip ?? s.proxyIp ?? '',
    proxy_country: s.country_code ?? s.countryCode ?? s.proxy_country ?? '',
    ram_mb: typeof s.ram_mb === 'number' ? s.ram_mb : undefined,
    cpu_percent: typeof s.cpu_percent === 'number' ? s.cpu_percent : undefined,
  });

  /**
   * Tiempo acumulado REAL: suma de lo que las sesiones efectivamente duraron.
   * Antes ponia "2h 45m" fijo, sin mirar ninguna sesión.
   */
  const tiempoAcumuladoReal = useMemo(() => {
    const duraciones = sessions
      .map((s) => {
        if (!s.started_at) return 0;
        const fin = s.stopped_at ? new Date(s.stopped_at).getTime() : now;
        const ini = new Date(s.started_at).getTime();
        if (isNaN(ini) || isNaN(fin)) return 0;
        return Math.max(0, fin - ini);
      })
      .filter((ms) => ms > 0);
    if (duraciones.length === 0) return null;
    const total = duraciones.reduce((a, b) => a + b, 0);
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }, [sessions, now]);

  /**
   * Fugas WebRTC medidas. Si el servidor no manda el dato, es null y se
   * muestra "—". Antes salia "100% Blindado / 0 fugas" sin haber medido nada.
   */
  const fugasDetectadas = useMemo(() => {
    const conDato = sessions.filter((s) => typeof (s as any).webrtc_leaks === 'number');
    if (conDato.length === 0) return null;
    return conDato.reduce((acc: number, s: any) => acc + (s.webrtc_leaks || 0), 0);
  }, [sessions]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getElapsedTimer = (startTime?: string) => {
    if (!startTime) return '00:00:00';
    const start = new Date(startTime).getTime();
    if (isNaN(start)) return '00:00:00';
    const diff = Math.max(0, Math.floor((now - start) / 1000));
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  useEffect(() => {
    loadSessions(true);
    const interval = setInterval(() => {
      loadSessions(false);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!api?.onBrowserClosed) return;
    const unsubscribe = api.onBrowserClosed(() => {
      loadSessions(false);
    });
    return unsubscribe;
  }, []);

  const loadSessions = async (showSpinner = false) => {
    if (showSpinner) setCargandoSesiones(true);
    try {
      const data = await invoke<any[]>('server_sessions_list');
      // Siempre se reemplaza, aunque venga vacio. Antes solo se actualizaba si
      // habia al menos una sesion: al borrar la ultima, seguia en pantalla.
      setSessions(Array.isArray(data) ? data.map(normalizarSesion) : []);
      setErrorSesiones(null);
    } catch (err: any) {
      // Se conserva la ultima lectura valida y se avisa de que esta sin
      // actualizar. No se vacia la lista ni se rellena con ejemplos.
      setErrorSesiones(
        err?.message
          ? `No se pudieron actualizar las sesiones: ${err.message}`
          : 'No se pudieron actualizar las sesiones desde el servidor.'
      );
    } finally {
      setCargandoSesiones(false);
    }
  };

  const setBusy = (id: string, on: boolean) => {
    setBusyIds((prev) => {
      const s = new Set(prev);
      if (on) s.add(id);
      else s.delete(id);
      return s;
    });
  };

  const getSessionProfileId = (s: Session): string => {
    if (typeof s.profileId === 'object' && s.profileId !== null) {
      return String(s.profileId.id || s.profileId._id || '');
    }
    return String(s.profileId || s.profile_id || '');
  };

  const handleStopSession = async (session: Session) => {
    const sessionId = session.id;
    setBusy(sessionId, true);
    try {
      // Sin `.catch(() => {})`: si el servidor no confirma la parada, la fila
      // no se puede pintar como detenida. Antes el error se tragaba y la UI
      // decia "Instancia Chromium detenida" igualmente.
      let alreadyStopped = false;
      try {
        await invoke('server_stop_session', { sessionId });
      } catch (err: any) {
        const msg = String(err?.message || '');
        // El monitor de vida puede haber cerrado la sesión un instante antes
        // (por ejemplo, si el navegador acaba de cerrarse). En ese caso la
        // parada ya está hecha y solo falta cerrar la ventana local.
        if (/already stopped|ya (está|esta) detenida/i.test(msg)) {
          alreadyStopped = true;
        } else {
          throw err;
        }
      }

      const profileId = getSessionProfileId(session);
      if (profileId) {
        await tauriService.closeProfile(profileId).catch((err) => {
          console.warn('No se pudo cerrar la ventana local del perfil:', err);
        });
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, status: 'stopped', stopped_at: new Date().toISOString(), ram_mb: undefined, cpu_percent: undefined }
            : s
        )
      );
      showToast(alreadyStopped ? 'Sesion cerrada' : 'Sesion detenida');
    } catch (err: any) {
      console.error('Error stopping session:', err);
      showToast(`No se pudo detener la sesion: ${err?.message || 'error del servidor'}`);
    } finally {
      setBusy(sessionId, false);
    }
  };

  const handleStopAll = async () => {
    const active = sessions.filter((s) => s.status === 'active');
    if (active.length === 0) return;
    active.forEach((s) => setBusy(s.id, true));
    try {
      const results = await Promise.allSettled(
        active.map((s) => invoke('server_stop_session', { sessionId: s.id }))
      );
      const stoppedIds = new Set(
        active
          .filter((_, i) => {
            if (results[i].status === 'fulfilled') return true;
            const msg = String((results[i] as any).reason?.message || '');
            return /already stopped|ya (está|esta) detenida/i.test(msg);
          })
          .map((s) => s.id)
      );
      const failed = active.length - stoppedIds.size;

      // Cerrar también las ventanas locales: antes "Detener" solo cambiaba el
      // estado en el servidor y el navegador seguía abierto, por lo que luego
      // "Retomar" fallaba con "este perfil ya tiene una ventana activa".
      await Promise.allSettled(
        active
          .filter((s) => stoppedIds.has(s.id))
          .map((s) => {
            const profileId = getSessionProfileId(s);
            return profileId ? tauriService.closeProfile(profileId) : Promise.resolve(false);
          })
      );

      setSessions((prev) =>
        prev.map((s) =>
          stoppedIds.has(s.id)
            ? { ...s, status: 'stopped', stopped_at: new Date().toISOString(), ram_mb: undefined, cpu_percent: undefined }
            : s
        )
      );

      if (failed === 0) {
        showToast('Todas las sesiones fueron detenidas');
      } else {
        showToast(`Detenidas ${stoppedIds.size} de ${active.length}. ${failed} fallaron.`);
      }
    } finally {
      active.forEach((s) => setBusy(s.id, false));
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    setBusy(sessionId, true);
    try {
      // Igual que al detener: solo se quita de la lista si el servidor confirma.
      await invoke('server_delete_session', { sessionId });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setDeleteTarget(null);
      showToast('Registro de sesion eliminado');
    } catch (err: any) {
      console.error('Error deleting session:', err);
      showToast(`No se pudo eliminar la sesion: ${err?.message || 'error del servidor'}`);
    } finally {
      setBusy(sessionId, false);
    }
  };

  const handleResume = async (session: Session) => {
    setBusy(session.id, true);
    try {
      let profile: any = null;
      const pid =
        typeof session.profileId === 'object' && session.profileId !== null
          ? session.profileId.id || session.profileId._id
          : session.profileId || session.profile_id;

      if (typeof session.profileId === 'object' && session.profileId !== null) {
        profile = {
          id: session.profileId.id || session.profileId._id,
          name: session.profileId.name || session.profileName || session.profile_name || 'Perfil',
          proxy: session.profileId.proxy ?? null,
          startUrl: session.profileId.startUrl ?? session.profileId.start_url ?? null,
        };
      } else {
        let profiles: any[] = [];
        try {
          profiles = (await invoke<any[]>('server_profiles_list')) || [];
        } catch {
          profiles = (await invoke<any[]>('server_profiles_list').catch(() => [])) || [];
        }
        profile = (profiles || []).find((p) => (p.id || p._id) === pid);
        if (!profile) {
          profile = {
            id: pid,
            name: session.profileName || session.profile_name || 'Perfil',
          };
        }
      }

      // Si la sesion no estaba activa, se reactiva primero. Si el servidor no
      // la reactiva, se aborta: no se puede lanzar un perfil con un id de
      // sesion que el backend no reconoce.
      let sessionId: string = session.id;
      if (session.status !== 'active') {
        const reactivated = await invoke<any>('server_reactivate_session', { sessionId: session.id });
        sessionId = reactivated?.id || reactivated?._id || session.id;
      }

      try {
        const { tauriService } = await import('../../services/tauri');
        await tauriService.launchProfile({
          profile_id: profile.id || profile._id,
          profile_name: profile.name,
          start_url: profile.startUrl ?? profile.start_url ?? undefined,
          proxy: profile.proxy || undefined,
          os: profile.os || 'windows',
          user_agent: profile.userAgent || profile.user_agent || undefined,
          session_id: sessionId || undefined,
        });
      } catch (err: any) {
        // Antes este catch decia "Optimistic resume in demo" y seguia: pintaba
        // la sesion como activa y mostraba "Navegacion reactivada" aunque el
        // navegador no se hubiera lanzado.
        console.error('Error launching profile:', err);
        showToast(`No se pudo lanzar el perfil: ${err?.message || 'error del motor'}`);
        return;
      }

      // Al arrancar se marca activa y con la hora de inicio, que son hechos
      // comprobables. RAM y CPU no se inventan: se dejan sin medir hasta que el
      // servidor las reporte.
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id
            ? { ...s, status: 'active', started_at: new Date().toISOString(), ram_mb: undefined, cpu_percent: undefined }
            : s
        )
      );
      showToast(`Navegacion reactivada: ${profile.name}`);
    } catch (err: any) {
      console.error('Error resuming session:', err);
      showToast(`No se pudo reactivar la sesion: ${err?.message || 'error del servidor'}`);
    } finally {
      setBusy(session.id, false);
    }
  };

  const filteredSessions = sessions.filter((s) => {
    if (filter === 'active') return s.status === 'active';
    if (filter === 'stopped') return s.status === 'stopped';
    return true;
  });

  const activeSessions = sessions.filter((s) => s.status === 'active');
  const stoppedSessions = sessions.filter((s) => s.status === 'stopped');
  const activeCount = activeSessions.length;
  const stoppedCount = stoppedSessions.length;

  // RAM total: solo la que el servidor ha medido. Antes sumaba 320 MB por
  // sesión como valor por defecto ("| 320"), asi que una sesión sin medir
  // contaba como si ocupara 320 MB.
  const totalRamMb = useMemo(() => {
    const medidas = activeSessions.map((s) => s.ram_mb).filter((v): v is number => typeof v === 'number');
    if (medidas.length === 0) return null;
    return medidas.reduce((a, b) => a + b, 0);
  }, [activeSessions]);

  const formatDuration = (ms?: number) => {
    if (!ms) return '—';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getProfileName = (s: Session) =>
    s.profileName || s.profile_name ||
    (typeof s.profileId === 'object' && s.profileId !== null ? s.profileId.name : null) ||
    (typeof s.profileId === 'string' ? s.profileId.slice(-6) : s.profile_id) ||
    'Perfil sin nombre';

  const getCountryBadge = (s: Session) => {
    // Antes se deducia el pais de si el id contenia "us", "de"... y por defecto
    // devolvia "BR". Eso no era una medicion: era una suposicion pintada como
    // dato. Ahora solo se muestra lo que el servidor reporta.
    return s.proxy_country || '—';
  };

  return (
    <div className={`fleet-sessions-view fleet-scroll ${isMobile ? 'is-mobile-view' : 'is-desktop-view'}`}>
      
      {/* Toast Alert */}
      {(errorSesiones || toastMsg) && (
        <div className="sessions-toast">
          {errorSesiones ? (
            <AlertTriangle size={15} className="text-amber-400" />
          ) : (
            <CheckCircle2 size={15} className="text-emerald-400" />
          )}
          <span>{errorSesiones || toastMsg}</span>
        </div>
      )}

      {/* ── TOP METRIC TELEMETRY CARDS ── */}
      <div className="sessions-metrics-grid">
        <div className="session-metric-card">
          <div className="metric-header-row">
            <span className="metric-label">Instancias Activas</span>
            <div className={`metric-status-dot ${activeCount > 0 ? 'pulse' : ''}`} />
          </div>
          <div className="metric-val-row">
            <span className="metric-val">{cargandoSesiones ? '—' : activeCount}</span>
            <span className="metric-limit">Activas</span>
          </div>
          <span className="metric-sub">
            {cargandoSesiones
              ? 'Consultando al servidor…'
              : activeCount > 0
                ? 'Instancias en marcha ahora mismo'
                : 'Ninguna sesión en marcha'}
          </span>
        </div>

        {/* Consumo real, no estimado. Antes ponia "~631 MB" obtenido con una
            multiplicacion (activeCount * 2.1) y "~4.2% Carga CPU Flota" con
            otra. Ninguna de las dos era una medición. */}
        <div className="session-metric-card">
          <div className="metric-header-row">
            <span className="metric-label">Consumo de Memoria</span>
            <HardDrive size={15} className="text-neutral-400" />
          </div>
          <div className="metric-val-row">
            <span className="metric-val">{totalRamMb === null ? '—' : totalRamMb}</span>
            <span className="metric-limit">MB RAM</span>
          </div>
          <span className="metric-sub">
            {totalRamMb === null ? 'Sin medir por el servidor' : 'Suma de las sesiones en marcha'}
          </span>
        </div>

        {/* SIN MÉTRICAS INVENTADAS.

            Estas cuatro tarjetas mostraban valores fijos: "2h 45m" de tiempo
            acumulado, "~631 MB" de memoria calculada con una multiplicación
            (activeCount * 2.1), "100% Blindado" y "0 fugas WebRTC". Ninguno
            venía de una medición: eran constantes escritas a mano.

            En un producto que promete no mentir sobre la huella, prometer
            "100% Zero-Lies, 0 fugas" sin haber ejecutado una sola medición es
            exactamente la mentira que el producto no debe contar. Por eso, si
            no hay dato, se muestra "—" y el texto lo dice. */}
        <div className="session-metric-card">
          <div className="metric-header-row">
            <span className="metric-label">Tiempo Acumulado</span>
            <Clock size={15} className="text-neutral-400" />
          </div>
          <div className="metric-val-row">
            <span className="metric-val">{tiempoAcumuladoReal ?? '—'}</span>
            <span className="metric-limit">Histórico</span>
          </div>
          <span className="metric-sub">
            {sessions.length} {sessions.length === 1 ? 'ejecución registrada' : 'ejecuciones registradas'}
          </span>
        </div>

        <div className="session-metric-card">
          <div className="metric-header-row">
            <span className="metric-label">Auditoría Zero-Lies</span>
            <ShieldCheck size={15} className="text-neutral-400" />
          </div>
          <div className="metric-val-row">
            <span className="metric-val">{fugasDetectadas === null ? '—' : fugasDetectadas}</span>
            <span className="metric-limit">{fugasDetectadas === null ? 'Sin medir' : 'Fugas WebRTC'}</span>
          </div>
          <span className="metric-sub">
            {fugasDetectadas === null
              ? 'Se verifica al abrir cada sesión'
              : fugasDetectadas === 0
                ? 'Ninguna fuga en las sesiones medidas'
                : `${fugasDetectadas} fuga(s) en las sesiones medidas`}
          </span>
        </div>
      </div>

      {/* ── HEADER & TOOLBAR ── */}
      <div className="sessions-header">
        <div className="sessions-title-wrap">
          <div className="flex items-center gap-2">
            <h1 className="sessions-title">Registro de Sesiones</h1>
            <span className="sessions-version-pill">LIVE KERNEL</span>
          </div>
          <p className="sessions-subtitle">
            Monitoreo en vivo de instancias Chromium, consumo y tiempos de navegación
          </p>
        </div>

        <div className="sessions-actions-bar">
          <div className="sessions-filter-group">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`sessions-filter-btn ${filter === 'all' ? 'active' : ''}`}
            >
              Todas ({sessions.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('active')}
              className={`sessions-filter-btn ${filter === 'active' ? 'active' : ''}`}
            >
              <span className="sessions-live-dot" />
              <span>Activas ({activeCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setFilter('stopped')}
              className={`sessions-filter-btn ${filter === 'stopped' ? 'active' : ''}`}
            >
              Detenidas ({stoppedCount})
            </button>
          </div>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={handleStopAll}
              className="btn-stop-all"
              title="Detener todas las instancias de Chromium activas"
            >
              <Square size={13} className="fill-current" />
              <span>Detener Todo ({activeCount})</span>
            </button>
          )}
        </div>
      </div>

      {/* ── DESKTOP VIEW: HIGH-CONTRAST SESSIONS TABLE ── */}
      <div className="sessions-desktop-container">
        <div className="sessions-card">
          {cargandoSesiones ? (
            <div className="sessions-empty-state">
              <Loader2 size={24} className="spin text-neutral-300 mb-2" />
              <span className="text-xs text-neutral-400">Consultando sesiones...</span>
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="sessions-empty-state">
              <div className="sessions-empty-icon">
                <Radio size={24} />
              </div>
              <h4 className="sessions-empty-title">No hay sesiones en esta vista</h4>
              <p className="sessions-empty-desc">
                Inicia cualquier perfil stealth desde la sección "Perfiles" para monitorear su ejecución en vivo.
              </p>
            </div>
          ) : (
            <div className="sessions-table-wrapper">
              <table className="sessions-table">
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>Identidad / Perfil</th>
                    <th style={{ width: '18%' }}>Túnel & Proxy</th>
                    <th style={{ width: '16%' }}>Estado & RAM</th>
                    <th style={{ width: '16%' }}>Tiempo de Vuelo</th>
                    <th style={{ width: '20%', textAlign: 'right' }}>Comandos</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((session) => {
                    const isActive = session.status === 'active';
                    const busy = busyIds.has(session.id);
                    const profileName = getProfileName(session);
                    const country = getCountryBadge(session);

                    return (
                      <tr key={session.id} className={isActive ? 'row-active' : ''}>
                        {/* Name & ID */}
                        <td>
                          <div className="session-identity-cell">
                            <div className={`session-avatar ${isActive ? 'avatar-active' : ''}`}>
                              <Layers size={14} />
                            </div>
                            <div className="min-w-0">
                              <div className="session-name truncate">{profileName}</div>
                              <div className="session-id-sub font-mono">
                                {session.id}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Proxy & Country */}
                        <td>
                          <div className="flex items-center gap-2">
                            <span className="session-country-badge">{country}</span>
                            <div className="font-mono text-xs text-neutral-400">
                              {session.proxy_ip || '—'}
                            </div>
                          </div>
                        </td>

                        {/* Status & RAM */}
                        <td>
                          <div className="flex items-center gap-2">
                            {isActive ? (
                              <span className="session-badge-active">
                                <span className="session-beacon-dot" />
                                <span>En Marcha</span>
                              </span>
                            ) : (
                              <span className="session-badge-stopped">
                                <span>Detenida</span>
                              </span>
                            )}
                            {isActive && (
                              <span className="session-ram-pill">
                                {session.ram_mb ?? '—'}{session.ram_mb !== undefined ? ' MB' : ''}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Flight Time / Duration */}
                        <td>
                          {isActive ? (
                            <div className="session-uptime-live font-mono">
                              <Clock size={13} className="text-emerald-400" />
                              <span>{getElapsedTimer(session.startedAt || session.started_at || session.createdAt)}</span>
                            </div>
                          ) : (
                            <span className="font-mono text-xs text-neutral-400">
                              {formatDuration(session.duration)}
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="session-actions-cell">
                          <div className="session-actions-group">
                            {isActive ? (
                              <button
                                type="button"
                                onClick={() => handleStopSession(session)}
                                disabled={busy}
                                className="btn-session-stop"
                                title="Detener instancia"
                              >
                                {busy ? <Loader2 size={12} className="spin" /> : <Square size={12} className="fill-current" />}
                                <span>Detener</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleResume(session)}
                                disabled={busy}
                                className="btn-session-resume"
                                title="Retomar navegación"
                              >
                                {busy ? <Loader2 size={12} className="spin" /> : <Play size={12} className="fill-current" />}
                                <span>Retomar</span>
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => setDeleteTarget(session)}
                              disabled={busy || isActive}
                              className="btn-session-delete"
                              title="Eliminar registro"
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
          )}
        </div>
      </div>

      {/* ── MOBILE VIEW: TACTILE SESSION CARDS ── */}
      <div className="sessions-mobile-container">
        {filteredSessions.length === 0 ? (
          <div className="sessions-empty-state">
            <Radio size={28} className="text-neutral-500 mb-2" />
            <h4 className="sessions-empty-title">Sin sesiones registradas</h4>
            <p className="sessions-empty-desc">Inicia perfiles para monitorear su actividad aquí.</p>
          </div>
        ) : (
          <div className="mobile-sessions-cards-list">
            {filteredSessions.map((session) => {
              const isActive = session.status === 'active';
              const busy = busyIds.has(session.id);
              const profileName = getProfileName(session);
              const country = getCountryBadge(session);

              return (
                <div key={session.id} className={`mob-session-card ${isActive ? 'is-active' : ''}`}>
                  {/* Card Header */}
                  <div className="mob-session-card-header">
                    <div className="flex items-center gap-2">
                      {isActive ? (
                        <span className="mob-badge-active">
                          <span className="session-beacon-dot" />
                          <span>EN MARCHA</span>
                        </span>
                      ) : (
                        <span className="mob-badge-stopped">DETENIDA</span>
                      )}
                      <span className="mob-country-badge">{country}</span>
                    </div>

                    <div className="mob-uptime-badge font-mono">
                      <Clock size={12} className={isActive ? 'text-emerald-400' : 'text-neutral-500'} />
                      <span>
                        {isActive 
                          ? getElapsedTimer(session.startedAt || session.started_at || session.createdAt)
                          : formatDuration(session.duration)}
                      </span>
                    </div>
                  </div>

                  {/* Card Body */}
                  <div className="mob-session-card-body">
                    <h3 className="mob-session-title">{profileName}</h3>
                    <div className="mob-session-meta font-mono">
                      <span>IP: {session.proxy_ip || '—'}</span>
                      {isActive && <span>• RAM: {session.ram_mb ?? '—'}{session.ram_mb !== undefined ? ' MB' : ''}</span>}
                    </div>
                  </div>

                  {/* Card Footer Actions */}
                  <div className="mob-session-card-actions">
                    {isActive ? (
                      <button
                        type="button"
                        onClick={() => handleStopSession(session)}
                        disabled={busy}
                        className="mob-btn-stop"
                      >
                        {busy ? <Loader2 size={13} className="spin" /> : <Square size={13} className="fill-current" />}
                        <span>Detener Instancia</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleResume(session)}
                        disabled={busy}
                        className="mob-btn-resume"
                      >
                        {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} className="fill-current" />}
                        <span>Retomar Sesión</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setDeleteTarget(session)}
                      disabled={busy || isActive}
                      className="mob-btn-trash"
                      title="Eliminar historial"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── MODAL: CONFIRMAR ELIMINACIÓN DE SESIÓN ── */}
      {deleteTarget && (
        <div className="glass-modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className={`glass-modal-box ${isMobile ? 'modal-bottom-sheet' : 'modal-desktop-centered'}`} style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div className="modal-drag-handle" />}

            <div className="glass-modal-header">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-neutral-900 border border-red-500/30 flex items-center justify-center text-red-500">
                  <Trash2 size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white m-0">Eliminar Historial</h3>
                  <p className="text-xs text-neutral-400 font-mono m-0">Acción irreversible</p>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setDeleteTarget(null)} 
                className="w-8 h-8 rounded-xl flex items-center justify-center text-neutral-400 hover:text-white bg-transparent border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="glass-modal-body">
              <p className="text-xs text-neutral-300 m-0 leading-relaxed">
                ¿Deseas purgar permanentemente el registro de sesión de <strong className="text-white">{getProfileName(deleteTarget)}</strong>?
              </p>
            </div>

            <div className="glass-modal-footer">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-neutral-400 hover:text-white transition bg-transparent border-none cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => handleDeleteSession(deleteTarget.id)}
                className="btn-session-stop"
                style={{ height: '2.4rem', padding: '0 1.25rem' }}
              >
                Eliminar Registro
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default SessionsView;

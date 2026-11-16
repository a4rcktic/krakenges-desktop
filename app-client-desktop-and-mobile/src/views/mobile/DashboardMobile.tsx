import { useState, useEffect } from 'react';
import { 
  Plus, 
  Layers, 
  Radio, 
  Clock, 
  ShieldCheck, 
  ArrowRight, 
  Shield, 
  CreditCard, 
  Settings, 
  UserCheck, 
  Sparkles,
  Zap,
  Globe,
  Smartphone,
  ChevronRight,
  TrendingUp,
  Fingerprint,
  LogOut
} from 'lucide-react';
import { User, DashboardData, invoke } from '../../hooks/useAuth';
import { effectivePlanCodename, effectivePlanFleetLabel } from '../../domain/plans';
import { formatCount, formatMinutes } from '../../utils/format';
import { InteractiveBackground } from '../../components/Common/InteractiveBackground';
import './DashboardMobile.css';

interface Props {
  user: User;
  onNavigate?: (view: any) => void;
  onLogout?: () => void;
}

// SIN SESIONES DE EJEMPLO.
//
// Antes, si el backend devolvia la lista vacia, se pintaban tres sesiones
// inventadas que decian "Chrome 128" mientras el WebView del movil es 154. En la
// pantalla de inicio, la primera que ve el usuario, eso es directamente mentir.
//
// Ahora la lista arranca vacia. Si el backend no manda navegador, se muestra
// "—" en lugar de inventar uno.

export function DashboardMobile({ user, onNavigate, onLogout }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  // Si el backend falla, se avisa. Antes se rellenaba con datos inventados.
  const [errorDashboard, setErrorDashboard] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);

  useEffect(() => {
    loadDashboard();
    const interval = setInterval(loadDashboard, 6000);
    return () => clearInterval(interval);
  }, []);

  const loadDashboard = async () => {
    try {
      const dash = await invoke<DashboardData>('server_get_dashboard');
      if (dash) {
        setData(dash);
        setErrorDashboard(false);
        // Siempre se reemplaza la lista, aunque venga vacia. Antes solo se
        // actualizaba si habia al menos una sesion: si el usuario borraba
        // todas, el panel seguia mostrando las de la ultima carga.
        setSessions((dash.latestSessions || []).map((s: any, idx: number) => {
          // El nombre del perfil llega dentro de profileId, porque el backend
          // lo hace populate. Si populate devuelve null (el perfil se borro),
          // antes se caia a "Perfil #1", un nombre inventado que parecia real.
          // Ahora se dice que el perfil ya no existe.
          const perfil = s.profileId;
          const nombre = perfil?.name || s.profile_name;
          return {
            id: s._id || s.id || `session-${idx}`,
            name: nombre || (perfil === null ? 'Perfil eliminado' : 'Sin nombre'),
            // El modelo Profile no guarda navegador; se muestra "—" hasta que
            // el backend lo derive de la receta. No se inventa "Chrome 128".
            browser: perfil?.browser || s.browser || '—',
            os: perfil?.os || s.os || '—',
            status: s.status === 'active' ? 'active' : 'stopped',
            duration: s.status === 'active' ? 'Activa' : 'Detenida',
            proxy: s.proxy || '—',
          };
        }));
      }
    } catch {
      // Si el backend no responde, NO se rellena con datos de ejemplo. Antes se
      // ponian 3 perfiles, 2 sesiones y 145 minutos, y no habia forma de saber
      // que eran inventados. Ahora se muestran ceros reales y un aviso.
      setData({
        profilesCount: 0,
        sessionsCount: 0,
        activeSessionsCount: 0,
        totalMinutes: 0,
        latestSessions: [],
      });
      setErrorDashboard(true);
    } finally {
      setLoading(false);
    }
  };

  const planLabel = effectivePlanFleetLabel(user);

  return (
    <div className="mob-dash-container">
      {/* Si el servidor no responde, se dice. Antes se rellenaba con 3 perfiles,
          2 sesiones y 145 minutos inventados, indistinguibles de los reales. */}
      {errorDashboard && (
        <div className="mob-dash-error">
          No se pudo conectar con el servidor. Las cifras mostradas pueden estar incompletas.
        </div>
      )}
      {/* Main Touch Content Surface */}
      <div className="mob-dash-content">
        
        {/* ========================================================
            TOP MOBILE APP BAR (TOUCH COMPACT HEADER)
            ======================================================== */}
        <header className="mob-dash-header">
          <div className="mob-user-avatar-wrap">
            <div className="mob-user-avatar">
              <span>{(user.name || 'Operador')[0].toUpperCase()}</span>
            </div>
            <div className="mob-user-meta">
              <span className="mob-greeting">Hola de nuevo,</span>
              <h2 className="mob-user-name">{user.name || 'Operador'}</h2>
            </div>
          </div>

          <div className="mob-header-status">
            <div className="mob-live-badge">
              <span className="mob-pulse-dot" />
              <span>STEALTH</span>
            </div>
            {onLogout && (
              <button
                type="button"
                onClick={onLogout}
                className="mob-logout-btn"
                title="Cerrar sesión"
                aria-label="Cerrar sesión"
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </header>

        {/* ========================================================
            HERO ACTION BENTO CARD (1-TOUCH PROFILE LAUNCH)
            ======================================================== */}
        <div className="mob-hero-card">
          <div className="mob-hero-bg-glow" />
          <div className="mob-hero-content">
            <div className="mob-hero-top-row">
              <div className="mob-hero-tag">
                <ShieldCheck size={12} className="text-emerald-400" />
                <span>IDENTIDAD DIGITAL SEGURA</span>
              </div>
              <span className="mob-plan-chip">{planLabel}</span>
            </div>

            <div className="mob-hero-main">
              <h3 className="mob-hero-title">Gestor de Perfiles</h3>
              <p className="mob-hero-desc">
                Crea instancias independientes con cookies y huellas aisladas.
              </p>
            </div>

            <div className="mob-hero-actions">
              <button 
                type="button" 
                onClick={() => onNavigate?.('profiles')}
                className="mob-btn-create-profile"
              >
                <Plus size={18} strokeWidth={2.5} />
                <span>Nuevo Perfil Stealth</span>
              </button>
            </div>
          </div>
        </div>

        {/* ========================================================
            2X2 STAT BENTO GRID (TOUCH CARDS)
            ======================================================== */}
        <div className="mob-stats-grid">
          {/* Card 1: Perfiles */}
          <div 
            className="mob-stat-card" 
            onClick={() => onNavigate?.('profiles')}
            role="button"
            tabIndex={0}
          >
            <div className="mob-stat-head">
              <div className="mob-stat-icon-wrap text-cyan-400">
                <Layers size={16} />
              </div>
              <ChevronRight size={14} className="text-zinc-600" />
            </div>
            <div className="mob-stat-body">
              <span className="mob-stat-value">
                {loading ? '...' : formatCount(data?.profilesCount)}
              </span>
              <span className="mob-stat-label">Perfiles Creados</span>
            </div>
            <div className="mob-stat-sub">En tu cuenta</div>
          </div>

          {/* Card 2: Sesiones */}
          <div 
            className="mob-stat-card"
            onClick={() => onNavigate?.('sessions')}
            role="button"
            tabIndex={0}
          >
            <div className="mob-stat-head">
              <div className="mob-stat-icon-wrap text-emerald-400">
                <Radio size={16} />
              </div>
              <span className="mob-stat-pulse">
                <span className="mob-pulse-dot" />
              </span>
            </div>
            <div className="mob-stat-body">
              <span className="mob-stat-value">
                {loading ? '...' : formatCount(data?.activeSessionsCount)}
              </span>
              <span className="mob-stat-label">En Ejecución</span>
            </div>
            <div className="mob-stat-sub text-emerald-400">Ahora mismo</div>
          </div>

          {/* Card 3: Telemetría / Horas */}
          <div className="mob-stat-card">
            <div className="mob-stat-head">
              <div className="mob-stat-icon-wrap text-amber-400">
                <Clock size={16} />
              </div>
            </div>
            <div className="mob-stat-body">
              <span className="mob-stat-value">
                {loading ? '...' : formatMinutes(data?.totalMinutes)}
              </span>
              <span className="mob-stat-label">Horas Activas</span>
            </div>
            <div className="mob-stat-sub">Tiempo registrado</div>
          </div>

          {/* Card 4: Plan & Cuota */}
          <div 
            className="mob-stat-card"
            onClick={() => onNavigate?.('planes')}
            role="button"
            tabIndex={0}
          >
            <div className="mob-stat-head">
              <div className="mob-stat-icon-wrap text-purple-400">
                <CreditCard size={16} />
              </div>
              <ChevronRight size={14} className="text-zinc-600" />
            </div>
            <div className="mob-stat-body">
              <span className="mob-stat-value text-[13px] leading-tight">
                {effectivePlanCodename(user)}
              </span>
              <span className="mob-stat-label">Licencia Flota</span>
            </div>
            <div className="mob-stat-sub text-cyan-400">Gestionar plan</div>
          </div>
        </div>

        {/* ========================================================
            RECENT SESSIONS / QUICK LAUNCHER LIST
            ======================================================== */}
        <div className="mob-section">
          <div className="mob-section-header">
            <div className="mob-section-title-wrap">
              <h3 className="mob-section-title">Sesiones Recientes</h3>
              <span className="mob-section-badge">{sessions.length}</span>
            </div>
            <button 
              type="button" 
              onClick={() => onNavigate?.('sessions')}
              className="mob-section-link"
            >
              <span>Ver todas</span>
              <ArrowRight size={13} />
            </button>
          </div>

          <div className="mob-sessions-list">
            {sessions.map(session => {
              const isActive = session.status === 'active';
              return (
                <div 
                  key={session.id} 
                  className={`mob-session-item ${isActive ? 'is-active' : ''}`}
                  onClick={() => onNavigate?.('sessions')}
                >
                  <div className="mob-session-left">
                    <div className={`mob-session-avatar ${isActive ? 'active' : ''}`}>
                      <Fingerprint size={18} />
                    </div>
                    <div className="mob-session-details">
                      <div className="mob-session-name-row">
                        <span className="mob-session-name">{session.name}</span>
                        {isActive && <span className="mob-status-tag">EN VIVO</span>}
                      </div>
                      <div className="mob-session-meta">
                        <span>{session.browser}</span>
                        <span className="mob-meta-sep">•</span>
                        <span>{session.os}</span>
                        <span className="mob-meta-sep">•</span>
                        <span className="text-zinc-400">{session.proxy}</span>
                      </div>
                    </div>
                  </div>

                  <div className="mob-session-action">
                    <button
                      type="button"
                      className="mob-btn-toggle-session btn-start"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate?.('sessions');
                      }}
                      title="Gestionar esta sesion en la pantalla de Sesiones"
                    >
                      <ArrowRight size={13} />
                      <span>Gestionar</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ========================================================
            QUICK ACCESS BENTO HUB (TOUCH NAVIGATION)
            ======================================================== */}
        <div className="mob-section">
          <div className="mob-section-header">
            <h3 className="mob-section-title">Accesos Directos</h3>
          </div>

          <div className="mob-quick-hub-grid">
            <button 
              type="button" 
              className="mob-quick-tile" 
              onClick={() => onNavigate?.('profiles')}
            >
              <div className="mob-quick-icon bg-cyan-500/10 text-cyan-400">
                <Layers size={18} />
              </div>
              <span className="mob-quick-lbl">Perfiles</span>
            </button>

            <button 
              type="button" 
              className="mob-quick-tile" 
              onClick={() => onNavigate?.('sessions')}
            >
              <div className="mob-quick-icon bg-emerald-500/10 text-emerald-400">
                <Radio size={18} />
              </div>
              <span className="mob-quick-lbl">Sesiones</span>
            </button>

            <button 
              type="button" 
              className="mob-quick-tile" 
              onClick={() => onNavigate?.('planes')}
            >
              <div className="mob-quick-icon bg-amber-500/10 text-amber-400">
                <CreditCard size={18} />
              </div>
              <span className="mob-quick-lbl">Planes</span>
            </button>

            <button 
              type="button" 
              className="mob-quick-tile" 
              onClick={() => onNavigate?.('settings')}
            >
              <div className="mob-quick-icon bg-zinc-500/10 text-zinc-300">
                <Settings size={18} />
              </div>
              <span className="mob-quick-lbl">Ajustes</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

export default DashboardMobile;

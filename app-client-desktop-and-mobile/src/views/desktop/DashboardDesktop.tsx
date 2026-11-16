import { useState, useEffect } from 'react';
import { invoke, DashboardData, User } from '../../hooks/useAuth';
import {
  effectivePlanFleetLabel,
  effectivePlanLimits,
  effectivePlanName,
  formatLimit,
} from '../../domain/plans';
import { DASH, formatMinutes } from '../../utils/format';
import { APP_VERSION } from '../../config/version';
import { getBranding } from '../../config/branding';
import { 
  Users, 
  Clock, 
  Settings, 
  UserCheck, 
  ShieldCheck,
  Layers,
  Radio,
  ArrowRight,
  Shield,
  CreditCard,
  Key,
  Plus,
  CheckCircle2
} from 'lucide-react';
import '../../components/Dashboard/Dashboard.css';

interface Props {
  user: User;
  onNavigate?: (view: any) => void;
}

export function DashboardDesktop({ user, onNavigate }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [userCount, setUserCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
    const interval = setInterval(() => {
      loadDashboard();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadDashboard = async () => {
    try {
      const dash = await invoke<DashboardData>('server_get_dashboard');
      setData(dash);

      if (user.isAdmin) {
        try {
          const users = await invoke<any[]>('server_users_list');
          setUserCount(users.length);
        } catch {}
      }
    } catch (err) {
      console.error('Error loading dashboard:', err);
    } finally {
      setLoading(false);
    }
  };

  const planName = effectivePlanName(user);
  const planLabel = effectivePlanFleetLabel(user);
  const limits = effectivePlanLimits(user);

  const statCards = user.isAdmin 
    ? [
        { icon: UserCheck, value: userCount, label: 'Operadores Totales', sub: 'Cuentas registradas' },
        { icon: Layers, value: data?.profilesCount ?? 0, label: 'Perfiles Registrados', sub: 'En todas las cuentas' },
        { icon: Radio, value: data?.activeSessionsCount ?? DASH, label: 'Sesiones Activas', sub: 'Ahora mismo', live: true },
        { icon: Key, value: data?.apiKeysCount ?? 0, label: 'API Keys Activas', sub: 'Claves de integración' },
      ]
    : [
        { icon: Layers, value: data?.profilesCount ?? 0, label: 'Perfiles', sub: `Límite del plan: ${formatLimit(limits.maxProfiles)}` },
        { icon: Radio, value: data?.activeSessionsCount ?? DASH, label: 'Sesiones Activas', sub: `Límite del plan: ${formatLimit(limits.maxSessions)}`, live: true },
        { icon: ShieldCheck, value: planName, label: 'Plan Activo', sub: 'Nivel de suscripción actual' },
        { icon: Clock, value: formatMinutes(data?.totalMinutes), label: 'Tiempo Registrado', sub: 'Sesiones cerradas' },
      ];

  const latestSessions = data?.latestSessions || [];

  return (
    <div className="fleet-dashboard fleet-scroll">
      <div className="fleet-dash-header">
        <div className="fleet-dash-title-wrap">
          <div className="fleet-dash-badge-row">
            <span className="fleet-dash-badge">{getBranding().shortName.toUpperCase()}</span>
            <span className="fleet-dash-dot-divider">/</span>
            <span className="fleet-dash-engine-tag">v{APP_VERSION}</span>
          </div>
          <h1 className="fleet-dash-title">
            {user.isAdmin ? 'Panel de Control' : 'Panel Principal'}
          </h1>
          <div className="fleet-dash-sub-row">
            <span className="fleet-dash-sub-item">Usuario: <strong className="text-white">{user.name}</strong></span>
            <span className="fleet-dash-sub-sep">·</span>
            <span className="fleet-dash-sub-item">
              Plan: <span className="fleet-dash-plan-chip">{planLabel}</span>
            </span>
            <span className="fleet-dash-sub-sep">·</span>
            <span className="fleet-dash-status-online">
              <span className="fleet-dash-status-dot" />
              EN LÍNEA
            </span>
          </div>
        </div>

        <div className="fleet-dash-actions">
          <button 
            type="button"
            onClick={() => onNavigate?.('profiles')}
            className="btn-dash-primary"
          >
            <Plus size={15} strokeWidth={2.5} />
            <span>Crear Perfil</span>
          </button>

          <button 
            type="button"
            onClick={() => onNavigate?.('profiles')}
            className="btn-dash-secondary"
          >
            <Layers size={14} />
            <span>Gestionar Perfiles</span>
          </button>
        </div>
      </div>

      <div className="fleet-dash-metrics-grid">
        {statCards.map((stat, idx) => {
          const Icon = stat.icon;
          return (
            <div key={idx} className="fleet-dash-card">
              <div className="fleet-dash-card-head">
                <span className="fleet-dash-card-label">{stat.label}</span>
                {stat.live ? (
                  <span className="fleet-live-pulse-indicator" title="Procesos en ejecución">
                    <span className="fleet-live-pulse-dot" />
                  </span>
                ) : (
                  <Icon size={16} className="text-neutral-500" />
                )}
              </div>

              <div className="fleet-dash-card-body">
                <div className="fleet-dash-card-value">
                  {loading ? '...' : stat.value}
                </div>
                <div className="fleet-dash-card-sub">
                  {stat.sub}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="fleet-dash-columns-grid">
        <div className="fleet-dash-col-left">
          <div className="fleet-dash-panel">
            <div className="fleet-dash-panel-header">
              <div>
                <h3 className="fleet-dash-panel-title">
                  {user.isAdmin ? 'Monitor de Sesiones del Cluster' : 'Sesiones de Navegación Recientes'}
                </h3>
                <p className="fleet-dash-panel-subtitle">Instancias activas con persistencia y huella protegida</p>
              </div>
              <button 
                type="button"
                onClick={() => onNavigate?.('sessions')}
                className="fleet-dash-link-btn"
              >
                <span>Ver monitor completo</span>
                <ArrowRight size={13} />
              </button>
            </div>

            {latestSessions.length > 0 ? (
              <div className="fleet-sessions-table-wrap">
                <table className="fleet-sessions-table">
                  <thead>
                    <tr>
                      <th>Perfil Stealth</th>
                      <th>Estado</th>
                      <th className="text-right">Inicio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestSessions.slice(0, 6).map((session: any) => {
                      const isActive = session.status === 'active';
                      return (
                        <tr key={session._id || session.id}>
                          <td className="font-bold text-white">
                            {session.profileId?.name || session.profile_name || 'Perfil sin nombre'}
                          </td>
                          <td>
                            {isActive ? (
                              <span className="fleet-badge-active">
                                <span className="fleet-badge-dot" />
                                Activa
                              </span>
                            ) : (
                              <span className="fleet-badge-stopped">
                                Detenida
                              </span>
                            )}
                          </td>
                          <td className="text-right text-neutral-400 text-xs font-mono">
                            {new Date(session.createdAt || Date.now()).toLocaleDateString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="fleet-dash-empty-state">
                <div className="fleet-dash-empty-icon-wrap">
                  <Shield size={24} className="text-white" />
                </div>
                <h4 className="fleet-dash-empty-title">Sin sesiones activas</h4>
                <p className="fleet-dash-empty-desc">
                  Inicia un perfil para navegar de forma aislada y segura.
                </p>
                <button 
                  type="button" 
                  onClick={() => onNavigate?.('profiles')} 
                  className="btn-dash-primary mt-4"
                >
                  <Plus size={14} strokeWidth={2.5} />
                  <span>Crear o Iniciar Perfil</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="fleet-dash-col-right">
          <div className="fleet-dash-panel">
            <div className="fleet-dash-panel-header">
              <h3 className="fleet-dash-panel-title">Accesos Rápidos</h3>
              <span className="text-[10px] font-mono text-neutral-400">ACCESOS</span>
            </div>

            <div className="fleet-quick-grid">
              <button
                type="button"
                onClick={() => onNavigate?.('profiles')}
                className="fleet-quick-tile"
              >
                <div className="fleet-quick-icon-wrap">
                  <Layers size={18} />
                </div>
                <div className="fleet-quick-text">
                  <span className="fleet-quick-title">Perfiles Stealth</span>
                  <span className="fleet-quick-sub">{data?.profilesCount || 0} configurados</span>
                </div>
                <ArrowRight size={14} className="fleet-quick-arrow" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate?.('sessions')}
                className="fleet-quick-tile"
              >
                <div className="fleet-quick-icon-wrap">
                  <Radio size={18} />
                </div>
                <div className="fleet-quick-text">
                  <span className="fleet-quick-title">Sesiones en Marcha</span>
                  <span className="fleet-quick-sub">{data?.sessionsCount || 0} instancias</span>
                </div>
                <ArrowRight size={14} className="fleet-quick-arrow" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate?.('planes')}
                className="fleet-quick-tile"
              >
                <div className="fleet-quick-icon-wrap">
                  <CreditCard size={18} />
                </div>
                <div className="fleet-quick-text">
                  <span className="fleet-quick-title">Planes & Cuotas</span>
                  <span className="fleet-quick-sub">{planLabel}</span>
                </div>
                <ArrowRight size={14} className="fleet-quick-arrow" />
              </button>

              {user.isAdmin && (
                <button
                  type="button"
                  onClick={() => onNavigate?.('users')}
                  className="fleet-quick-tile"
                >
                  <div className="fleet-quick-icon-wrap">
                    <UserCheck size={18} />
                  </div>
                  <div className="fleet-quick-text">
                    <span className="fleet-quick-title">Consola de Usuarios</span>
                    <span className="fleet-quick-sub">{userCount} cuentas</span>
                  </div>
                  <ArrowRight size={14} className="fleet-quick-arrow" />
                </button>
              )}

              <button
                type="button"
                onClick={() => onNavigate?.('settings')}
                className="fleet-quick-tile"
              >
                <div className="fleet-quick-icon-wrap">
                  <Settings size={18} />
                </div>
                <div className="fleet-quick-text">
                  <span className="fleet-quick-title">Configuración</span>
                  <span className="fleet-quick-sub">Ajustes & Guard</span>
                </div>
                <ArrowRight size={14} className="fleet-quick-arrow" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardDesktop;

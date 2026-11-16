import { useState, useEffect } from 'react';
import { invoke, UserData } from '../../hooks/useAuth';
import { PLANS, planName, formatLimit } from '../../domain/plans';
import { 
  UserCheck, 
  Shield, 
  Ban, 
  Key, 
  Crown,
  Search,
  Plus,
  Copy,
  Check,
  Trash2,
  Lock,
  Briefcase,
  Layers,
  Sparkles,
  Loader2,
  X,
  RefreshCw,
  Clock,
  User as UserIcon,
  Tag,
  TrendingUp,
  DollarSign,
  Activity,
  HardDrive,
  Download,
  AlertTriangle,
  Smartphone,
  Globe
} from 'lucide-react';
import './UsersView.css';

interface LicenseKeyData {
  _id: string;
  id?: string;
  key: string;
  plan: string;
  /** Nombre del plan personalizado; si falta, se usa el del plan base. */
  customPlanName?: string | null;
  maxProfiles?: number | null;
  maxSessions?: number | null;
  maxApiKeys?: number | null;
  durationDays: number;
  role: 'user' | 'seller' | 'admin';
  status: 'active' | 'redeemed' | 'revoked' | 'expired';
  tag?: string;
  createdBy?: { name: string; username?: string; email: string };
  redeemedBy?: { name: string; username?: string; email: string };
  redeemedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

interface AnalyticsData {
  totalUsers: number;
  usersByPlan: { ghost: number; shadow: number; specter: number; phantom: number };
  mrr: number;
  totalProfiles: number;
  activeSessions: number;
  keys: { total: number; active: number; redeemed: number; revoked: number };
}

interface ActivityItem {
  id?: string;
  _id?: string;
  action: string;
  entity: string;
  details?: any;
  ip?: string;
  createdAt: string;
}

export function UsersView() {
  const [activeTab, setActiveTab] = useState<'analytics' | 'keys' | 'users' | 'activity' | 'database'>('keys');
  
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const [users, setUsers] = useState<UserData[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserData | null>(null);
  const [userModalAction, setUserModalAction] = useState<'plan' | 'role' | 'password' | 'ban' | 'delete' | 'hwid' | null>(null);
  const [modalRole, setModalRole] = useState<'user' | 'seller' | 'admin' | 'owner'>('user');
  const [modalCredits, setModalCredits] = useState(10);
  const [modalPlan, setModalPlan] = useState('ghost');
  const [modalPassword, setModalPassword] = useState('');
  const [userActionSaving, setUserActionSaving] = useState(false);

  const [keys, setKeys] = useState<LicenseKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keySearch, setKeySearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'redeemed' | 'revoked'>('all');
  const [createKeyModal, setCreateKeyModal] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  
  const [keyPlan, setKeyPlan] = useState<'shadow' | 'specter' | 'phantom'>('shadow');
  const [keyDuration, setKeyDuration] = useState<number>(30);
  const [keyRole, setKeyRole] = useState<'user' | 'seller' | 'admin'>('user');
  const [keyCount, setKeyCount] = useState<number>(1);
  const [keyTag, setKeyTag] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyError, setKeyError] = useState('');

  // Activity State
  const [activityLogs, setActivityLogs] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Maintenance State
  const [purging, setPurging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [maintenanceMsg, setMaintenanceMsg] = useState('');

  useEffect(() => {
    loadKeys();
    loadUsers();
  }, []);

  useEffect(() => {
    if (activeTab === 'analytics') loadAnalytics();
    if (activeTab === 'activity') loadActivity();
  }, [activeTab]);

  const loadAnalytics = async () => {
    setAnalyticsLoading(true);
    try {
      const data = await invoke<AnalyticsData>('server_get_analytics');
      setAnalytics(data);
    } catch (err) {
      console.warn('Error loading analytics:', err);
    } finally {
      setAnalyticsLoading(false);
    }
  };

  const loadActivity = async () => {
    setActivityLoading(true);
    try {
      const data = await invoke<ActivityItem[]>('server_get_activity');
      setActivityLogs(data || []);
    } catch (err) {
      console.warn('Error loading activity logs:', err);
    } finally {
      setActivityLoading(false);
    }
  };

  const loadKeys = async () => {
    setKeysLoading(true);
    try {
      const data = await invoke<LicenseKeyData[]>('server_keys_list');
      setKeys(data || []);
    } catch (err) {
      console.error('Error loading keys:', err);
    } finally {
      setKeysLoading(false);
    }
  };

  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const data = await invoke<UserData[]>('server_users_list');
      setUsers(data || []);
    } catch (err) {
      console.error('Error loading users:', err);
    } finally {
      setUsersLoading(false);
    }
  };

  const handleCopyKey = (keyString: string) => {
    navigator.clipboard.writeText(keyString);
    setCopiedKey(keyString);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleCreateKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setKeyError('');

    try {
      await invoke('server_mint_keys', {
        plan: keyPlan,
        durationDays: Number(keyDuration),
        count: Number(keyCount),
        role: keyRole,
        tag: keyTag.trim() || undefined,
      });
      setCreateKeyModal(false);
      setKeyTag('');
      await loadKeys();
    } catch (err: any) {
      setKeyError(err?.message || 'Error al generar clave(s)');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    if (!confirm('¿Deseas eliminar definitivamente esta clave de licencia de la base de datos?')) return;
    try {
      await invoke('server_delete_key', { keyId });
      await loadKeys();
    } catch (err: any) {
      alert(err?.message || 'Error al eliminar clave');
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm('¿Deseas desactivar esta clave de licencia?')) return;
    try {
      await invoke('server_revoke_key', { keyId });
      await loadKeys();
    } catch (err: any) {
      alert(err?.message || 'Error al revocar clave');
    }
  };

  const handleSaveUserAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    setUserActionSaving(true);

    try {
      if (userModalAction === 'plan') {
        await invoke('server_change_plan', { userId: selectedUser.id, plan: modalPlan });
      } else if (userModalAction === 'role') {
        await invoke('server_assign_role', { 
          userId: selectedUser.id, 
          role: modalRole, 
          sellerCredits: modalRole === 'seller' ? Number(modalCredits) : undefined 
        });
      } else if (userModalAction === 'password') {
        if (!modalPassword || modalPassword.length < 6) {
          throw new Error('La contraseña debe tener al menos 6 caracteres');
        }
        await invoke('server_reset_password', { userId: selectedUser.id, password: modalPassword });
      } else if (userModalAction === 'ban') {
        await invoke('server_ban_user', { userId: selectedUser.id, banned: !selectedUser.banned });
      } else if (userModalAction === 'delete') {
        await invoke('server_delete_user', { userId: selectedUser.id });
      } else if (userModalAction === 'hwid') {
        await invoke('server_reset_hwid', { userId: selectedUser.id });
        alert('Dispositivo HWID desvinculado con éxito. El usuario podrá iniciar sesión en un nuevo equipo.');
      }
      
      setUserModalAction(null);
      setSelectedUser(null);
      await loadUsers();
    } catch (err: any) {
      alert(err?.message || 'Error al actualizar usuario');
    } finally {
      setUserActionSaving(false);
    }
  };

  const handleExportBackup = async () => {
    setExporting(true);
    setMaintenanceMsg('');
    try {
      const data = await invoke<any>('server_export_backup');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `krakenges_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMaintenanceMsg('✅ Exportación parcial descargada. Para restaurar el servidor usa el backup cifrado del VPS.');
    } catch (e: any) {
      setMaintenanceMsg('❌ Error al exportar backup: ' + (e?.message || 'Fallo de red'));
    } finally {
      setExporting(false);
    }
  };

  const handlePurgeSessions = async () => {
    if (!confirm('¿Deseas purgar todas las sesiones inactivas con más de 30 días de antigüedad?')) return;
    setPurging(true);
    setMaintenanceMsg('');
    try {
      const res = await invoke<any>('server_purge_sessions');
      setMaintenanceMsg(`✅ Base de datos optimizada: ${res?.deletedCount || 0} sesiones antiguas purgadas.`);
    } catch (e: any) {
      setMaintenanceMsg('❌ Error al purgar sesiones: ' + (e?.message || 'Fallo'));
    } finally {
      setPurging(false);
    }
  };

  const filteredKeys = keys.filter(k => {
    const matchesSearch = k.key.toLowerCase().includes(keySearch.toLowerCase()) ||
      (k.tag && k.tag.toLowerCase().includes(keySearch.toLowerCase())) ||
      (k.redeemedBy?.name && k.redeemedBy.name.toLowerCase().includes(keySearch.toLowerCase()));
    
    if (statusFilter === 'all') return matchesSearch;
    return matchesSearch && k.status === statusFilter;
  });

  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.username.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div className="admin-panel-view">
      <div className="view-header">
        <div>
          <h1 className="view-title">Centro de Control Super Owner</h1>
          <p className="view-subtitle">
            Monitorea ingresos SaaS, genera claves de activación, audita accesos y gestiona usuarios.
          </p>
        </div>

        <div className="admin-tab-switcher">
          <button 
            className={`admin-tab-btn ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <TrendingUp size={14} />
            <span>Métricas & MRR</span>
          </button>

          <button 
            className={`admin-tab-btn ${activeTab === 'keys' ? 'active' : ''}`}
            onClick={() => setActiveTab('keys')}
          >
            <Key size={14} />
            <span>Licencias ({keys.length})</span>
          </button>

          <button 
            className={`admin-tab-btn ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            <UserCheck size={14} />
            <span>Usuarios ({users.length})</span>
          </button>

          <button 
            className={`admin-tab-btn ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >
            <Activity size={14} />
            <span>Auditoría Live</span>
          </button>

          <button 
            className={`admin-tab-btn ${activeTab === 'database' ? 'active' : ''}`}
            onClick={() => setActiveTab('database')}
          >
            <HardDrive size={14} />
            <span>Base de Datos</span>
          </button>
        </div>
      </div>

      {activeTab === 'analytics' && (
        <div className="admin-analytics-container">
          {analyticsLoading ? (
            <div className="flex items-center justify-center py-20 text-white font-semibold">
              <Loader2 size={24} className="spin mr-3" />
              <span>Calculando telemetría del sistema...</span>
            </div>
          ) : (
            <>
              <div className="analytics-kpi-grid">
                <div className="analytics-kpi-card highlight">
                  <div className="kpi-icon-wrap">
                    <DollarSign size={20} />
                  </div>
                  <div className="kpi-body">
                    <span className="kpi-label">MRR Estimado (Mensual)</span>
                    <span className="kpi-value font-mono">${analytics?.mrr || 0} USD</span>
                    <span className="kpi-subtext">Ingresos por licencias activas</span>
                  </div>
                </div>

                <div className="analytics-kpi-card">
                  <div className="kpi-icon-wrap blue">
                    <UserCheck size={20} />
                  </div>
                  <div className="kpi-body">
                    <span className="kpi-label">Usuarios Totales</span>
                    <span className="kpi-value font-mono">{analytics?.totalUsers || users.length}</span>
                    <span className="kpi-subtext">Registrados en la red</span>
                  </div>
                </div>

                <div className="analytics-kpi-card">
                  <div className="kpi-icon-wrap emerald">
                    <Layers size={20} />
                  </div>
                  <div className="kpi-body">
                    <span className="kpi-label">Perfiles en Red</span>
                    <span className="kpi-value emerald font-mono">{analytics?.totalProfiles || 0}</span>
                    <span className="kpi-subtext">{analytics?.activeSessions || 0} navegando ahora</span>
                  </div>
                </div>

                <div className="analytics-kpi-card">
                  <div className="kpi-icon-wrap amber">
                    <Key size={20} />
                  </div>
                  <div className="kpi-body">
                    <span className="kpi-label">Claves de Activación</span>
                    <span className="kpi-value amber font-mono">{analytics?.keys?.total || keys.length}</span>
                    <span className="kpi-subtext">{analytics?.keys?.redeemed || 0} canjeadas</span>
                  </div>
                </div>
              </div>

              <div className="analytics-breakdown-card">
                <h3 className="breakdown-title">Distribución de Suscripciones por Plan</h3>
                <div className="plan-breakdown-grid">
                  <div className="breakdown-item ghost">
                    <div className="breakdown-header">
                      <span className="plan-name">{PLANS.ghost.name} (Gratis)</span>
                      <span className="plan-count">{analytics?.usersByPlan?.ghost || 0}</span>
                    </div>
                    <div className="plan-bar"><div className="plan-fill ghost" style={{ width: `${Math.min(100, ((analytics?.usersByPlan?.ghost || 0) / (analytics?.totalUsers || 1)) * 100)}%` }} /></div>
                  </div>

                  <div className="breakdown-item shadow">
                    <div className="breakdown-header">
                      <span className="plan-name">{PLANS.shadow.name} (${PLANS.shadow.price}/mes)</span>
                      <span className="plan-count">{analytics?.usersByPlan?.shadow || 0}</span>
                    </div>
                    <div className="plan-bar"><div className="plan-fill shadow" style={{ width: `${Math.min(100, ((analytics?.usersByPlan?.shadow || 0) / (analytics?.totalUsers || 1)) * 100)}%` }} /></div>
                  </div>

                  <div className="breakdown-item specter">
                    <div className="breakdown-header">
                      <span className="plan-name">{PLANS.specter.name} (${PLANS.specter.price}/mes)</span>
                      <span className="plan-count">{analytics?.usersByPlan?.specter || 0}</span>
                    </div>
                    <div className="plan-bar"><div className="plan-fill specter" style={{ width: `${Math.min(100, ((analytics?.usersByPlan?.specter || 0) / (analytics?.totalUsers || 1)) * 100)}%` }} /></div>
                  </div>

                  <div className="breakdown-item phantom">
                    <div className="breakdown-header">
                      <span className="plan-name">{PLANS.phantom.name} (${PLANS.phantom.price}/mes)</span>
                      <span className="plan-count">{analytics?.usersByPlan?.phantom || 0}</span>
                    </div>
                    <div className="plan-bar"><div className="plan-fill phantom" style={{ width: `${Math.min(100, ((analytics?.usersByPlan?.phantom || 0) / (analytics?.totalUsers || 1)) * 100)}%` }} /></div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'keys' && (
        <div className="tab-keys-container">
          <div className="keys-controls-bar">
            <div className="keys-search-box">
              <Search size={14} className="text-neutral-500" />
              <input
                type="text"
                placeholder="Buscar clave, etiqueta o cliente..."
                value={keySearch}
                onChange={(e) => setKeySearch(e.target.value)}
                className="keys-search-input font-mono text-xs"
              />
            </div>

            <div className="keys-actions-group">
              <div className="keys-filter-group">
                <button 
                  className={`keys-filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  Todas ({keys.length})
                </button>
                <button 
                  className={`keys-filter-pill ${statusFilter === 'active' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('active')}
                >
                  Disponibles ({keys.filter(k => k.status === 'active').length})
                </button>
                <button 
                  className={`keys-filter-pill ${statusFilter === 'redeemed' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('redeemed')}
                >
                  Canjeadas ({keys.filter(k => k.status === 'redeemed').length})
                </button>
              </div>

              <button 
                className="admin-btn-primary"
                onClick={() => {
                  setKeyError('');
                  setCreateKeyModal(true);
                }}
              >
                <Plus size={15} />
                <span>Generar Claves</span>
              </button>
            </div>
          </div>

          {keysLoading ? (
            <div className="flex items-center justify-center py-20 text-white font-semibold">
              <Loader2 size={24} className="spin mr-3" />
              <span>Cargando inventario de claves...</span>
            </div>
          ) : filteredKeys.length === 0 ? (
            <div className="text-center py-20 bg-[#050505] border border-white/10 rounded-2xl p-8">
              <Key size={32} className="text-white mx-auto mb-3 opacity-60" />
              <h3 className="text-sm font-bold text-white mb-1">No hay claves en esta vista</h3>
              <p className="text-xs text-neutral-400 mb-5">Genera tu primer lote de licencias para clientes o revendedores.</p>
              <button className="admin-btn-primary mx-auto" onClick={() => setCreateKeyModal(true)}>
                <Plus size={14} /> Generar Claves
              </button>
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Clave de Licencia</th>
                    <th>Plan Asignado</th>
                    <th>Duración</th>
                    <th>Rol</th>
                    <th>Estado</th>
                    <th>Canjeada Por</th>
                    <th>Etiqueta</th>
                    <th style={{ textAlign: 'right' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredKeys.map((k) => {
                    const id = k._id || k.id || '';
                    const isRedeemed = k.status === 'redeemed';
                    const isRevoked = k.status === 'revoked';

                    return (
                      <tr key={id} className={isRevoked ? 'opacity-40' : ''}>
                        <td>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-white text-xs tracking-wider">
                              {k.key}
                            </span>
                            <button 
                              className={`copy-key-btn ${copiedKey === k.key ? 'copied' : ''}`}
                              onClick={() => handleCopyKey(k.key)}
                              title="Copiar Clave"
                            >
                              {copiedKey === k.key ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          </div>
                        </td>
                        <td>
                          <span className={`plan-pill ${(k.plan || '').toLowerCase()}`}>
                            {k.customPlanName || (k.plan ? planName(k.plan) : '—')}
                          </span>
                        </td>
                        <td className="font-mono text-xs text-slate-300">
                          {k.durationDays === -1 ? 'Permanente' : `${k.durationDays} días`}
                        </td>
                        <td>
                          <span className={`role-pill ${k.role}`}>
                            {k.role === 'admin' ? 'Admin' : k.role === 'seller' ? 'Seller' : 'Usuario'}
                          </span>
                        </td>
                        <td>
                          <span className={`status-pill ${k.status}`}>
                            <span className="status-dot" />
                            <span>{isRedeemed ? 'Canjeada' : isRevoked ? 'Revocada' : 'Disponible'}</span>
                          </span>
                        </td>
                        <td>
                          {k.redeemedBy ? (
                            <div className="text-xs text-slate-200">
                              <span className="font-bold">{k.redeemedBy.name}</span>
                              {k.redeemedBy.username && <span className="text-slate-400 ml-1">(@{k.redeemedBy.username})</span>}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-500 font-mono">—</span>
                          )}
                        </td>
                        <td>
                          {k.tag ? (
                            <span className="text-[11px] font-mono text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded">
                              {k.tag}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500 font-mono">—</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="table-action-icon-btn danger"
                            onClick={() => handleDeleteKey(id)}
                            title="Eliminar Clave de la Base de Datos"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'users' && (
        <div className="tab-users-container">
          <div className="keys-controls-bar">
            <div className="keys-search-box">
              <Search size={14} className="text-slate-500" />
              <input
                type="text"
                placeholder="Buscar por nombre, usuario o email..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="keys-search-input font-mono text-xs"
              />
            </div>
          </div>

          {usersLoading ? (
            <div className="flex items-center justify-center py-20 text-white font-semibold">
              <Loader2 size={24} className="spin mr-3" />
              <span>Cargando usuarios...</span>
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th>Email</th>
                    <th>Rol en Sistema</th>
                    <th>Plan Activo</th>
                    <th>Perfiles</th>
                    <th>Estado</th>
                    <th style={{ textAlign: 'right' }}>Acciones Avanzadas</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => {
                    const isOwner = (u as any).role === 'owner';
                    const isSeller = (u as any).role === 'seller';
                    const isAdmin = u.isAdmin || (u as any).role === 'admin' || isOwner;

                    return (
                      <tr key={u.id} className={u.banned ? 'opacity-40' : ''}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-lg bg-white/10 border border-white/20 flex items-center justify-center font-bold text-white text-xs">
                              {u.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-bold text-white text-xs">{u.name}</div>
                              <div className="font-mono text-[10px] text-slate-400">@{u.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="text-xs text-slate-300 font-mono">{u.email || '—'}</td>
                        <td>
                          {isOwner ? (
                            <span className="role-pill owner">
                              <Crown size={11} className="inline mr-1" /> Super Owner
                            </span>
                          ) : isAdmin ? (
                            <span className="role-pill admin">
                              <Shield size={11} className="inline mr-1" /> Administrador
                            </span>
                          ) : isSeller ? (
                            <span className="role-pill seller">
                              <Briefcase size={11} className="inline mr-1" /> Seller ({(u as any).sellerCredits ?? 0} CR)
                            </span>
                          ) : (
                            <span className="role-pill user">Usuario</span>
                          )}
                        </td>
                        <td>
                          <span className={`plan-pill ${(u.plan || '').toLowerCase()}`}>
                            {u.planName || (u.plan ? planName(u.plan) : '—')}
                          </span>
                        </td>
                        <td className="font-mono text-xs text-slate-300">
                          {u.stats?.profiles?.current ?? 0} / {u.stats?.profiles?.max === -1 ? '∞' : u.stats?.profiles?.max ?? 5}
                        </td>
                        <td>
                          <span className={`status-pill ${u.banned ? 'banned' : 'active'}`}>
                            <span className="status-dot" />
                            <span>{u.banned ? 'Baneado' : 'Activo'}</span>
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              className="table-action-btn"
                              onClick={() => {
                                setSelectedUser(u);
                                setModalPlan(u.plan || 'ghost');
                                setUserModalAction('plan');
                              }}
                              title="Cambiar Plan"
                            >
                              Plan
                            </button>

                            <button
                              className="table-action-btn"
                              onClick={() => {
                                setSelectedUser(u);
                                setModalRole((u as any).role || 'user');
                                setModalCredits((u as any).sellerCredits || 10);
                                setUserModalAction('role');
                              }}
                              title="Asignar Rol & Créditos"
                            >
                              Rol
                            </button>

                            <button
                              className="table-action-btn"
                              onClick={() => {
                                setSelectedUser(u);
                                setModalPassword('');
                                setUserModalAction('password');
                              }}
                              title="Resetear Contraseña"
                            >
                              Pass
                            </button>

                            <button
                              className="table-action-btn"
                              onClick={() => {
                                setSelectedUser(u);
                                setUserModalAction('hwid');
                              }}
                              title="Desvincular Dispositivo (Reset HWID)"
                            >
                              <Smartphone size={11} className="inline mr-0.5" /> HWID
                            </button>

                            <button
                              className={`table-action-btn ${u.banned ? 'success' : 'danger'}`}
                              onClick={() => {
                                setSelectedUser(u);
                                setUserModalAction('ban');
                              }}
                              title={u.banned ? 'Desbanear' : 'Banear'}
                            >
                              {u.banned ? 'Desbanear' : 'Banear'}
                            </button>

                            <button
                              className="table-action-btn danger"
                              onClick={() => {
                                setSelectedUser(u);
                                setUserModalAction('delete');
                              }}
                              title="Eliminar Usuario Permanentemente"
                            >
                              <Trash2 size={11} className="inline mr-0.5" /> Eliminar
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
      )}

      {activeTab === 'activity' && (
        <div className="tab-activity-container">
          <div className="audit-feed-header" style={{ marginBottom: 16 }}>
            <div>
              <h2 className="audit-feed-title">Live Security & Activity Feed</h2>
              <p className="audit-feed-subtitle">Auditoría en tiempo real de inicios de sesión, cambios de plan y operaciones.</p>
            </div>
            <button className="table-action-btn" onClick={loadActivity}>
              <RefreshCw size={12} className="inline mr-1" /> Actualizar Feed
            </button>
          </div>

          {activityLoading ? (
            <div className="flex items-center justify-center py-20 text-white font-semibold">
              <Loader2 size={24} className="spin mr-3" />
              <span>Cargando eventos de auditoría...</span>
            </div>
          ) : activityLogs.length === 0 ? (
            <div className="text-center py-16 bg-[#050505] border border-white/10 rounded-2xl p-8">
              <Activity size={32} className="text-white mx-auto mb-3 opacity-60" />
              <h3 className="text-sm font-bold text-white mb-1">No hay eventos recientes</h3>
              <p className="text-xs text-neutral-400">Los inicios de sesión y canjes aparecerán aquí en vivo.</p>
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Fecha & Hora</th>
                    <th>Acción</th>
                    <th>Entidad</th>
                    <th>Detalles</th>
                    <th>Dirección IP</th>
                  </tr>
                </thead>
                <tbody>
                  {activityLogs.map((log, idx) => (
                    <tr key={log.id || log._id || idx}>
                      <td className="font-mono text-xs text-neutral-400">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <span className="font-mono font-bold text-white text-xs">
                          {log.action}
                        </span>
                      </td>
                      <td>
                        <span className="text-xs text-neutral-300 font-mono">
                          {log.entity}
                        </span>
                      </td>
                      <td className="text-xs text-neutral-400 font-mono">
                        {log.details ? JSON.stringify(log.details) : '—'}
                      </td>
                      <td className="font-mono text-xs text-neutral-300">
                        {log.ip || '127.0.0.1'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'database' && (
        <div className="tab-database-container">
          <div className="database-maintenance-grid">
            <div className="maintenance-card">
              <div className="maintenance-icon">
                <Download size={22} />
              </div>
              <div className="maintenance-content">
                <h3 className="maintenance-title">Exportar datos (JSON)</h3>
                <p className="maintenance-desc">
                  Descarga usuarios, claves de licencia y perfiles para inspección. No es un backup completo ni restaurable: usa el backup cifrado del servidor para eso.
                </p>
                <button 
                  className="admin-btn-primary" 
                  onClick={handleExportBackup}
                  disabled={exporting}
                >
                  {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                  <span>{exporting ? 'Generando exportación...' : 'Descargar exportación (.JSON)'}</span>
                </button>
              </div>
            </div>

            <div className="maintenance-card">
              <div className="maintenance-icon amber">
                <HardDrive size={22} />
              </div>
              <div className="maintenance-content">
                <h3 className="maintenance-title">Optimizar & Purgar Sesiones</h3>
                <p className="maintenance-desc">
                  Elimina sesiones huérfanas detenidas de más de 30 días para liberar espacio y acelerar las consultas de la base de datos.
                </p>
                <button 
                  className="table-action-btn danger" 
                  onClick={handlePurgeSessions}
                  disabled={purging}
                  style={{ padding: '9px 18px', fontSize: '12px' }}
                >
                  {purging ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  <span>{purging ? 'Optimizando...' : 'Purgar Sesiones Inactivas'}</span>
                </button>
              </div>
            </div>
          </div>

          {maintenanceMsg && (
            <div className="maintenance-feedback-box">
              {maintenanceMsg}
            </div>
          )}
        </div>
      )}

      {createKeyModal && (
        <div className="pfm-overlay" onClick={() => !creatingKey && setCreateKeyModal(false)}>
          <div className="pfm-card" onClick={(e) => e.stopPropagation()}>
            <div className="pfm-header">
              <div className="flex items-center gap-2">
                <Key size={18} className="text-white" />
                <h3 className="pfm-title">Generar Claves de Activación</h3>
              </div>
              <button className="pfm-close" onClick={() => setCreateKeyModal(false)} disabled={creatingKey}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateKeys}>
              <div className="pfm-body">
                {keyError && (
                  <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
                    {keyError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <label className="pfm-field">
                    <span className="pfm-label">Plan a Asignar</span>
                    <select
                      className="pfm-select"
                      value={keyPlan}
                      onChange={(e) => setKeyPlan(e.target.value as any)}
                    >
                      <option value="shadow">Shadow (50 perfiles - $29)</option>
                      <option value="specter">Specter (200 perfiles - $79)</option>
                      <option value="phantom">Phantom Prime (Ilimitado - $199)</option>
                    </select>
                  </label>

                  <label className="pfm-field">
                    <span className="pfm-label">Duración</span>
                    <select
                      className="pfm-select"
                      value={keyDuration}
                      onChange={(e) => setKeyDuration(Number(e.target.value))}
                    >
                      <option value="30">30 Días (1 Mes)</option>
                      <option value="60">60 Días (2 Meses)</option>
                      <option value="90">90 Días (3 Meses)</option>
                      <option value="180">180 Días (6 Meses)</option>
                      <option value="365">365 Días (1 Año)</option>
                      <option value="-1">Permanente (Lifetime)</option>
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="pfm-field">
                    <span className="pfm-label">Rol Asignado</span>
                    <select
                      className="pfm-select"
                      value={keyRole}
                      onChange={(e) => setKeyRole(e.target.value as any)}
                    >
                      <option value="user">Cliente Estándar (Usuario)</option>
                      <option value="seller">Revendedor (Seller)</option>
                      <option value="admin">Administrador del Sistema</option>
                    </select>
                  </label>

                  <label className="pfm-field">
                    <span className="pfm-label">Cantidad de Claves</span>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      className="pfm-input font-mono"
                      value={keyCount}
                      onChange={(e) => setKeyCount(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                  </label>
                </div>

                <label className="pfm-field">
                  <span className="pfm-label">Etiqueta / Nota (Opcional)</span>
                  <input
                    type="text"
                    className="pfm-input"
                    value={keyTag}
                    onChange={(e) => setKeyTag(e.target.value)}
                    placeholder="Ej: Cliente @telegram_user #01"
                  />
                </label>
              </div>

              <div className="pfm-footer">
                <button type="button" className="pfm-btn cancel" onClick={() => setCreateKeyModal(false)} disabled={creatingKey}>
                  Cancelar
                </button>
                <button type="submit" className="pfm-btn confirm" disabled={creatingKey}>
                  {creatingKey ? 'Generando...' : `Generar ${keyCount} Clave(s)`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedUser && userModalAction && (
        <div className="pfm-overlay" onClick={() => !userActionSaving && setUserModalAction(null)}>
          <div className="pfm-card" onClick={(e) => e.stopPropagation()}>
            <div className="pfm-header">
              <h3 className="pfm-title">
                {userModalAction === 'plan' && `Cambiar Plan a ${selectedUser.name}`}
                {userModalAction === 'role' && `Asignar Rol a ${selectedUser.name}`}
                {userModalAction === 'password' && `Resetear Contraseña de ${selectedUser.name}`}
                {userModalAction === 'ban' && `${selectedUser.banned ? 'Desbanear' : 'Banear'} a ${selectedUser.name}`}
                {userModalAction === 'delete' && `Eliminar a ${selectedUser.name}`}
                {userModalAction === 'hwid' && `Desvincular HWID de ${selectedUser.name}`}
              </h3>
              <button className="pfm-close" onClick={() => setUserModalAction(null)} disabled={userActionSaving}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveUserAction}>
              <div className="pfm-body">
                {userModalAction === 'plan' && (
                  <label className="pfm-field">
                    <span className="pfm-label">Seleccionar Plan</span>
                    <select
                      className="pfm-select"
                      value={modalPlan}
                      onChange={(e) => setModalPlan(e.target.value)}
                    >
                      <option value="ghost">{PLANS.ghost.name} ({formatLimit(PLANS.ghost.limits.maxProfiles)} perfiles - Gratis)</option>
                      <option value="shadow">{PLANS.shadow.name} ({PLANS.shadow.limits.maxProfiles} perfiles - ${PLANS.shadow.price})</option>
                      <option value="specter">{PLANS.specter.name} ({PLANS.specter.limits.maxProfiles} perfiles - ${PLANS.specter.price})</option>
                      <option value="phantom">{PLANS.phantom.name} ({formatLimit(PLANS.phantom.limits.maxProfiles)} - ${PLANS.phantom.price})</option>
                    </select>
                  </label>
                )}

                {userModalAction === 'role' && (
                  <>
                    <label className="pfm-field">
                      <span className="pfm-label">Rol en el Sistema</span>
                      <select
                        className="pfm-select"
                        value={modalRole}
                        onChange={(e) => setModalRole(e.target.value as any)}
                      >
                        <option value="user">Usuario Cliente</option>
                        <option value="seller">Revendedor (Seller)</option>
                        <option value="admin">Administrador</option>
                        <option value="owner">Super Owner</option>
                      </select>
                    </label>

                    {modalRole === 'seller' && (
                      <label className="pfm-field">
                        <span className="pfm-label">Créditos de Generación de Claves</span>
                        <input
                          type="number"
                          min="0"
                          max="1000"
                          className="pfm-input font-mono"
                          value={modalCredits}
                          onChange={(e) => setModalCredits(parseInt(e.target.value) || 0)}
                        />
                      </label>
                    )}
                  </>
                )}

                {userModalAction === 'password' && (
                  <label className="pfm-field">
                    <span className="pfm-label">Nueva Contraseña</span>
                    <input
                      type="password"
                      className="pfm-input"
                      value={modalPassword}
                      onChange={(e) => setModalPassword(e.target.value)}
                      placeholder="Mínimo 6 caracteres"
                      autoFocus
                    />
                  </label>
                )}

                {userModalAction === 'ban' && (
                  <p className="text-xs text-slate-300">
                    ¿Estás seguro de que deseas {selectedUser.banned ? 'desbanear' : 'bloquear el acceso'} de <strong className="text-white">{selectedUser.name}</strong>?
                  </p>
                )}

                {userModalAction === 'delete' && (
                  <p className="text-xs text-slate-300">
                    Esto eliminará <strong className="text-white">permanentemente</strong> a{' '}
                    <strong className="text-white">{selectedUser.name}</strong> junto con sus sesiones y
                    las claves que haya creado. Esta acción no se puede deshacer.
                  </p>
                )}

                {userModalAction === 'hwid' && (
                  <p className="text-xs text-slate-300">
                    Esto desvinculará la firma de hardware (HWID) de <strong className="text-white">{selectedUser.name}</strong> y cerrará sus sesiones activas para permitirle ingresar en una nueva computadora.
                  </p>
                )}
              </div>

              <div className="pfm-footer">
                <button type="button" className="pfm-btn cancel" onClick={() => setUserModalAction(null)} disabled={userActionSaving}>
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  className={`pfm-btn ${(userModalAction === 'ban' && !selectedUser.banned) || userModalAction === 'delete' ? 'danger' : 'confirm'}`} 
                  disabled={userActionSaving}
                >
                  {userActionSaving ? 'Guardando...' : 'Confirmar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default UsersView;

import { useState, useEffect } from 'react';
import { User as UserIcon, Shield, Bell, Save, Check, RefreshCw, Loader2, DownloadCloud, Layers, HardDrive, Trash2, Globe, AlertTriangle } from 'lucide-react';
import { invoke, User as UserType } from '../../hooks/useAuth';
import { isTauri } from '../../services/tauriCore';
import { getBranding } from '../../config/branding';
import { effectivePlanName } from '../../domain/plans';
import { APP_VERSION } from '../../config/version';
import './SettingsView.css';

const appBrand = getBranding();

interface Props {
  user: UserType;
  onUpdateUser?: (user: UserType) => void;
  onOpenSetupWizard?: () => void;
}

export function SettingsView({ user, onUpdateUser, onOpenSetupWizard }: Props) {
  const [name, setName] = useState(user?.name || user?.username || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  // Local Preferences (persisted in localStorage)
  const [notifications, setNotifications] = useState(() => {
    return localStorage.getItem('krakenges_pref_notifications') !== 'false';
  });
  const [minimizeToTray, setMinimizeToTray] = useState(() => {
    return localStorage.getItem('krakenges_pref_minimize_tray') !== 'false';
  });
  const [startWithSystem, setStartWithSystem] = useState(() => {
    return localStorage.getItem('krakenges_pref_autostart') === 'true';
  });

  const toggleNotifications = () => {
    const val = !notifications;
    setNotifications(val);
    localStorage.setItem('krakenges_pref_notifications', String(val));
  };

  const toggleMinimizeToTray = () => {
    const val = !minimizeToTray;
    setMinimizeToTray(val);
    localStorage.setItem('krakenges_pref_minimize_tray', String(val));
  };

  const toggleStartWithSystem = () => {
    const val = !startWithSystem;
    setStartWithSystem(val);
    localStorage.setItem('krakenges_pref_autostart', String(val));
  };

  // Auto-Updater State
  const [currentVersion, setCurrentVersion] = useState(`v${APP_VERSION}`);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    available: boolean;
    version: string;
    notes: string;
    date: string;
  } | null>(null);
  const [updateMsg, setUpdateMsg] = useState('');

  // Storage / Cache Cleaning
  const [cleaningCache, setCleaningCache] = useState(false);
  const [cacheCleanedMsg, setCacheCleanedMsg] = useState('');

  const handleCleanCache = async () => {
    setCleaningCache(true);
    setCacheCleanedMsg('');
    try {
      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((k) => caches.delete(k)));
      }
      try {
        await invoke('server_purge_cache');
      } catch {}
      await new Promise((r) => setTimeout(r, 600));
      setCacheCleanedMsg('Caché y búferes huérfanos liberados con éxito. Sesiones y cookies intactas.');
      setTimeout(() => setCacheCleanedMsg(''), 4500);
    } catch (err: any) {
      alert(err?.message || 'Error al limpiar caché');
    } finally {
      setCleaningCache(false);
    }
  };

  // Dedicated Engine State
  const [engineInfo, setEngineInfo] = useState<{ is_dedicated: boolean; path: string | null; installed: boolean; version: string; platform: string } | null>(null);
  const [engineUpdate, setEngineUpdate] = useState<{ pinned_major: number; installed_major: number | null; latest_major: number | null; update_available: boolean; unknown: boolean } | null>(null);
  const [installingEngine, setInstallingEngine] = useState(false);
  const [engineMsg, setEngineMsg] = useState('');

  useEffect(() => {
    invoke('check_engine_status').then((info: any) => {
      setEngineInfo(info);
    }).catch(() => {});
    // Chrome publica un major cada 2 semanas: se consulta si el fijado sigue
    // siendo el estable actual. Es informativo, nunca bloquea el motor.
    invoke('check_engine_status').then((info: any) => {
      setEngineUpdate(info);
    }).catch(() => {});
  }, []);

  const handleInstallEngine = async () => {
    setInstallingEngine(true);
    setEngineMsg('');
    try {
      const res = await invoke('install_dedicated_engine');
      setEngineMsg(`✓ Motor instalado exitosamente en: ${res}`);
      const updated = await invoke('check_engine_status');
      setEngineInfo(updated);
      invoke('check_engine_status').then((info: any) => setEngineUpdate(info)).catch(() => {});
    } catch (e: any) {
      setEngineMsg(`Error: ${e?.message || e}`);
    } finally {
      setInstallingEngine(false);
    }
  };

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;

    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((version) => {
        if (!cancelled) setCurrentVersion(`v${version}`);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckUpdates = async () => {
    if (!isTauri) {
      setUpdateChecked(false);
      setUpdateInfo(null);
      setUpdateMsg('Las actualizaciones automáticas solo están disponibles en la app de escritorio.');
      return;
    }

    setCheckingUpdate(true);
    setUpdateChecked(false);
    setUpdateMsg('Consultando el canal oficial de actualizaciones...');
    setUpdateInfo(null);
    try {
      const res = await invoke<{
        available: boolean;
        version: string;
        notes: string;
        date: string;
      }>('check_app_update');

      if (res.available) {
        setUpdateInfo(res);
        setUpdateMsg(`Nueva versión v${res.version} disponible.`);
      } else {
        setUpdateMsg('No hay actualizaciones disponibles o no se pudo consultar el canal.');
      }
    } catch (e: any) {
      setUpdateMsg(e?.message || 'No se pudo consultar el actualizador.');
    } finally {
      setCheckingUpdate(false);
      setUpdateChecked(true);
    }
  };

  const handleStartDownload = async () => {
    setIsDownloading(true);
    setUpdateMsg('Descargando e instalando la actualización...');
    try {
      await invoke('install_app_update');
      setUpdateMsg('Actualización instalada. La aplicación se reiniciará.');
    } catch (e: any) {
      setUpdateMsg(`No se pudo instalar: ${e?.message || e}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSaveName = async () => {
    if (!name?.trim() || name === (user?.name || user?.username)) return;
    setSaving(true);
    try {
      const updated = await invoke<any>('server_update_profile', { name: name.trim() });
      onUpdateUser?.({ ...user, name: updated.name });
      setSavedMsg('Nombre actualizado correctamente');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (err: any) {
      alert(err.message || 'Error al actualizar el nombre');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword.length < 8) {
      alert('La nueva contraseña debe tener mínimo 8 caracteres');
      return;
    }
    if (newPassword !== confirmPassword) {
      alert('Las contraseñas no coinciden');
      return;
    }
    setSaving(true);
    try {
      await invoke('server_change_password', { currentPassword, newPassword });
      alert('Contraseña actualizada. Vuelve a iniciar sesión.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      alert(err.message || 'Error al cambiar contraseña');
    } finally {
      setSaving(false);
    }
  };

  const planLabel = effectivePlanName(user).toUpperCase();

  return (
    <div className="settings-view">
      {/* Header */}
      <div className="settings-header">
        <div className="settings-title-block">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="settings-badge">PREFERENCIAS</span>
            <span style={{ color: '#52525b', fontSize: '0.6875rem' }}>/</span>
            <span style={{ fontFamily: 'JetBrains Mono', fontSize: '0.6875rem', color: '#a1a1aa' }}>CUENTA & SISTEMA</span>
          </div>
          <h1 className="settings-title">Configuración</h1>
          <p className="settings-subtitle">Ajustes de cuenta, seguridad y preferencias generales de la aplicación.</p>
        </div>

        {savedMsg && (
          <div className="settings-saved-badge">
            <Check size={14} />
            <span>{savedMsg}</span>
          </div>
        )}
      </div>

      {/* Settings 2x2 Grid */}
      <div className="settings-grid">
        
        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title-group">
              <div className="settings-icon-box">
                <UserIcon size={18} />
              </div>
              <div>
                <h3 className="settings-card-h3">Mi Cuenta</h3>
                <p className="settings-card-desc">Información del perfil de usuario</p>
              </div>
            </div>
            <span className="settings-badge">{user.role ? user.role.toUpperCase() : 'USER'}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="settings-form-group">
              <label className="settings-form-label">Nombre Visible</label>
              <div className="settings-input-row">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="settings-text-input"
                  placeholder="Tu nombre de operador"
                />
                <button
                  type="button"
                  onClick={handleSaveName}
                  disabled={saving || !name?.trim() || name === (user?.name || user?.username)}
                  className="settings-btn-primary"
                  style={{ flexShrink: 0 }}
                >
                  <Save size={13} />
                  <span>Guardar</span>
                </button>
              </div>
            </div>

            <div className="settings-param-row">
              <span className="settings-param-label">Nombre de Usuario:</span>
              <span className="settings-param-val">@{user.username}</span>
            </div>

            <div className="settings-param-row">
              <span className="settings-param-label">Plan Activo:</span>
              <span className="settings-plan-pill">{planLabel} FLEET</span>
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title-group">
              <div className="settings-icon-box">
                <Shield size={18} />
              </div>
              <div>
                <h3 className="settings-card-h3">Seguridad & Contraseña</h3>
                <p className="settings-card-desc">Credenciales de acceso a la cuenta</p>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <div className="settings-form-group">
              <label className="settings-form-label">Contraseña Actual</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••••••"
                className="settings-text-input"
              />
            </div>

            <div className="settings-password-grid">
              <div className="settings-form-group">
                <label className="settings-form-label">Nueva Contraseña</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                  className="settings-text-input"
                />
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">Confirmar Contraseña</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repite la contraseña"
                  className="settings-text-input"
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.25rem' }}>
              <button
                type="button"
                onClick={handleChangePassword}
                disabled={saving || !currentPassword || !newPassword || newPassword.length < 8 || newPassword !== confirmPassword}
                className="settings-btn-primary"
              >
                <span>Actualizar Contraseña</span>
              </button>
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title-group">
              <div className="settings-icon-box">
                <Bell size={18} />
              </div>
              <div>
                <h3 className="settings-card-h3">Preferencias de la Aplicación</h3>
                <p className="settings-card-desc">Comportamiento del cliente local</p>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Opción 1: Notificaciones */}
            <div className="settings-pref-row">
              <div>
                <div className="settings-pref-title">Notificaciones del Sistema</div>
                <div className="settings-pref-desc">Avisos de fin de sesión o alertas de proxy</div>
              </div>
              <label className="settings-switch">
                <input type="checkbox" checked={notifications} onChange={toggleNotifications} />
                <span className="settings-switch-slider" />
              </label>
            </div>

            {/* Opción 2: Minimizar al cerrar */}
            <div className="settings-pref-row">
              <div>
                <div className="settings-pref-title">Minimizar a la Bandeja al Cerrar</div>
                <div className="settings-pref-desc">Mantiene los perfiles y navegadores en segundo plano</div>
              </div>
              <label className="settings-switch">
                <input type="checkbox" checked={minimizeToTray} onChange={toggleMinimizeToTray} />
                <span className="settings-switch-slider" />
              </label>
            </div>

            {/* Opción 3: Iniciar con el sistema */}
            <div className="settings-pref-row">
              <div>
                <div className="settings-pref-title">Iniciar con el Sistema Operativo</div>
                <div className="settings-pref-desc">Arrancar {appBrand.appName} automáticamente al encender el equipo</div>
              </div>
              <label className="settings-switch">
                <input type="checkbox" checked={startWithSystem} onChange={toggleStartWithSystem} />
                <span className="settings-switch-slider" />
              </label>
            </div>

            {/* Opción 4: Limpieza de Caché */}
            <div className="settings-pref-row settings-cache-row" style={{ paddingTop: '0.75rem', borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div>
                <div className="settings-pref-title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <HardDrive size={14} className="text-neutral-400" />
                  <span>Liberar Caché de Chromium</span>
                </div>
                <div className="settings-pref-desc">Elimina archivos temporales y búferes sin tocar cookies ni sesiones</div>
              </div>
              <button
                type="button"
                onClick={handleCleanCache}
                disabled={cleaningCache}
                className="settings-btn-primary"
                style={{ flexShrink: 0, padding: '0.4rem 0.75rem', height: 'auto', fontSize: '0.75rem' }}
                title="Limpiar archivos temporales"
              >
                {cleaningCache ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                <span>{cleaningCache ? 'Limpiando...' : 'Limpiar Caché'}</span>
              </button>
            </div>

            {cacheCleanedMsg && (
              <div style={{ padding: '0.45rem 0.65rem', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', fontSize: '0.6875rem', fontFamily: 'JetBrains Mono', color: '#ffffff' }}>
                ✓ {cacheCleanedMsg}
              </div>
            )}
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title-group">
              <div className="settings-icon-box">
                <Globe size={18} />
              </div>
              <div>
                <h3 className="settings-card-h3">Motor de Navegación Autónomo (Stealth Core)</h3>
                <p className="settings-card-desc">Chromium Standalone dedicado e independiente del navegador personal</p>
              </div>
            </div>
            {engineInfo?.is_dedicated && engineInfo.installed ? (
              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '4px', background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', fontWeight: 600 }}>
                Dedicado Integrado
              </span>
            ) : engineInfo?.is_dedicated ? (
              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '4px', background: 'rgba(234, 179, 8, 0.15)', color: '#facc15', fontWeight: 600 }}>
                Motor Sin Manifiesto
              </span>
            ) : (
              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '4px', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', fontWeight: 600 }}>
                No Instalado
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <p style={{ fontSize: '0.75rem', color: '#a1a1aa', lineHeight: 1.5 }}>
              {engineInfo?.is_dedicated && engineInfo.installed
                ? `${appBrand.appName} ejecuta su propio motor Chromium aislado (${engineInfo.version}) sin tocar ni depender de tus navegadores personales. La identidad y la firma de red salen de este mismo motor.`
                : `${appBrand.appName} necesita su motor Chromium propio para funcionar. No se usa tu navegador del sistema a propósito: si las versiones no coinciden, la huella se contradice y se detecta al instante.`}
            </p>

            {engineInfo?.path && (
              <div style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: '#71717a', background: 'rgba(255,255,255,0.03)', padding: '0.5rem', borderRadius: '6px', wordBreak: 'break-all' }}>
                Ruta activa: {engineInfo.path}
              </div>
            )}

            {engineUpdate?.update_available && (
              <div
                style={{
                  display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
                  padding: '0.6rem 0.7rem', borderRadius: '6px',
                  background: 'rgba(234, 179, 8, 0.10)',
                  border: '1px solid rgba(234, 179, 8, 0.30)',
                  fontSize: '0.72rem', color: '#facc15', lineHeight: 1.5,
                }}
              >
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  Google ya publica Chrome {engineUpdate.latest_major} y este build sigue fijado en
                  Chrome {engineUpdate.pinned_major}. El motor sigue siendo coherente consigo mismo
                  y los perfiles funcionan con normalidad, pero una versión antigua representa a menos
                  usuarios reales. Chrome publica un major cada dos semanas.
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={handleInstallEngine}
              disabled={installingEngine}
              className="settings-btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {installingEngine ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>Descargando e integrando motor Chromium stealth...</span>
                </>
              ) : (
                <>
                  <Globe size={13} />
                  <span>
                    {engineUpdate?.update_available
                      ? `Actualizar Motor a Chrome ${engineUpdate.latest_major}`
                      : engineInfo?.is_dedicated
                        ? 'Reinstalar / Actualizar Motor Dedicado'
                        : 'Descargar e Instalar Motor Dedicado (Chrome for Testing)'}
                  </span>
                </>
              )}
            </button>

            {engineMsg && (
              <div style={{ fontSize: '0.75rem', color: engineMsg.startsWith('✓') ? '#34d399' : '#f87171' }}>
                {engineMsg}
              </div>
            )}
          </div>
        </div>

        {onOpenSetupWizard && (
          <div className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-title-group">
                <div className="settings-icon-box">
                  <Shield size={18} />
                </div>
                <div>
                  <h3 className="settings-card-h3">Diagnóstico de Entorno & Requisitos</h3>
                  <p className="settings-card-desc">Auditoría en tiempo real de Chromium, sandboxing y cluster</p>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#a1a1aa', lineHeight: 1.5 }}>
                Verifica el estado del motor Chromium, permisos de almacenamiento y conectividad con el servidor.
              </p>

              <button
                type="button"
                onClick={onOpenSetupWizard}
                className="settings-btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                <RefreshCw size={13} />
                <span>Ejecutar Verificación de Entorno</span>
              </button>
            </div>
          </div>
        )}

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title-group">
              <div className="settings-icon-box">
                <RefreshCw size={18} />
              </div>
              <div>
                <h3 className="settings-card-h3">Actualizaciones del Sistema</h3>
                <p className="settings-card-desc">Canal oficial de distribución</p>
              </div>
            </div>
            <span className="settings-badge">{currentVersion}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="settings-param-row">
              <span className="settings-param-label">Versión Instalada:</span>
              <span className="settings-param-val">{currentVersion} (64-bit)</span>
            </div>

            <div className="settings-param-row">
              <span className="settings-param-label">Estado del Cliente:</span>
              <span className="settings-param-val" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#ffffff' }}></span>
                {checkingUpdate
                  ? 'Comprobando...'
                  : updateInfo
                    ? 'Nueva versión disponible'
                    : updateChecked
                      ? 'Sin actualizaciones detectadas'
                      : 'Sin comprobar'}
              </span>
            </div>

            {updateMsg && (
              <div style={{ padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', fontSize: '0.75rem', fontFamily: 'JetBrains Mono', color: '#d4d4d8' }}>
                {updateMsg}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', paddingTop: '0.25rem' }}>
              {updateInfo && !isDownloading ? (
                <button
                  type="button"
                  onClick={handleStartDownload}
                  className="settings-btn-primary"
                  style={{ width: '100%' }}
                >
                  <DownloadCloud size={14} />
                  <span>Descargar e Instalar Ahora</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCheckUpdates}
                  disabled={checkingUpdate || isDownloading}
                  className="settings-btn-primary"
                  style={{ width: '100%' }}
                >
                  {checkingUpdate || isDownloading ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  <span>
                    {checkingUpdate
                      ? 'Verificando...'
                      : isDownloading
                        ? 'Instalando...'
                        : 'Buscar Actualizaciones'}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

export default SettingsView;

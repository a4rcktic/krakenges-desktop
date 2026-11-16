import { useState, useEffect } from 'react';
import { 
  Eye, 
  EyeOff, 
  Lock, 
  User as UserIcon, 
  Loader2, 
  ArrowRight, 
  AlertCircle, 
  Sparkles, 
  Shield, 
  Laptop, 
  CheckCircle2, 
  KeyRound, 
  Key,
  ShieldCheck,
  Check,
  Fingerprint,
  Cpu,
  Monitor,
  HardDrive
} from 'lucide-react';
import { InteractiveBackground } from '../../components/Common/InteractiveBackground';
import { getBranding } from '../../config/branding';
import { usePublicContent } from '../../hooks/usePublicContent';
import { invoke } from '../../services/tauriBridge';
import './LoginDesktop.css';

const appBrand = getBranding();

interface HardwareInfo {
  cpu?: string | null;
  cores?: number | null;
  gpu?: string | null;
  platform?: string;
  distro?: string | null;
}

interface Props {
  onLogin: (username: string, password: string) => Promise<any>;
  onRegister?: (data: { name: string; username: string; password: string; key: string }) => Promise<any>;
}

export function LoginDesktop({ onLogin, onRegister }: Props) {
  const publicContent = usePublicContent();
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');

  // Login inputs
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [showLoginPass, setShowLoginPass] = useState(false);

  // Register inputs
  const [regUser, setRegUser] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regConfirmPass, setRegConfirmPass] = useState('');
  const [regLicense, setRegLicense] = useState('');
  const [showRegPass, setShowRegPass] = useState(false);
  const [showRegConfirmPass, setShowRegConfirmPass] = useState(false);

  // Common state
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  // Datos reales del equipo. Los valores iniciales son honestos: nunca se
  // muestra un hardware, una resolución o un hash inventado mientras se
  // detecta o si el sistema no puede exponerlos.
  const [envData, setEnvData] = useState({
    cpu: '—',
    gpu: 'Detectando…',
    cores: '—',
    screenRes: '—',
    os: '—',
    browser: '—',
    canvasHash: '—',
    colorDepth: '—',
  });
  const [envDetected, setEnvDetected] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const detectEnvironment = async () => {
      // La GPU se pide al sistema operativo (Rust). En Linux, WebKitGTK
      // devuelve "Apple GPU" incluso en equipos Intel porque su WebGL está
      // sandboxeado; por eso WebGL solo se usa como respaldo fuera de Linux.
      let hardware: HardwareInfo | null = null;
      try {
        hardware = await invoke<HardwareInfo>('get_hardware_info');
      } catch {
        hardware = null;
      }
      if (cancelled) return;

      let webglGpu = '';
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
          const debugInfo = (gl as any).getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            const rawGpu = (gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
            if (rawGpu) {
              webglGpu = rawGpu
                .replace(/ANGLE \((.*?)\)/, '$1')
                .replace(/Direct3D.*?,/, '')
                .replace(/\(R\)|\(TM\)/g, '')
                .trim();
            }
          }
        }
      } catch {
        webglGpu = '';
      }

      const ua = navigator.userAgent;
      const isLinux = /Linux/i.test(ua) || hardware?.platform === 'linux';
      let detectedOs = '—';
      if (/Android/i.test(ua)) detectedOs = 'Android';
      else if (/iPhone|iPad|iPod/i.test(ua)) detectedOs = 'iOS';
      else if (/Windows/i.test(ua)) detectedOs = 'Windows';
      else if (/Macintosh|Mac OS X/i.test(ua)) detectedOs = 'macOS';
      else if (isLinux) detectedOs = 'Linux';

      let detectedBrowser = '—';
      if (/Brave/i.test(ua)) detectedBrowser = 'Brave';
      else if (/Edg\//i.test(ua)) detectedBrowser = 'Edge';
      else if (/Firefox\//i.test(ua)) detectedBrowser = 'Firefox';
      else if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) detectedBrowser = 'Chromium';
      else if (/AppleWebKit\//i.test(ua)) {
        // En Linux, WebKitGTK se anuncia como Safari en la UA. En macOS la
        // app usa WKWebView; solo se llama Safari si la UA lo identifica.
        detectedBrowser = isLinux
          ? 'WebKitGTK'
          : /Version\/[\d.]+.*Safari\//i.test(ua)
            ? 'Safari'
            : 'WebKit';
      }

      // WebGL solo aporta un nombre fiable en sistemas que no son Linux.
      // En Linux se usa exclusivamente la GPU leída del sistema operativo.
      const gpu = hardware?.gpu?.trim()
        || (!isLinux ? webglGpu : '')
        || '—';

      const cores = hardware?.cores
        ? `${hardware.cores} Núcleos`
        : navigator.hardwareConcurrency
          ? `${navigator.hardwareConcurrency} Núcleos`
          : '—';

      const screenW = window.screen.width;
      const screenH = window.screen.height;

      // Hash real del canvas: si el canvas no está disponible se muestra "—",
      // nunca un valor de relleno.
      let detectedHash = '—';
      try {
        const c = document.createElement('canvas');
        c.width = 200;
        c.height = 50;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.textBaseline = 'top';
          ctx.font = '14px Arial';
          ctx.fillStyle = '#f60';
          ctx.fillRect(125, 1, 62, 20);
          ctx.fillStyle = '#069';
          ctx.fillText(`${appBrand.appName} Live`, 2, 15);
          const dataUri = c.toDataURL();
          let hash = 0;
          for (let i = 0; i < dataUri.length; i++) {
            hash = ((hash << 5) - hash) + dataUri.charCodeAt(i);
            hash |= 0;
          }
          detectedHash = '0x' + Math.abs(hash).toString(16).toUpperCase().padStart(6, '0').slice(0, 8);
        }
      } catch {
        detectedHash = '—';
      }

      if (cancelled) return;
      setEnvData({
        cpu: hardware?.cpu?.trim() || '—',
        gpu,
        cores,
        screenRes: screenW > 0 && screenH > 0 ? `${screenW} × ${screenH}` : '—',
        os: detectedOs,
        browser: detectedBrowser,
        canvasHash: detectedHash,
        colorDepth: window.screen.colorDepth ? `${window.screen.colorDepth}-bit` : '—',
      });
      setEnvDetected(true);
    };

    detectEnvironment();
    return () => {
      cancelled = true;
    };
  }, []);

  const triggerShake = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const hasMinLen = regPass.length >= 8;
  const hasUpper = /[A-Z]/.test(regPass);
  const hasNum = /[0-9]/.test(regPass);
  const passwordsMatch = regConfirmPass.length > 0 && regPass === regConfirmPass;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginUser.trim() || !loginPass) {
      triggerShake('Por favor completa todos los campos.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await onLogin(loginUser.trim(), loginPass);
    } catch (err: any) {
      console.error('LOGIN ERROR:', err);
      const msg = typeof err === 'string' 
        ? err 
        : (err?.message || err?.error || 'Usuario o contraseña incorrectos.');
      triggerShake(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regUser.trim() || !regPass || !regLicense.trim()) {
      triggerShake('Por favor completa todos los campos obligatorios.');
      return;
    }

    if (regPass !== regConfirmPass) {
      triggerShake('Las contraseñas no coinciden.');
      return;
    }

    if (regPass.length < 8) {
      triggerShake('La contraseña requiere al menos 8 caracteres.');
      return;
    }

    if (!onRegister) {
      triggerShake('Servicio de registro no disponible en este momento.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await onRegister({
        name: regUser.trim(),
        username: regUser.trim(),
        password: regPass,
        key: regLicense.trim().toUpperCase(),
      });
    } catch (err: any) {
      console.error('REGISTER ERROR:', err);
      const msg = typeof err === 'string' 
        ? err 
        : (err?.message || err?.error || 'Error al validar la licencia.');
      triggerShake(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="desk-auth-screen">
      {/* Louis Vuitton Monogram Eclipse Watermark Background */}
      <InteractiveBackground variant="desktop" />

      {/* Chamfered Diamond-Cut Specular Frame */}
      <div className={`desk-master-rim ${shake ? 'desk-shake' : ''}`}>
        <div className="desk-master-card">
          
          {/* ========================================================
              LEFT COLUMN: REAL HARDWARE & FINGERPRINT TELEMETRY
              ======================================================== */}
          <div className="desk-showcase-pane">
            
            {/* Top Brand Emblem */}
            <div className="desk-brand-header">
              <div className="desk-logo-halo-wrap">
                <div className="desk-logo-halo" />
                <div className="desk-logo-box">
                  <img 
                    src="/icon.png" 
                    alt={appBrand.appName}
                    className="desk-logo-img"
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = 'none';
                    }}
                  />
                  <div className="desk-logo-fallback">
                    <Shield size={24} />
                  </div>
                </div>
              </div>

              <div className="desk-brand-text">
                <span className="desk-brand-name">{appBrand.appName}</span>
                <span className="desk-brand-badge">STEALTH</span>
              </div>
            </div>

            {/* Core Value Proposition */}
            <div className="desk-hero-content">
              <h1 className="desk-hero-title">
                {publicContent.texts.loginTitle || 'Navegación sin rastro.'}<br />
                <span>{publicContent.texts.loginTitleHighlight || 'Privacidad de alto nivel.'}</span>
              </h1>
              <p className="desk-hero-desc">
                {publicContent.texts.loginSubtitle ||
                  'Aislamiento completo de hardware, cookies y perfiles para gestión multicuenta 100% segura.'}
              </p>
            </div>

            {/* LIVE REAL HARDWARE & FINGERPRINT TELEMETRY WIDGET */}
            <div className="desk-real-widget">
              <div className="desk-widget-top">
                <div className="desk-widget-title">
                  <Fingerprint size={15} className="text-emerald-400" />
                  <span>Huella Real de tu Equipo</span>
                </div>
                <div className="desk-live-pill">
                  <span className="desk-live-dot" />
                  <span>{envDetected ? 'DETECTADO' : 'DETECTANDO'}</span>
                </div>
              </div>

              {/* 2x2 Real Hardware Grid detected from user's machine */}
              <div className="desk-real-grid">
                <div className="desk-real-cell">
                  <div className="desk-cell-head">
                    <Cpu size={12} className="text-zinc-500" />
                    <span>PROCESADOR</span>
                  </div>
                  <span className="desk-cell-val" title={envData.cpu}>{envData.cores}</span>
                </div>

                <div className="desk-real-cell">
                  <div className="desk-cell-head">
                    <Monitor size={12} className="text-zinc-500" />
                    <span>RESOLUCIÓN</span>
                  </div>
                  <span className="desk-cell-val">{envData.screenRes}</span>
                </div>

                <div className="desk-real-cell desk-cell-span">
                  <div className="desk-cell-head">
                    <HardDrive size={12} className="text-zinc-500" />
                    <span>GPU / GRÁFICOS REALES</span>
                  </div>
                  <span className="desk-cell-val text-zinc-100 truncate" title={envData.gpu}>
                    {envData.gpu}
                  </span>
                </div>

                <div className="desk-real-cell">
                  <div className="desk-cell-head">
                    <Laptop size={12} className="text-zinc-500" />
                    <span>SISTEMA BASE</span>
                  </div>
                  <span className="desk-cell-val">{envData.os} • {envData.browser}</span>
                </div>

                <div className="desk-real-cell">
                  <div className="desk-cell-head">
                    <Shield size={12} className="text-zinc-500" />
                    <span>HASH CANVAS</span>
                  </div>
                  <span className="desk-cell-val text-emerald-400">{envData.canvasHash}</span>
                </div>
              </div>

              {/* Anti-Detect Status Banner */}
              <div className="desk-spoof-banner">
                <div className="desk-spoof-icon">
                  <ShieldCheck size={15} className="text-emerald-400" />
                </div>
                <div className="desk-spoof-info">
                  <strong>Listo para Enmascarar</strong>
                  <span>{appBrand.appName} aislará y suplantará estos parámetros por perfil.</span>
                </div>
              </div>
            </div>

            {/* Checkpoints */}
            <div className="desk-check-list">
              <div className="desk-check-item">
                <div className="desk-check-bullet">
                  <Check size={12} />
                </div>
                <span>Cero cruce de datos entre sesiones</span>
              </div>
              <div className="desk-check-item">
                <div className="desk-check-bullet">
                  <Check size={12} />
                </div>
                <span>Destrucción instantánea de huellas al cerrar</span>
              </div>
            </div>

          </div>

          {/* ========================================================
              RIGHT COLUMN: INTERACTIVE FORM CONSOLE
              ======================================================== */}
          <div className="desk-form-pane">
            
            {/* Top Magnetic Sliding Tab Switcher */}
            <div className="desk-tab-switcher">
              <div 
                className="desk-tab-slider" 
                style={{ transform: activeTab === 'login' ? 'translateX(0%)' : 'translateX(100%)' }} 
              />
              <button 
                type="button" 
                className={`desk-tab-trigger ${activeTab === 'login' ? 'active' : ''}`}
                onClick={() => { setActiveTab('login'); setError(''); }}
              >
                <KeyRound size={14} />
                <span>Iniciar Sesión</span>
              </button>
              <button 
                type="button" 
                className={`desk-tab-trigger ${activeTab === 'register' ? 'active' : ''}`}
                onClick={() => { setActiveTab('register'); setError(''); }}
              >
                <Sparkles size={14} />
                <span>Crear Cuenta</span>
              </button>
            </div>

            {/* Error Message Banner */}
            {error && (
              <div className="desk-error-banner">
                <AlertCircle size={15} className="flex-shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}

            {/* TAB 1: LOGIN FORM */}
            {activeTab === 'login' ? (
              <form key="login" onSubmit={handleLoginSubmit} className="desk-form-body desk-fade-in">
                <div className="desk-field">
                  <label className="desk-label">USUARIO O CORREO ELECTRÓNICO</label>
                  <div className="desk-input-box">
                    <UserIcon size={16} className="desk-input-icon" />
                    <input
                      type="text"
                      className="desk-input"
                      value={loginUser}
                      onChange={(e) => setLoginUser(e.target.value)}
                      placeholder="operador_principal"
                      required
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      autoFocus
                    />
                    {loginUser.trim().length > 2 && (
                      <CheckCircle2 size={16} className="desk-check-icon text-emerald-400" />
                    )}
                  </div>
                </div>

                <div className="desk-field">
                  <div className="desk-field-head">
                    <label className="desk-label">CONTRASEÑA DE ACCESO</label>
                    <button
                      type="button"
                      className="desk-forgot-link"
                      onClick={() => alert('Contacta a tu soporte para recuperar el acceso a tu cuenta.')}
                    >
                      ¿Olvidaste tu contraseña?
                    </button>
                  </div>
                  <div className="desk-input-box">
                    <Lock size={16} className="desk-input-icon" />
                    <input
                      type={showLoginPass ? 'text' : 'password'}
                      className="desk-input desk-pass-input"
                      value={loginPass}
                      onChange={(e) => setLoginPass(e.target.value)}
                      placeholder="••••••••••••"
                      required
                      autoComplete="current-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="desk-eye-action"
                      onClick={() => setShowLoginPass(!showLoginPass)}
                      tabIndex={-1}
                      aria-label="Mostrar u ocultar contraseña"
                    >
                      {showLoginPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !loginUser.trim() || !loginPass}
                  className="desk-submit-btn"
                >
                  <div className="desk-btn-shine" />
                  {loading ? (
                    <>
                      <Loader2 size={16} className="desk-spinner" />
                      <span>Verificando credenciales...</span>
                    </>
                  ) : (
                    <>
                      <span>Acceder a la Consola</span>
                      <ArrowRight size={16} className="desk-arrow-icon" />
                    </>
                  )}
                </button>
              </form>
            ) : (
              /* TAB 2: REGISTER FORM */
              <form key="register" onSubmit={handleRegisterSubmit} className="desk-form-body desk-fade-in">
                <div className="desk-field">
                  <label className="desk-label">NOMBRE DE USUARIO</label>
                  <div className="desk-input-box">
                    <UserIcon size={16} className="desk-input-icon" />
                    <input
                      type="text"
                      className="desk-input"
                      value={regUser}
                      onChange={(e) => setRegUser(e.target.value)}
                      placeholder="nombre_de_usuario"
                      required
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </div>
                </div>

                <div className="desk-field">
                  <label className="desk-label">CONTRASEÑA</label>
                  <div className="desk-input-box">
                    <Lock size={16} className="desk-input-icon" />
                    <input
                      type={showRegPass ? 'text' : 'password'}
                      className="desk-input desk-pass-input"
                      value={regPass}
                      onChange={(e) => setRegPass(e.target.value)}
                      placeholder="Mínimo 8 caracteres"
                      required
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="desk-eye-action"
                      onClick={() => setShowRegPass(!showRegPass)}
                      tabIndex={-1}
                    >
                      {showRegPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>

                  {/* Password Criteria Badges */}
                  {regPass.length > 0 && (
                    <div className="desk-checklist">
                      <span className={`desk-pill ${hasMinLen ? 'valid' : ''}`}>
                        <span className="desk-pill-dot" />
                        8+ caracteres
                      </span>
                      <span className={`desk-pill ${hasUpper ? 'valid' : ''}`}>
                        <span className="desk-pill-dot" />
                        Mayúscula
                      </span>
                      <span className={`desk-pill ${hasNum ? 'valid' : ''}`}>
                        <span className="desk-pill-dot" />
                        Número
                      </span>
                    </div>
                  )}
                </div>

                <div className="desk-field">
                  <label className="desk-label">CONFIRMAR CONTRASEÑA</label>
                  <div className="desk-input-box">
                    <Lock size={16} className="desk-input-icon" />
                    <input
                      type={showRegConfirmPass ? 'text' : 'password'}
                      className={`desk-input desk-pass-input ${regConfirmPass && !passwordsMatch ? 'desk-input-error' : ''}`}
                      value={regConfirmPass}
                      onChange={(e) => setRegConfirmPass(e.target.value)}
                      placeholder="Repite tu contraseña"
                      required
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="desk-eye-action"
                      onClick={() => setShowRegConfirmPass(!showRegConfirmPass)}
                      tabIndex={-1}
                    >
                      {showRegConfirmPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div className="desk-field">
                  <div className="desk-field-head">
                    <label className="desk-label">CÓDIGO DE LICENCIA</label>
                    <span className="desk-req-badge">REQUERIDO</span>
                  </div>
                  <div className="desk-input-box">
                    <Key size={16} className="desk-input-icon text-cyan-400" />
                    <input
                      type="text"
                      className="desk-input desk-key-style"
                      value={regLicense}
                      onChange={(e) => setRegLicense(e.target.value.toUpperCase())}
                      placeholder="MSK-XXXX-XXXX"
                      required
                      spellCheck={false}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !regUser.trim() || !regPass || !regLicense.trim() || !passwordsMatch}
                  className="desk-submit-btn"
                >
                  <div className="desk-btn-shine" />
                  {loading ? (
                    <>
                      <Loader2 size={16} className="desk-spinner" />
                      <span>Activando licencia...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={16} />
                      <span>Activar Licencia & Crear Cuenta</span>
                      <ArrowRight size={16} className="desk-arrow-icon" />
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Footer switcher note */}
            <div className="desk-card-footer">
              <span>
                {activeTab === 'login' ? '¿Aún no tienes una cuenta?' : '¿Ya cuentas con tu clave de acceso?'}
              </span>{' '}
              <button
                type="button"
                className="desk-footer-btn"
                onClick={() => {
                  setActiveTab(activeTab === 'login' ? 'register' : 'login');
                  setError('');
                }}
              >
                {activeTab === 'login' ? 'Activa tu clave aquí' : 'Inicia sesión'}
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginDesktop;
